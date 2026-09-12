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
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
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
export const WORKTREE_RESERVE_FAILED = 'WORKTREE_RESERVE_FAILED';
export const CANDIDATE_CAPTURE_FAILED = 'CANDIDATE_CAPTURE_FAILED';
export const MAX_PARALLEL_CAP = 16;
export const DEFAULT_MAX_PARALLEL = 3;
// Worktree names read `Crew_YYYYMMDD_HHMMSS_<purpose>` so an operator can tell
// from the directory alone when a job ran and what it was for. Worktrees from
// an earlier release used `dsh-crew-<job>-<hex>` and stay recognised, so old
// trees are still adopted and cleaned up rather than orphaned.
//
// The shapes are matched exactly rather than by prefix, because the prefix
// alone is not proof of ownership: cleanup `--force`-deletes what it adopts,
// and a directory a user happened to name Crew_manual-testing or
// dsh-crew-backup would go with its uncommitted contents.
const WORKTREE_PREFIX = 'Crew_';
const WORKTREE_NAME_RE = /^Crew_\d{8}_\d{6}_[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:-\d+)?$/;
const LEGACY_WORKTREE_RE = /^dsh-crew-[A-Za-z0-9._-]+-[0-9a-f]{8}$/;

/** Whether a directory name is a worktree Crew created. */
export function isCrewWorktreeName(name) {
  const value = String(name ?? '');
  return WORKTREE_NAME_RE.test(value) || LEGACY_WORKTREE_RE.test(value);
}

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

const PURPOSE_MAX = 32;

/** Local wall-clock stamp: readable, and what an operator expects to see. */
function stamp(at) {
  const d = at instanceof Date ? at : new Date(at ?? Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * `Crew_<date>_<time>_<purpose>`, reserved by creating the directory.
 *
 * The reservation is a mkdir, not a lookup: two jobs starting in the same second
 * both probe before either has created anything, so a check-then-act name would
 * hand them the same path and one `git worktree add` would fail. mkdir
 * fails on EEXIST, which makes the suffix loop race-free, and a numeric suffix
 * is added only when the name is already taken.
 */
export function reserveWorktreeDir({ root, purpose, at }) {
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    return { ok: false, error: `cannot create worktree root: ${error?.message ?? error}` };
  }
  // Truncate before trimming. Trimming first lets a 32-character slice end on
  // the separator it just created, and the resulting name fails
  // `isCrewWorktreeName` — so Crew would create a worktree it no longer
  // recognises as its own, and stale pruning would never adopt it again.
  const safe = String(purpose ?? 'job').replace(/[^A-Za-z0-9]+/g, '-')
    .slice(0, PURPOSE_MAX).replace(/^-+|-+$/g, '') || 'job';
  const base = `${WORKTREE_PREFIX}${stamp(at)}_${safe}`;
  for (let n = 1; n <= 100; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    const dir = join(root, name);
    try {
      mkdirSync(dir);
      return { ok: true, dir, name };
    } catch (error) {
      if (error?.code !== 'EEXIST') return { ok: false, error: String(error?.message ?? error) };
    }
  }
  return { ok: false, error: 'no free worktree name' };
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

export async function createIsolatedWorkspace({ cwd, jobId, purpose, baseRevision, at, root = defaultWorktreeRoot(), git } = {}) {
  const run = git ?? defaultRunner;
  // A relative root would be resolved against this process's cwd for the
  // mkdir reservation but against the repo root for the git invocation, so the
  // two could land in different places. Anchor it once.
  root = resolve(root);
  const repo = await inspectRepository({ cwd, git: run });
  if (!repo.ok) return { ok: false, reason: repo.reason, error: repo.error };
  const rev = baseRevision ?? repo.baseRevision;
  const reserved = reserveWorktreeDir({ root, purpose, at });
  if (!reserved.ok) return { ok: false, reason: WORKTREE_RESERVE_FAILED, error: reserved.error };
  const { dir, name } = reserved;
  const res = await runGit(run, ['worktree', 'add', '--detach', dir, rev], { cwd: repo.repoRoot });
  if (!res.ok) {
    // A nonzero exit does not mean git did nothing: a failing post-checkout hook
    // leaves the worktree registered and populated, and a transient Windows lock
    // can defeat the unregister. Go through the same verified, retrying cleanup
    // the normal path uses, and report a blocked reservation rather than
    // pretending the name was released — a stranded registration makes every
    // later attempt on this name fail with no way for the caller to tell why.
    const released = await cleanupIsolatedWorkspace({ worktreePath: dir, repoRoot: repo.repoRoot, git: run, reservation: true });
    return {
      ok: false,
      reason: res.reason,
      error: res.error,
      ...(released.ok ? {} : { cleanupBlocked: true, cleanupError: released.error }),
    };
  }
  return { ok: true, worktreePath: dir, baseRevision: rev, repoRoot: repo.repoRoot, name };
}

function splitFirstTab(line) {
  const i = line.indexOf('\t');
  return i === -1 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)];
}

