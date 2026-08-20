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
//
// Like workspace-audit, every function takes an injectable `git` runner
// ((argsArray, { cwd }) => { code, stdout, stderr }) so the git command logic
// is unit-testable without a real repository; the default runner is execFile.

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
    if (!missing) {
      // git writes diagnostics on stderr and exits non-zero; surface both.
      return { code: error?.code ?? error?.status ?? 1, stdout: '', stderr: error?.stderr ?? error?.message ?? String(error) };
    }
    return { code: -1, stdout: '', stderr: `spawn git ENOENT` };
  }
}

async function runGit(runner, args, opts) {
  try {
    const r = await runner(args, opts);
    const stderr = r.stderr ?? '';
    if (/not a git repository/i.test(stderr)) return { ok: false, reason: NOT_GIT_REPOSITORY, error: stderr.trim() };
    // A non-zero exit is a git failure (worktree add/remove refused, bad rev,
    // etc.) — never silently treated as success.
    if (r.code != null && r.code !== 0) {
      return { ok: false, reason: r.code === -1 ? GIT_NOT_FOUND : GIT_ERROR, code: r.code, error: stderr.trim() || 'git exited non-zero' };
    }
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

/** Where isolated worktrees live: a disposable dir under the OS temp root. */
export function defaultWorktreeRoot() {
  return join(tmpdir(), 'dsh-crew-worktrees');
}

/**
 * Resolve the repository root + base revision for a cwd. Returns
 * { ok, repoRoot, baseRevision } or { ok:false, reason } — never throws.
 */
export async function inspectRepository({ cwd, git, runner } = {}) {
  const run = git ?? runner ?? defaultRunner;
  if (!cwd) return { ok: false, reason: NOT_GIT_REPOSITORY, error: 'cwd required' };
  const [root, head] = await Promise.all([
    runGit(run, ['rev-parse', '--show-toplevel'], { cwd }),
    runGit(run, ['rev-parse', 'HEAD'], { cwd }),
  ]);
  if (!root.ok) return { ok: false, reason: root.reason, error: root.error };
  if (!head.ok) return { ok: false, reason: head.reason, error: head.error };
  return {
    ok: true,
    repoRoot: resolve(root.stdout.trim()),
    baseRevision: head.stdout.trim(),
    headRevision: head.stdout.trim(),
  };
}

/**
 * Allocate + create a detached git worktree at `baseRevision`. The worktree
 * dir is unique per job and lives under `root` (default a temp dir). Returns
 * { ok, worktreePath, baseRevision, repoRoot, name }.
 */
export async function createIsolatedWorkspace({ cwd, jobId, baseRevision, root = defaultWorktreeRoot(), git } = {}) {
  const run = git ?? defaultRunner;
  const repo = await inspectRepository({ cwd, git: run });
  if (!repo.ok) return { ok: false, reason: repo.reason, error: repo.error };
  const rev = baseRevision ?? repo.baseRevision;
  const dir = join(root, worktreeName(jobId ?? repo.baseRevision));
  const res = await runGit(run, ['worktree', 'add', '--detach', dir, rev], { cwd: repo.repoRoot });
  if (!res.ok) return { ok: false, reason: res.reason, error: res.error };
  // The worker must start clean at the base; a fresh worktree already is.
  return {
    ok: true,
    worktreePath: dir,
    baseRevision: rev,
    repoRoot: repo.repoRoot,
    name: basename(dir),
  };
}

function splitFirstTab(line) {
  const i = line.indexOf('\t');
  return i === -1 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)];
}

/**
 * Build the sanitized candidate patch. Security discipline:
 *   1. The full git diff is NEVER assembled up front — only a PATH-SCOPED
 *      `git diff <base> -- <non-sensitive paths>` is ever run, so sensitive
 *      tracked content never enters the patch buffer.
 *   2. Rename/copy hunks are excluded entirely when EITHER the source or the
 *      destination path is sensitive.
 *   3. Sensitive files (tracked, deleted, renamed, untracked) appear only as a
 *      `[REDACTED SENSITIVE FILE]` marker — the content is never read.
 *   4. Non-sensitive untracked files get a real new-file patch (read via
 *      Node fs, so no shell /dev/null dependency; text lines are bounded and a
 *      binary file degrades to a size marker).
 *   5. Truncation runs LAST, over the already-sanitized patch, so a size limit
 *      can never split a secret into view.
 */
