// Git worktree isolation for parallel coding jobs. Every isolated coding job
// runs in its own detached worktree at a captured base revision, so concurrent
// workers never write the same mutable working tree. The Main Agent receives
// an auditable change candidate (bounded, redacted patch + name status) and
// decides accept / reject / revise from there.
//
// Discipline: NEVER touches the primary working tree with reset / stash /
// clean / checkout — the primary tree may stay dirty. All worktree mutation
// targets the allocated worktree dir only. Windows-safe: node:path only, no
// shell string building, execFile(args array), and clear errors when a file
// lock blocks cleanup.

import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { isSensitivePath, parseChanges, DIFF_LIMIT, GIT_TIMEOUT_MS } from './workspace-audit.mjs';

const execFileAsync = promisify(execFile);

export const NOT_GIT_REPOSITORY = 'NOT_GIT_REPOSITORY';
export const GIT_NOT_FOUND = 'GIT_NOT_FOUND';
export const GIT_TIMEOUT = 'GIT_TIMEOUT';
export const GIT_ERROR = 'GIT_ERROR';
export const WORKTREE_LOCKED = 'WORKTREE_LOCKED';
export const CANDIDATE_CAPTURE_FAILED = 'CANDIDATE_CAPTURE_FAILED';
export const MAX_PARALLEL_CAP = 16;
export const DEFAULT_MAX_PARALLEL = 3;
const WORKTREE_PREFIX = 'dsh-crew-';

async function defaultRunner(args, { cwd }) {
  try {
    const out = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
    return { code: 0, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  } catch (error) {
    const missing = error?.code === 'ENOENT' || /spawn git ENOENT/i.test(error?.message ?? '');
    if (!missing) return { code: error?.code ?? error?.status ?? 1, stdout: '', stderr: error?.stderr ?? error?.message ?? String(error) };
    return { code: -1, stdout: '', stderr: 'spawn git ENOENT' };
  }
}

async function runGit(runner, args, opts) {
  try {
    const r = await runner(args, opts);
    const stderr = r.stderr ?? '';
    if (/not a git repository/i.test(stderr)) return { ok: false, reason: NOT_GIT_REPOSITORY, error: stderr.trim() };
    if (r.code != null && r.code !== 0) return { ok: false, reason: r.code === -1 ? GIT_NOT_FOUND : GIT_ERROR, code: r.code, error: stderr.trim() || 'git exited non-zero' };
    return { ok: true, code: r.code, stdout: r.stdout ?? '', stderr };
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (err?.code === 'ETIMEDOUT' || /timed out|timeout/i.test(msg)) return { ok: false, reason: GIT_TIMEOUT, error: msg };
    if (/ENOENT|spawn git/i.test(msg)) return { ok: false, reason: GIT_NOT_FOUND, error: msg };
    return { ok: false, reason: NOT_GIT_REPOSITORY, error: msg };
  }
}

function worktreeName(jobId) {
  const safe = String(jobId ?? '').replace(/[^A-Za-z0-9._-]/g, '-') || 'job';
  return `${WORKTREE_PREFIX}${safe}-${randomBytes(4).toString('hex')}`;
}

export function defaultWorktreeRoot() {
  return join(tmpdir(), 'dsh-crew-worktrees');
}

/**
 * Resolve repository root + HEAD. Dirty detection is advisory: inability to
 * read `git status` must not turn an otherwise valid repository into a hard
 * isolation failure. `dirty=null` means unknown.
 */
export async function inspectRepository({ cwd, git, runner } = {}) {
  const run = git ?? runner ?? defaultRunner;
  if (!cwd) return { ok: false, reason: NOT_GIT_REPOSITORY, error: 'cwd required' };
  const [root, head, status] = await Promise.all([
    runGit(run, ['rev-parse', '--show-toplevel'], { cwd }),
    runGit(run, ['rev-parse', 'HEAD'], { cwd }),
    runGit(run, ['status', '--porcelain', '-uall'], { cwd }),
  ]);
  if (!root.ok) return { ok: false, reason: root.reason, error: root.error };
  if (!head.ok) return { ok: false, reason: head.reason, error: head.error };
  return {
    ok: true,
    repoRoot: resolve(root.stdout.trim()),
    baseRevision: head.stdout.trim(),
    headRevision: head.stdout.trim(),
    dirty: status.ok ? status.stdout.trim() !== '' : null,
  };
}

export async function createIsolatedWorkspace({ cwd, jobId, baseRevision, root = defaultWorktreeRoot(), git } = {}) {
  const run = git ?? defaultRunner;
  const repo = await inspectRepository({ cwd, git: run });
  if (!repo.ok) return { ok: false, reason: repo.reason, error: repo.error };
  const rev = baseRevision ?? repo.baseRevision;
  const dir = join(root, worktreeName(jobId ?? repo.baseRevision));
  const res = await runGit(run, ['worktree', 'add', '--detach', dir, rev], { cwd: repo.repoRoot });
  if (!res.ok) return { ok: false, reason: res.reason, error: res.error };
  return { ok: true, worktreePath: dir, baseRevision: rev, repoRoot: repo.repoRoot, name: basename(dir) };
}

function splitFirstTab(line) {
  const i = line.indexOf('\t');
  return i === -1 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)];
}

