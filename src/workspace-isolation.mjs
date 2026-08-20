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
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { isSensitivePath, parseChanges, DIFF_LIMIT, GIT_TIMEOUT_MS } from './workspace-audit.mjs';

const execFileAsync = promisify(execFile);

export const NOT_GIT_REPOSITORY = 'NOT_GIT_REPOSITORY';
export const GIT_NOT_FOUND = 'GIT_NOT_FOUND';
export const GIT_TIMEOUT = 'GIT_TIMEOUT';
export const GIT_ERROR = 'GIT_ERROR';
export const WORKTREE_LOCKED = 'WORKTREE_LOCKED';
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

/**
 * Capture an auditable change candidate from an isolated worktree: name
 * status, diff stat, and the bounded + redacted patch of the worker's changes
 * relative to the base revision. Never touches the primary working tree.
 */
export async function captureCandidate({ worktreePath, baseRevision, git, limit = DIFF_LIMIT } = {}) {
  const run = git ?? defaultRunner;
  if (!worktreePath || !existsSync(worktreePath)) {
    return { ok: false, reason: NOT_GIT_REPOSITORY, error: 'worktree path missing' };
  }
  const [status, nameStatus, statRel, patchRel] = await Promise.all([
    runGit(run, ['status', '--porcelain'], { cwd: worktreePath }),
    runGit(run, ['diff', '--name-status', 'HEAD'], { cwd: worktreePath }),
    runGit(run, ['diff', '--stat', 'HEAD'], { cwd: worktreePath }),
    runGit(run, ['diff', '--binary', 'HEAD'], { cwd: worktreePath }),
  ]);
  for (const r of [status, nameStatus, statRel, patchRel]) if (!r.ok) return { ok: false, reason: r.reason, error: r.error };
  const changes = parseChanges(nameStatus.stdout, status.stdout);
  const { patch, truncated, redacted } = await buildCandidatePatch(run, { changes, patch: patchRel.stdout, limit });
  return {
    ok: true,
    kind: 'git-worktree',
    base_revision: baseRevision ?? null,
    worktree_path: worktreePath,
    changed_files: changes.modified.concat(changes.deleted).concat(changes.renamed).concat(changes.untracked),
    name_status: nameStatus.stdout,
    diff_stat: statRel.stdout,
    patch,
    patch_truncated: truncated,
    sensitive_paths_redacted: redacted,
    candidate_commit: null,
  };
}

async function buildCandidatePatch(run, { changes, patch, limit }) {
  let out = String(patch ?? '');
  const redacted = changes.modified.concat(changes.deleted).concat(changes.untracked).filter((p) => isSensitivePath(p));
  for (const p of redacted) out += `[REDACTED SENSITIVE FILE: ${p}]\n`;
  for (const p of changes.untracked) {
    if (!isSensitivePath(p)) out += `[UNTRACKED FILE: ${p} (content not diffed read-only)]\n`;
  }
  const truncated = Buffer.byteLength(out, 'utf8') > limit;
  if (truncated) out = Buffer.from(out, 'utf8').subarray(0, limit).toString('utf8');
  return { patch: out, truncated, redacted };
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