async function buildCandidatePatch(run, { cwd, base, nameStatus, status, untracked, limit }) {
  const tracked = [];
  const sensitive = new Set();
  for (const line of String(nameStatus ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [, rest] = splitFirstTab(trimmed);
    const involved = rest.split('\t').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
    if (involved.length === 0) continue;
    // Rename/copy: if either side is sensitive, redact the whole entry.
    if (involved.some(isSensitivePath)) {
      for (const p of involved) sensitive.add(p);
    } else {
      for (const p of involved) if (!tracked.includes(p)) tracked.push(p);
    }
  }

  let out = '';
  const redacted = [];
  if (tracked.length > 0) {
    const r = await runGit(run, ['diff', '--binary', base, '--', ...tracked], { cwd });
    if (!r.ok) return { failed: true, reason: r.reason, error: r.error };
    out += r.stdout;
  }
  for (const p of sensitive) {
    redacted.push(p);
    out += `[REDACTED SENSITIVE FILE: ${p}]\n`;
  }
  for (const p of untracked) {
    if (isSensitivePath(p)) {
      redacted.push(p);
      out += `[REDACTED SENSITIVE FILE: ${p} (untracked)]\n`;
      continue;
    }
    const abs = join(cwd, ...p.split('/'));
    if (existsSync(abs)) out += await safeNewFilePatch(p, abs);
    else out += `[UNTRACKED FILE: ${p}]\n`;
  }

  const truncated = Buffer.byteLength(out, 'utf8') > limit;
  if (truncated) out = Buffer.from(out, 'utf8').subarray(0, limit).toString('utf8');
  return { failed: false, patch: out, truncated, redacted };
}

/** Real new-file patch for a non-sensitive untracked file (text or binary). */
async function safeNewFilePatch(relPath, absPath) {
  try {
    const buf = await readFile(absPath);
    if (buf.includes(0)) return `[NEW BINARY FILE: ${relPath} (${buf.length} bytes)]\n`;
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) return `[NEW EMPTY FILE: ${relPath}]\n`;
    const body = lines.map((l) => `+${l}`).join('\n');
    return `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
  } catch {
    return `[UNTRACKED FILE: ${relPath}]\n`;
  }
}

function candidateFingerprint({ base, nameStatus, patch }) {
  return createHash('sha256')
    .update(`${base}\n${nameStatus ?? ''}\n${patch ?? ''}`)
    .digest('hex');
}

/**
 * Capture an auditable change candidate from an isolated worktree. The diff
 * scope is ALWAYS the supplied `baseRevision` — never `HEAD` — so committed
 * worker changes (base..HEAD) AND uncommitted working-tree edits on top are
 * both captured, and invalid bases fail explicitly. The patch is built
 * path-scoped (sensitive tracked content never enters the buffer), non-
 * sensitive new files are included as real patches, and the whole candidate
 * is fingerprinted over the sanitized patch. Never touches the primary tree.
 */
export async function captureCandidate({ worktreePath, baseRevision, git, limit = DIFF_LIMIT } = {}) {
  const run = git ?? defaultRunner;
  if (!worktreePath || !existsSync(worktreePath)) {
    return { ok: false, reason: NOT_GIT_REPOSITORY, error: 'worktree path missing' };
  }
  // Invalid base revisions must fail loudly, not silently diff the wrong thing.
  const baseCheck = baseRevision
    ? await runGit(run, ['rev-parse', '--verify', `${baseRevision}^{commit}`], { cwd: worktreePath })
    : { ok: true };
  if (baseRevision && !baseCheck.ok) {
    return { ok: false, reason: CANDIDATE_CAPTURE_FAILED, error: `invalid base revision ${baseRevision}: ${(baseCheck.error ?? '').trim()}` };
  }
  const base = baseRevision ?? (await runGit(run, ['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim();

  const [nameStatus, statRel, status, head] = await Promise.all([
    runGit(run, ['diff', '--name-status', base], { cwd: worktreePath }),
    runGit(run, ['diff', '--stat', base], { cwd: worktreePath }),
    // -uall expands untracked directories into their individual files so the
    // candidate lists real paths (and can include their content) instead of a
    // bare directory marker.
    runGit(run, ['status', '--porcelain', '-uall'], { cwd: worktreePath }),
    runGit(run, ['rev-parse', 'HEAD'], { cwd: worktreePath }),
  ]);
  for (const r of [nameStatus, statRel, status]) if (!r.ok) return { ok: false, reason: r.reason, error: r.error };

  const changes = parseChanges(nameStatus.stdout, status.stdout);
  const untracked = changes.untracked;
  const { failed, patch, truncated, redacted } = await buildCandidatePatch(run, {
    cwd: worktreePath,
    base,
    nameStatus: nameStatus.stdout,
    status: status.stdout,
    untracked,
    limit,
  });
  if (failed) return { ok: false, reason: failed.reason ?? CANDIDATE_CAPTURE_FAILED, error: failed.error };

  const nameStatusOut = nameStatus.stdout;
  return {
    ok: true,
    kind: 'git-worktree',
    base_revision: base,
    committed_head: head.ok ? head.stdout.trim() : null,
    worktree_path: worktreePath,
    // Tracked changes (from name-status) + redacted sensitive entries + the
    // untracked file list — every path the worker touched, committed or not.
    changed_files: [...new Set([...trackedIn(nameStatusOut, untracked), ...redacted, ...untracked])],
    name_status: nameStatusOut,
    diff_stat: statRel.stdout,
    patch,
    patch_truncated: truncated,
    sensitive_paths_redacted: redacted,
    untracked_files: untracked,
    fingerprint: candidateFingerprint({ base, nameStatus: nameStatusOut, patch }),
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

/** Resolve the MAIN repository root from inside a linked worktree. */
async function mainRepoRoot(run, worktreePath) {
  const common = await runGit(run, ['rev-parse', '--git-common-dir'], { cwd: worktreePath });
  if (!common.ok) return null;
  const dir = String(common.stdout ?? '').trim();
  if (!dir) return null;
  return resolve(dir, '..');
}

/**
 * Remove an isolated worktree. Regression-safe: reports a clear error when a
 * OS file lock blocks removal (Windows) instead of silently leaving it behind.
 * Runs `git worktree remove` from the MAIN repository (a worktree cannot
 * remove itself from inside).
 */
export async function cleanupIsolatedWorkspace({ worktreePath, repoRoot, git } = {}) {
  const run = git ?? defaultRunner;
  if (!worktreePath) return { ok: false, reason: NOT_GIT_REPOSITORY, error: 'worktree path required' };
  const root = repoRoot ?? (await mainRepoRoot(run, worktreePath));
  if (root) {
    const res = await runGit(run, ['worktree', 'remove', '--force', worktreePath], { cwd: root });
    if (res.ok) {
      return { ok: true, removed: true, actions: [`removed worktree ${worktreePath}`] };
    }
    if (/modified or untracked files|Unable to delete|permission denied|locked|not allow/i.test(res.error)) {
      // A file is locked or git refuses to drop the changes (Windows). Surface
      // it clearly rather than pretending the cleanup succeeded.
      return { ok: false, reason: WORKTREE_LOCKED, error: res.error, cleanupBlocked: true };
    }
    if (/not a git repository|not (?:in )?a worktree/i.test(res.error)) {
      return { ok: false, reason: NOT_GIT_REPOSITORY, error: res.error };
    }
  }
  // Best-effort local removal only when git did not report a lock: the dir is
  // ours (temp-root owned) and _not_ a live (locked) worktree.
  try { rmSync(worktreePath, { recursive: true, force: true }); return { ok: true, removed: true, actions: [`rm -rf ${worktreePath}`] }; }
  catch (err) { return { ok: false, reason: WORKTREE_LOCKED, error: String(err?.message ?? err), cleanupBlocked: true }; }
}

/**
 * List stale dsh-crew worktrees (registered with git and/or present under
 * `root`) that are no longer in the allowed set. Returns their absolute paths.
 */
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

/** Prune stale dsh-crew worktrees (git worktree remove --force per entry). */
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

// ---------- concurrency clamp ----------

export function clampMaxParallel(raw) {
  const n = Number.isInteger(raw) ? raw : DEFAULT_MAX_PARALLEL;
  if (n < 1) return 1;
  if (n > MAX_PARALLEL_CAP) return MAX_PARALLEL_CAP;
  return n;
}

/**
 * Pure gate: may this job start given the runtime's active count? Returns
 * { ok, active, maxParallel } — the runtime clamps its own spawn loop.
 */
export function concurrencyGate({ maxParallel = DEFAULT_MAX_PARALLEL, active = 0 } = {}) {
  const cap = clampMaxParallel(maxParallel);
  const ok = active < cap;
  return { ok, active, maxParallel: cap, blocked: !ok };
}