async function buildCandidatePatch(run, { cwd, base, nameStatus, untracked, limit }) {
  const tracked = [];
  const sensitive = new Set();
  for (const line of String(nameStatus ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [, rest] = splitFirstTab(trimmed);
    const involved = rest.split('\t').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
    if (involved.length === 0) continue;
    if (involved.some(isSensitivePath)) {
      for (const p of involved) sensitive.add(p);
    } else {
      for (const p of involved) if (!tracked.includes(p)) tracked.push(p);
    }
  }

  let out = '';
  const redacted = [];
  const incompleteReasons = [];
  if (tracked.length > 0) {
    const r = await runGit(run, ['diff', '--binary', base, '--', ...tracked], { cwd });
    if (!r.ok) return { failed: true, reason: r.reason, error: r.error };
    out += r.stdout;
  }
  for (const p of sensitive) {
    redacted.push(p);
    out += `[REDACTED SENSITIVE FILE: ${p}]\n`;
  }
  if (redacted.length > 0) incompleteReasons.push('sensitive_content_redacted');

  for (const p of untracked) {
    if (isSensitivePath(p)) {
      redacted.push(p);
      out += `[REDACTED SENSITIVE FILE: ${p} (untracked)]\n`;
      if (!incompleteReasons.includes('sensitive_content_redacted')) incompleteReasons.push('sensitive_content_redacted');
      continue;
    }
    const abs = join(cwd, ...p.split('/'));
    if (!existsSync(abs)) {
      out += `[UNTRACKED FILE: ${p}]\n`;
      incompleteReasons.push(`untracked_missing:${p}`);
      continue;
    }
    const next = await safeNewFilePatch(p, abs);
    out += next.patch;
    if (!next.complete) incompleteReasons.push(next.reason ?? `untracked_unreplayable:${p}`);
  }

  const truncated = Buffer.byteLength(out, 'utf8') > limit;
  if (truncated) {
    out = Buffer.from(out, 'utf8').subarray(0, limit).toString('utf8');
    incompleteReasons.push('patch_truncated');
  }
  const complete = incompleteReasons.length === 0;
  return { failed: false, patch: out, truncated, redacted, complete, incompleteReasons };
}

async function safeNewFilePatch(relPath, absPath) {
  try {
    const buf = await readFile(absPath);
    if (buf.includes(0)) return { patch: `[NEW BINARY FILE: ${relPath} (${buf.length} bytes)]\n`, complete: false, reason: `binary_untracked:${relPath}` };
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) return { patch: `[NEW EMPTY FILE: ${relPath}]\n`, complete: true };
    const body = lines.map((l) => `+${l}`).join('\n');
    return {
      patch: `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`,
      complete: true,
    };
  } catch {
    return { patch: `[UNTRACKED FILE: ${relPath}]\n`, complete: false, reason: `untracked_read_failed:${relPath}` };
  }
}

function candidateFingerprint({ base, nameStatus, patch }) {
  return createHash('sha256').update(`${base}\n${nameStatus ?? ''}\n${patch ?? ''}`).digest('hex');
}