async function firstLinkComponent(cwd, relPath) {
  let current = resolve(cwd);
  const segments = String(relPath ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i += 1) {
    current = join(current, segments[i]);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) return segments.slice(0, i + 1).join('/');
    } catch {
      return null;
    }
  }
  return null;
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
  const untrackedFiles = [];
  const seenLinks = new Set();
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
    // Walk every path component with lstat so a symlink/junction anywhere in
    // the path is never followed. Out-of-worktree targets are treated as
    // non-replayable; only the link boundary is exposed.
    const link = await firstLinkComponent(cwd, p);
    if (link) {
      if (!seenLinks.has(link)) {
        seenLinks.add(link);
        untrackedFiles.push(link);
        out += `[UNTRACKED SYMLINK: ${link}]\n`;
        incompleteReasons.push(`untracked_symlink:${link}`);
      }
      continue;
    }
    untrackedFiles.push(p);
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

  // Fingerprint identity must represent the complete pre-truncation workspace
  // diff, not the truncated patch bytes that are actually retained.
  const workspaceDigest = createHash('sha256').update(out).digest('hex');
  const truncated = Buffer.byteLength(out, 'utf8') > limit;
  if (truncated) {
    out = Buffer.from(out, 'utf8').subarray(0, limit).toString('utf8');
    incompleteReasons.push('patch_truncated');
  }
  const complete = incompleteReasons.length === 0;
  return { failed: false, patch: out, truncated, redacted, complete, incompleteReasons, untrackedFiles, workspaceDigest };
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