export async function captureCandidate({ worktreePath, baseRevision, git, limit = DIFF_LIMIT } = {}) {
  const run = git ?? defaultRunner;
  if (!worktreePath || !existsSync(worktreePath)) return { ok: false, reason: NOT_GIT_REPOSITORY, error: 'worktree path missing' };
  const baseCheck = baseRevision ? await runGit(run, ['rev-parse', '--verify', `${baseRevision}^{commit}`], { cwd: worktreePath }) : { ok: true };
  if (baseRevision && !baseCheck.ok) return { ok: false, reason: CANDIDATE_CAPTURE_FAILED, error: `invalid base revision ${baseRevision}: ${(baseCheck.error ?? '').trim()}` };
  const base = baseRevision ?? (await runGit(run, ['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim();

  const [nameStatus, statRel, status, head] = await Promise.all([
    runGit(run, ['diff', '--name-status', base], { cwd: worktreePath }),
    runGit(run, ['diff', '--stat', base], { cwd: worktreePath }),
    runGit(run, ['status', '--porcelain', '-uall'], { cwd: worktreePath }),
    runGit(run, ['rev-parse', 'HEAD'], { cwd: worktreePath }),
  ]);
  for (const r of [nameStatus, statRel, status]) if (!r.ok) return { ok: false, reason: r.reason, error: r.error };

  const changes = parseChanges(nameStatus.stdout, status.stdout);
  const untracked = changes.untracked;
  const built = await buildCandidatePatch(run, { cwd: worktreePath, base, nameStatus: nameStatus.stdout, untracked, limit });
  if (built.failed) return { ok: false, reason: built.reason ?? CANDIDATE_CAPTURE_FAILED, error: built.error };

  const nameStatusOut = nameStatus.stdout;
  return {
    ok: true,
    kind: 'git-worktree',
    base_revision: base,
    committed_head: head.ok ? head.stdout.trim() : null,
    worktree_path: worktreePath,
    changed_files: [...new Set([...trackedIn(nameStatusOut, untracked), ...built.redacted, ...untracked])],
    name_status: nameStatusOut,
    diff_stat: statRel.stdout,
    patch: built.patch,
    patch_truncated: built.truncated,
    sensitive_paths_redacted: built.redacted,
    untracked_files: untracked,
    complete: built.complete,
    replayable: built.complete,
    incomplete_reasons: built.incompleteReasons,
    fingerprint: candidateFingerprint({ base, nameStatus: nameStatusOut, patch: built.patch }),
    candidate_commit: null,
  };
}

function trackedIn(nameStatus, untracked) {
  const out = [];
  for (const line of String(nameStatus ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [, rest] = splitFirstTab(trimmed);
    const involved = rest.split('\t').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
    for (const p of involved) if (!out.includes(p) && !untracked.includes(p)) out.push(p);
  }
  return out;
}

async function mainRepoRoot(run, worktreePath) {
  const common = await runGit(run, ['rev-parse', '--git-common-dir'], { cwd: worktreePath });
  if (!common.ok) return null;
  const dir = String(common.stdout ?? '').trim();
  if (!dir) return null;
  return resolve(dir, '..');
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const pathIdentity = (value) => {
  const resolved = resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

async function worktreeRegistered({ worktreePath, git, cwd }) {
  const res = await runGit(git, ['worktree', 'list', '--porcelain'], { cwd });
  if (!res.ok) return null;
  const target = pathIdentity(worktreePath);
  for (const block of String(res.stdout).split('\n\n')) {
    const path = block.split('\n').find((line) => line.startsWith('worktree '))?.slice('worktree '.length)?.trim();
    if (path && pathIdentity(path) === target) return true;
  }
  return false;
}

/**
 * Bounded, truthful cleanup of a Crew-owned disposable worktree. Transient
 * Windows locks (index lock, AV scan, lingering handle) are retried with a
 * small backoff; a persistent failure surfaces `cleanupBlocked: true` with the
 * real reason and is never reported as removed. The filesystem fallback only
 * runs for Crew-owned worktree paths and claims success only after it verifies
 * the registration is gone and no directory remains — success is never claimed
 * while a worktree stays registered or on disk.
 */
export const WORKTREE_CLEANUP_RETRIES = 3;
export const WORKTREE_CLEANUP_BACKOFF_MS = 150;

export async function cleanupIsolatedWorkspace({
  worktreePath,
  repoRoot,
  git,
  retries = WORKTREE_CLEANUP_RETRIES,
  backoffMs = WORKTREE_CLEANUP_BACKOFF_MS,
} = {}) {
  const run = git ?? defaultRunner;
  if (!worktreePath) return { ok: false, reason: NOT_GIT_REPOSITORY, error: 'worktree path required' };
  const root = repoRoot ?? (await mainRepoRoot(run, worktreePath));
  const owned = basename(resolve(worktreePath)).startsWith(WORKTREE_PREFIX);

  if (root) {
    // Preferred path: `git worktree remove --force` (removes registration and
    // directory atomically). Retry bounded times to recover transient locks.
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const res = await runGit(run, ['worktree', 'remove', '--force', worktreePath], { cwd: root });
      if (res.ok) return { ok: true, removed: true, actions: [`removed worktree ${worktreePath}`] };
      if (attempt < retries - 1) await sleep(backoffMs);
    }
  }

  // Last resort, only for Crew-owned disposable paths: remove the directory and
  // verify the git registration actually went away before claiming success.
  if (owned && root && pathIdentity(worktreePath) !== pathIdentity(root)) {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, reason: WORKTREE_LOCKED, error: `worktree cleanup failed: ${err?.message ?? String(err)}`, cleanupBlocked: true };
    }
    const registered = root ? await worktreeRegistered({ worktreePath, git: run, cwd: root }) : null;
    if (registered === false && !existsSync(worktreePath)) {
      return { ok: true, removed: true, actions: [`cleaned worktree files ${worktreePath}`] };
    }
    if (registered === true) {
      return { ok: false, reason: WORKTREE_LOCKED, error: `worktree still registered after cleanup: ${worktreePath}`, cleanupBlocked: true };
    }
    return { ok: false, reason: WORKTREE_LOCKED, error: `could not verify worktree removal for ${worktreePath}`, cleanupBlocked: true };
  }

  return { ok: false, reason: WORKTREE_LOCKED, error: `worktree cleanup failed while ${worktreePath} remains (${root ? 'not a Crew-owned disposable path' : 'main repository root unresolvable'})`, cleanupBlocked: true };
}

export async function staleWorktrees({ git, allowed = [] } = {}) {
  const run = git ?? defaultRunner;
  const set = new Set(allowed.map((p) => resolve(p)));
  const stale = [];
  try {
    const root = await inspectRepository({ cwd: allowed[0] ?? process.cwd(), git: run });
    if (root.ok) {
      const res = await runGit(run, ['worktree', 'list', '--porcelain'], { cwd: root.repoRoot });
      if (res.ok) {
        for (const block of String(res.stdout).split('\n\n')) {
          const path = block.split('\n').find((l) => l.startsWith('worktree '))?.slice('worktree '.length)?.trim();
          if (!path) continue;
          const abs = resolve(path);
          if (basename(abs).startsWith(WORKTREE_PREFIX) && !set.has(abs)) stale.push(abs);
        }
      }
    }
  } catch {}
  return stale;
}

export async function pruneWorktrees({ git, allowed = [] } = {}) {
  const run = git ?? defaultRunner;
  const stale = await staleWorktrees({ git: run, allowed });
  const actions = [];
  for (const w of stale) {
    const r = await cleanupIsolatedWorkspace({ worktreePath: w, git: run });
    actions.push(...(r.actions ?? [r.error ?? `stale worktree ${w}`]));
  }
  return { ok: true, removed: stale.length, actions };
}

export function clampMaxParallel(raw) {
  const n = Number.isInteger(raw) ? raw : DEFAULT_MAX_PARALLEL;
  if (n < 1) return 1;
  if (n > MAX_PARALLEL_CAP) return MAX_PARALLEL_CAP;
  return n;
}

export function concurrencyGate({ maxParallel = DEFAULT_MAX_PARALLEL, active = 0 } = {}) {
  const cap = clampMaxParallel(maxParallel);
  const ok = active < cap;
  return { ok, active, maxParallel: cap, blocked: !ok };
}