function candidateFingerprint({ base, nameStatus, workspaceDigest }) {
  return createHash('sha256').update(`${base}\n${nameStatus ?? ''}\n${workspaceDigest ?? ''}`).digest('hex');
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

  const untrackedFiles = built.untrackedFiles ?? untracked;

  const nameStatusOut = nameStatus.stdout;
  return {
    ok: true,
    kind: 'git-worktree',
    base_revision: base,
    committed_head: head.ok ? head.stdout.trim() : null,
    worktree_path: worktreePath,
    changed_files: [...new Set([...trackedIn(nameStatusOut, untrackedFiles), ...built.redacted, ...untrackedFiles])],
    name_status: nameStatusOut,
    diff_stat: statRel.stdout,
    patch: built.patch,
    patch_truncated: built.truncated,
    sensitive_paths_redacted: built.redacted,
    untracked_files: untrackedFiles,
    complete: built.complete,
    replayable: built.complete,
    incomplete_reasons: built.incompleteReasons,
    fingerprint: candidateFingerprint({ base, nameStatus: nameStatusOut, workspaceDigest: built.workspaceDigest }),
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

/**
 * Parse `git worktree list --porcelain` into records. Git documents that the
 * main working tree is the first record; `detached` marks the ones Crew creates,
 * since every Crew worktree is added with `--detach`.
 */
function parseWorktrees(stdout) {
  const out = [];
  for (const block of String(stdout ?? '').split('\n\n')) {
    const lines = block.split('\n');
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)?.trim();
    if (!path) continue;
    out.push({ path: resolve(path), detached: lines.includes('detached') });
  }
  return out;
}

async function mainRepoRoot(run, worktreePath) {
  // The main working tree is the first record of `git worktree list`; deriving
  // it from `--git-common-dir` breaks for a bare main repository, where that
  // path is the bare repository itself and its parent is not a git directory at
  // all. The first record is the same ordering guarantee the stale-list scan
  // already relies on.
  const list = await runGit(run, ['worktree', 'list', '--porcelain'], { cwd: worktreePath });
  if (!list.ok) return null;
  return parseWorktrees(list.stdout)[0]?.path ?? null;
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
  return parseWorktrees(res.stdout).some((record) => pathIdentity(record.path) === target);
}

/**
 * The repository's common git directory as seen from `cwd`, or null when git
 * cannot say. `--path-format=absolute` needs git 2.31+, so the relative form is
 * resolved against `cwd` for older installations.
 */
async function commonDirOf(run, cwd) {
  const abs = await runGit(run, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (abs.ok && abs.stdout.trim()) return resolve(abs.stdout.trim());
  const rel = await runGit(run, ['rev-parse', '--git-common-dir'], { cwd });
  if (!rel.ok || !rel.stdout.trim()) return null;
  return resolve(cwd, rel.stdout.trim());
}

/**
 * Whether `worktreePath` carries git metadata for the same repository as `root`.
 *
 * A directory name is not proof of ownership, and the filesystem fallback below
 * force-deletes what it adopts — so the last resort asks git which repository the
 * directory belongs to and refuses when the answer is unavailable or different.
 * An unrelated directory that merely happens to be named like a Crew worktree
 * therefore survives.
 */
async function sameRepository(run, worktreePath, root) {
  const [a, b] = await Promise.all([commonDirOf(run, worktreePath), commonDirOf(run, root)]);
  return Boolean(a && b && pathIdentity(a) === pathIdentity(b));
}

function emptyDirectory(path) {
  try { return readdirSync(path).length === 0; } catch { return false; }
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
  reservation = false,
} = {}) {
  const run = git ?? defaultRunner;
  if (!worktreePath) return { ok: false, reason: NOT_GIT_REPOSITORY, error: 'worktree path required' };
  const root = repoRoot ?? (await mainRepoRoot(run, worktreePath));
  const owned = isCrewWorktreeName(basename(resolve(worktreePath)));

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
  //
  // Ownership here is not the name alone. An earlier revision adopted anything
  // whose basename matched, so a directory the user had named (or a worktree they
  // had made) could be force-deleted for resembling Crew's. Two things now have
  // to hold: the path is a worktree of *this* repository, and either git still
  // carries its registration (proving Crew registered it) or it is the empty
  // reservation this call itself just created.
  if (owned && root && pathIdentity(worktreePath) !== pathIdentity(root)) {
    const adopted = (await sameRepository(run, worktreePath, root)) || (reservation && emptyDirectory(worktreePath));
    if (!adopted) {
      return {
        ok: false,
        reason: WORKTREE_LOCKED,
        error: `refusing to delete ${worktreePath}: not a worktree of ${root} (remove it manually if it is disposable)`,
        cleanupBlocked: true,
      };
    }
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
  const set = new Set(allowed.map((p) => pathIdentity(p)));
  const stale = [];
  try {
    const root = await inspectRepository({ cwd: allowed[0] ?? process.cwd(), git: run });
    if (root.ok) {
      const res = await runGit(run, ['worktree', 'list', '--porcelain'], { cwd: root.repoRoot });
      if (res.ok) {
        // `git worktree list` puts the main working tree first. Inspecting from
        // inside a linked worktree reports that worktree as the top level, so the
        // repo root cannot be matched by path — the position in the list is what
        // identifies the main tree.
        const records = parseWorktrees(res.stdout);
        for (let index = 1; index < records.length; index += 1) {
          const { path: abs, detached } = records[index];
          // A repo whose directory happens to start with a Crew prefix (say, a
          // checkout named dsh-crew-something) is not a disposable worktree, and
          // treating it as stale would have the cleanup path fighting over it.
          //
          // The name is still not proof: `dsh-crew-backup-deadbeef` is a name a
          // user could plausibly pick, and guessing wrong here force-deletes
          // their worktree. Crew always creates its worktrees detached, so a
          // linked worktree that is on a branch is not Crew's, whatever it is
          // called.
          if (!detached) continue;
          if (isCrewWorktreeName(basename(abs)) && !set.has(pathIdentity(abs))) stale.push(abs);
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
