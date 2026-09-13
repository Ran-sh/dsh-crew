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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { isSensitivePath, parseChanges, DIFF_LIMIT, GIT_TIMEOUT_MS } from './workspace-audit.mjs';

const execFileAsync = promisify(execFile);

export const NOT_GIT_REPOSITORY = 'NOT_GIT_REPOSITORY';
export const GIT_NOT_FOUND = 'GIT_NOT_FOUND';
export const GIT_TIMEOUT = 'GIT_TIMEOUT';
export const GIT_ERROR = 'GIT_ERROR';
/** A valid repository whose HEAD does not resolve because nothing is committed. */
export const REPOSITORY_HAS_NO_COMMITS = 'REPOSITORY_HAS_NO_COMMITS';
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

// ---------- ownership record ----------
//
// A name is not proof that Crew made a worktree. `dsh-crew-backup-deadbeef`
// satisfies the legacy grammar, and `detached` describes HEAD rather than who
// created the tree, so both can be true of a worktree a user made — and cleanup
// `--force` deletes what it adopts. Crew therefore records what it creates,
// beside the worktrees it creates it in, and only ever adopts what a valid
// record claims. Anything else that looks like a leftover is reported for a
// human instead of removed.
//
// The record lives under the worktree root rather than in the Crew home so it
// travels with the trees it describes: if the root is wiped, the trees are gone
// with it and there is nothing left to adopt.
//
// A record is evidence only when it can be read and matches: its shape is
// validated, its name has to be this worktree's name, and its repository has to
// be the repository being scanned. An unreadable, truncated, malformed or
// mismatched record reads as "not owned", which withholds deletion rather than
// granting it — the one direction where being wrong is survivable.

const OWNED_DIRNAME = '.crew-owned';
const OWNED_SCHEMA = 2;
// Stored inside the worktree's git administrative directory, which git destroys
// with the worktree.
const INCARNATION_FILE = 'crew-owned';

function ownedMarkerPath(worktreePath) {
  const abs = resolve(worktreePath);
  return join(dirname(abs), OWNED_DIRNAME, `${basename(abs)}.json`);
}

/**
 * Prove which *incarnation* of a worktree this is.
 *
 * A path can be reused. Git removes a worktree and later another one is created
 * in the same place — same name, same repository — so a record keyed on those
 * alone can be inherited by a successor that Crew never created, and inherited
 * again after Crew's own cleanup if releasing the record failed. The worktree's
 * git administrative directory does not have that problem: git deletes it along
 * with the worktree, so a value kept there cannot outlive the tree it describes.
 */
async function gitDirOf(run, cwd) {
  const abs = await runGit(run, ['rev-parse', '--path-format=absolute', '--git-dir'], { cwd });
  if (abs.ok && abs.stdout.trim()) return resolve(abs.stdout.trim());
  const rel = await runGit(run, ['rev-parse', '--git-dir'], { cwd });
  if (!rel.ok || !rel.stdout.trim()) return null;
  return resolve(cwd, rel.stdout.trim());
}

/** The nonce this worktree incarnation was stamped with, if any. */
async function incarnationOf(run, worktreePath) {
  const gitDir = await gitDirOf(run, worktreePath);
  if (!gitDir) return null;
  let nonce;
  try { nonce = readFileSync(join(gitDir, INCARNATION_FILE), 'utf8').trim(); } catch { return null; }
  return nonce ? { gitDir, nonce } : null;
}

/** Stamp a freshly created worktree so its record cannot be inherited later. */
async function claimIncarnation(run, worktreePath) {
  const gitDir = await gitDirOf(run, worktreePath);
  if (!gitDir) return null;
  const nonce = randomBytes(16).toString('hex');
  try { writeFileSync(join(gitDir, INCARNATION_FILE), `${nonce}\n`); } catch { return null; }
  return { gitDir, nonce };
}

function recordOwnership({ worktreePath, repo, incarnation, head, purpose, at }) {
  const marker = ownedMarkerPath(worktreePath);
  const record = {
    schemaVersion: OWNED_SCHEMA,
    name: basename(resolve(worktreePath)),
    worktree: pathIdentity(worktreePath),
    // Binding the record to a repository is what stops a stale record from
    // licensing a delete for a worktree of some other repository that later
    // occupies the same path. The identity is the git *common* directory, not
    // `--show-toplevel`: that returns the linked worktree's own path when run
    // inside one, so it names different directories for the same repository
    // depending on where it is asked.
    repo: pathIdentity(repo),
    git_dir: pathIdentity(incarnation.gitDir),
    nonce: incarnation.nonce,
    // The revision Crew left the worktree at. An operator who commits or checks
    // out something else has taken the worktree over, and moving HEAD is how
    // that shows up: being on a branch is only one way to do it.
    head,
    purpose: purpose ?? null,
    created_at: at ?? Date.now(),
  };
  try {
    mkdirSync(dirname(marker), { recursive: true });
    const pending = `${marker}.${process.pid}.tmp`;
    writeFileSync(pending, JSON.stringify(record) + '\n');
    renameSync(pending, marker);
    return true;
  } catch {
    return false;
  }
}

function releaseOwnership({ worktreePath }) {
  try { rmSync(ownedMarkerPath(worktreePath), { force: true }); return true; } catch { return false; }
}

/**
 * The validated ownership record for `worktreePath`, or null when there is no
 * usable evidence that Crew created *this* worktree in `repo`.
 *
 * This answers identity only — was it Crew's worktree? — and deliberately not
 * state, which is a question for the caller: `head` and `detached` describe what
 * the worktree looks like now, and a worktree whose operator has moved HEAD is
 * still Crew's worktree, just no longer a disposable one. All of shape, name,
 * path, repository and incarnation have to match; every failure reads as "not
 * owned", which withholds deletion rather than granting it.
 */
function readOwnership({ worktreePath, repo, incarnation }) {
  let raw;
  try { raw = readFileSync(ownedMarkerPath(worktreePath), 'utf8'); } catch { return null; }
  let record;
  try { record = JSON.parse(raw); } catch { return null; }
  if (!record || typeof record !== 'object' || record.schemaVersion !== OWNED_SCHEMA) return null;
  if (typeof record.name !== 'string' || record.name !== basename(resolve(worktreePath))) return null;
  if (typeof record.worktree !== 'string' || record.worktree !== pathIdentity(worktreePath)) return null;
  // An unknown identity on either side cannot be matched, so it cannot be
  // adopted: an unverifiable record is not evidence.
  if (!repo || typeof record.repo !== 'string' || record.repo !== pathIdentity(repo)) return null;
  if (!incarnation) return null;
  if (typeof record.nonce !== 'string' || record.nonce !== incarnation.nonce) return null;
  if (typeof record.git_dir !== 'string' || record.git_dir !== pathIdentity(incarnation.gitDir)) return null;
  return record;
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
  if (!head.ok) {
    // A repository with no commits yet is a valid repository whose HEAD simply
    // does not resolve, and it cannot be told apart from a broken one by that
    // command alone. It is worth telling apart: `git init && <ask Crew to do
    // something>` is how a new project starts, and reporting it as a generic git
    // error leaves the operator with nothing to act on.
    const verified = await runGit(run, ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
    if (verified.ok === false && (verified.code === 1 || verified.code === 128) && !verified.stdout?.trim()) {
      return {
        ok: false,
        reason: REPOSITORY_HAS_NO_COMMITS,
        error: 'this repository has no commits yet, so there is no revision for an isolated job to start from; make an initial commit, or set execution.isolation to "shared" to run in the working tree',
      };
    }
    return { ok: false, reason: head.reason, error: head.error };
  }
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
  // Recorded only after git succeeded, so a failed creation never leaves a claim
  // on a tree that does not exist. A record that cannot be written costs the
  // automatic prune of this one worktree; it never costs the worktree itself.
  //
  // `owned` is only true when a record that `readOwnership` would actually
  // accept was written: a record missing its repository or incarnation identity
  // can never authorize cleanup, and reporting it as owned would be a leak
  // dressed up as success.
  // The revision Git actually left the worktree at, not the string we asked for:
  // a caller may pass a branch or tag, and recording that name would never match
  // the commit OID `worktree list` reports, so the worktree could never be
  // recognized as untouched.
  const headRes = await runGit(run, ['rev-parse', 'HEAD'], { cwd: dir });
  const created = headRes.ok ? headRes.stdout.trim() : '';

  const commonDir = await commonDirOf(run, repo.repoRoot);
  const incarnation = commonDir ? await claimIncarnation(run, dir) : null;
  // All four identities are required, and an unresolvable HEAD is not a fallback
  // to the requested string: recording a symbolic name would produce a record
  // that can never match, which is a worktree that can never be cleaned up
  // reported as owned.
  const owned = Boolean(commonDir && incarnation && created)
    && recordOwnership({ worktreePath: dir, repo: commonDir, incarnation, head: created, purpose, at });
  return { ok: true, worktreePath: dir, baseRevision: rev, repoRoot: repo.repoRoot, name, owned };
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
    out.push({
      path: resolve(path),
      detached: lines.includes('detached'),
      head: lines.find((line) => line.startsWith('HEAD '))?.slice('HEAD '.length)?.trim() ?? null,
    });
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

/**
 * A path identity safe to compare for equality.
 *
 * `realpathSync` returns the on-disk spelling, so two aliases of one directory —
 * a symlinked repo root, a mapped drive, a differently cased path — collapse to
 * the same string without guessing. Lower-casing on Windows used to stand in for
 * this, but Windows supports per-directory case sensitivity, where `Foo` and
 * `foo` really are two directories and folding them together would license a
 * delete against the wrong repository.
 */
const pathIdentity = (value) => {
  const resolved = resolve(String(value));
  try { return realpathSync.native ? realpathSync.native(resolved) : realpathSync(resolved); }
  catch { return resolved; }
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
 * Why `worktreePath` is no longer the worktree the caller validated, or null when
 * it still is.
 *
 * Checking ownership and then deleting by pathname is check-then-act: whatever
 * occupies the path when the delete runs is what gets deleted. Re-reading the
 * incarnation, registration, HEAD and detached state immediately before the
 * removal narrows that window to the removal itself.
 */
async function ownershipDrift(run, worktreePath, expect) {
  const incarnation = await incarnationOf(run, worktreePath);
  if (!incarnation) return 'its incarnation stamp is gone';
  if (incarnation.nonce !== expect.incarnation?.nonce) return 'its incarnation nonce changed';
  if (pathIdentity(incarnation.gitDir) !== pathIdentity(expect.incarnation?.gitDir)) return 'its git directory changed';
  const listed = await runGit(run, ['worktree', 'list', '--porcelain'], { cwd: worktreePath });
  if (!listed.ok) return 'it is no longer registered';
  const record = parseWorktrees(listed.stdout).find((r) => pathIdentity(r.path) === pathIdentity(worktreePath));
  if (!record) return 'it is no longer registered';
  if (!record.detached) return 'it is no longer detached';
  if (expect.head && record.head !== expect.head) return `its HEAD moved from ${expect.head} to ${record.head}`;
  return null;
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
  // Callers that own the worktree (the Hub allocated it, this process holds the
  // job) may force it away. Callers that merely recognised it — background
  // pruning — must not: forcing discards any changes the tree now holds, which is
  // precisely what a takeover looks like.
  force = true,
  // What the caller validated before deciding to delete. Re-checked here, because
  // deciding on one observation and acting on a pathname is a different object.
  expect = null,
} = {}) {
  const run = git ?? defaultRunner;
  if (!worktreePath) return { ok: false, reason: NOT_GIT_REPOSITORY, error: 'worktree path required' };
  const root = repoRoot ?? (await mainRepoRoot(run, worktreePath));
  const owned = isCrewWorktreeName(basename(resolve(worktreePath)));

  if (expect) {
    const drift = await ownershipDrift(run, worktreePath, expect);
    if (drift) {
      return { ok: false, reason: WORKTREE_LOCKED, error: `refusing to remove ${worktreePath}: ${drift}`, cleanupBlocked: true };
    }
  }

  if (!force) {
    // Measured, not assumed: git refuses modified, staged and untracked files
    // without `--force`, but it removes a worktree whose only remaining content
    // is *ignored* — build output, a log, local config — and takes that content
    // with it. Ask about ignored files directly, and treat an unanswerable
    // question as a reason not to delete.
    const ignored = await runGit(run, ['ls-files', '--others', '--ignored', '--exclude-standard'], { cwd: worktreePath });
    if (!ignored.ok || ignored.stdout.trim() !== '') {
      return {
        ok: false,
        reason: WORKTREE_LOCKED,
        error: `refusing to remove ${worktreePath} without --force: it holds files that are not Crew's, or its contents could not be read`,
        cleanupBlocked: true,
      };
    }
    // And the index flags, which are the same class of hole one level down: a
    // tracked file with `assume-unchanged` or `skip-worktree` set is invisible to
    // `status`, to the untracked query and to the ignored query alike, and git
    // removes the worktree without complaint — taking the operator's edit with
    // it. Measured on git 2.47.3. In `ls-files -v` a lowercase letter means
    // assume-unchanged and `S` means skip-worktree; the ordinary state is `H`.
    const flags = await runGit(run, ['ls-files', '-v'], { cwd: worktreePath });
    const hidden = flags.ok
      ? flags.stdout.split('\n').find((line) => /^([a-z]|S)/.test(line)) ?? null
      : 'unknown';
    if (!flags.ok || hidden) {
      return {
        ok: false,
        reason: WORKTREE_LOCKED,
        error: `refusing to remove ${worktreePath} without --force: its index carries assume-unchanged or skip-worktree entries, which hide a modification from every status query`,
        cleanupBlocked: true,
      };
    }
  }

  if (root) {
    // Preferred path: `git worktree remove` (removes registration and directory
    // atomically). Retry bounded times to recover transient locks.
    //
    // The ownership re-check above narrows the window between deciding and
    // deleting, but it does not close it: git has no "remove only if HEAD and
    // incarnation still equal X" primitive, so a worktree that changes in the
    // moments between the two is removed anyway. That residual is accepted and
    // stated rather than papered over; closing it needs a lease on the worktree,
    // not another read.
    const args = force
      ? ['worktree', 'remove', '--force', worktreePath]
      : ['worktree', 'remove', worktreePath];
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const res = await runGit(run, args, { cwd: root });
      if (res.ok) {
        const released = releaseOwnership({ worktreePath });
        return {
          ok: true,
          removed: true,
          actions: [`removed worktree ${worktreePath}`],
          // The worktree is gone but its record is not: worth saying, because the
          // record is what would have authorized a later cleanup.
          ...(released ? {} : { ownershipRecordStale: true }),
        };
      }
      if (attempt < retries - 1) await sleep(backoffMs);
    }
    if (!force) {
      // Non-forced removal failed: git is refusing, or the tree is locked. The
      // filesystem fallback deletes unconditionally, so it must not run here.
      return { ok: false, reason: WORKTREE_LOCKED, error: `git declined to remove ${worktreePath} without --force`, cleanupBlocked: true };
    }
  }

  // Last resort, only for Crew-owned disposable paths: remove the directory and
  // verify the git registration actually went away before claiming success.
  //
  // Ownership here is not the name alone. An earlier revision adopted anything
  // whose basename matched, so a directory the user had named (or a worktree they
  // had made) could be force-deleted for resembling Crew's.
  if (owned && root && pathIdentity(worktreePath) !== pathIdentity(root)) {
    // Ask git BEFORE deleting anything. The reverse order — delete, then check —
    // destroys the files of a worktree git still tracks and then reports the
    // registration stranded, which is the outcome the caller was avoiding.
    const registered = await worktreeRegistered({ worktreePath, git: run, cwd: root });
    if (registered === true) {
      return { ok: false, reason: WORKTREE_LOCKED, error: `worktree still registered after git refused to remove it: ${worktreePath}`, cleanupBlocked: true };
    }
    // The empty directory this call itself reserved is the one path that needs no
    // repository provenance; anything else must belong to this repository.
    const ownEmptyReservation = reservation && emptyDirectory(worktreePath);
    const adoptable = ownEmptyReservation || (registered === false && await sameRepository(run, worktreePath, root));
    if (!adoptable) {
      return {
        ok: false,
        reason: WORKTREE_LOCKED,
        error: `refusing to delete ${worktreePath}: not a worktree of ${root} (remove it manually if it is disposable)`,
        cleanupBlocked: true,
      };
    }
    try {
      // A reservation is empty by construction, so remove it non-recursively: if
      // something appeared in it, failing is better than deleting that too.
      if (ownEmptyReservation) rmdirSync(worktreePath);
      else rmSync(worktreePath, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, reason: WORKTREE_LOCKED, error: `worktree cleanup failed: ${err?.message ?? String(err)}`, cleanupBlocked: true };
    }
    if (!existsSync(worktreePath)) {
      const released = releaseOwnership({ worktreePath });
      return {
        ok: true,
        removed: true,
        actions: [`cleaned worktree files ${worktreePath}`],
        ...(released ? {} : { ownershipRecordStale: true }),
      };
    }
    return { ok: false, reason: WORKTREE_LOCKED, error: `could not verify worktree removal for ${worktreePath}`, cleanupBlocked: true };
  }

  return { ok: false, reason: WORKTREE_LOCKED, error: `worktree cleanup failed while ${worktreePath} remains (${root ? 'not a Crew-owned disposable path' : 'main repository root unresolvable'})`, cleanupBlocked: true };
}

/**
 * Split the linked worktrees of this repository into:
 *
 * - `stale`: Crew recorded creating it and it is still in the disposable state
 *   Crew leaves behind, so it may be removed automatically;
 * - `retained`: Crew recorded creating it, but an operator has since attached a
 *   branch or checked something out, so it is no longer Crew's to discard;
 * - `unowned`: Crew cannot show it created it at all.
 *
 * Only the first is ever deleted. The other two are reported so a human decides.
 * Returned paths are canonical: git reports the spelling it resolved when the
 * worktree was added, which on Windows can expand an 8.3 temp name (`RUNNER~1`)
 * into its long form, so a caller comparing its own path string against the
 * answer would miss — and a miss here decides whether a live worktree looks
 * like a leftover.
 */
async function worktreeCandidates({ git, allowed = [] } = {}) {
  const run = git ?? defaultRunner;
  const set = new Set(allowed.map((p) => pathIdentity(p)));
  const stale = [];
  const retained = [];
  const unowned = [];
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
        const repo = await commonDirOf(run, root.repoRoot);
        for (let index = 1; index < records.length; index += 1) {
          const { path: abs, detached, head } = records[index];
          // A repo whose directory happens to start with a Crew prefix (say, a
          // checkout named dsh-crew-something) is not a disposable worktree, and
          // treating it as stale would have the cleanup path fighting over it.
          if (!isCrewWorktreeName(basename(abs)) || set.has(pathIdentity(abs))) continue;
          const incarnation = await incarnationOf(run, abs);
          const owned = readOwnership({ worktreePath: abs, repo, incarnation });
          if (!owned) {
            // The name is not proof: `dsh-crew-backup-deadbeef` is a name a user
            // could plausibly pick. No valid record, no deletion.
            unowned.push(pathIdentity(abs));
          } else if (detached && owned.head === head) {
            // Crew's worktree, untouched since Crew left it there. The incarnation
            // and HEAD travel with it so the removal can re-check them rather
            // than trusting that nothing changed since this scan.
            stale.push({ path: pathIdentity(abs), incarnation, head });
          } else {
            // Crew's worktree, but no longer a disposable one. Being on a branch
            // is only one way an operator takes a worktree over; committing on a
            // detached HEAD, or checking out something else, moves it just as
            // far out of Crew's hands.
            retained.push(pathIdentity(abs));
          }
        }
      }
    }
  } catch {}
  return { stale, retained, unowned };
}

/** Crew-created worktrees that are still disposable and belong to no active job. */
export async function staleWorktrees({ git, allowed = [] } = {}) {
  return (await worktreeCandidates({ git, allowed })).stale.map((entry) => entry.path);
}

/** Linked worktrees that resemble Crew's but carry no usable record of it. */
export async function unownedWorktrees({ git, allowed = [] } = {}) {
  return (await worktreeCandidates({ git, allowed })).unowned;
}

/** Crew-created worktrees an operator has since taken over; never removed. */
export async function retainedWorktrees({ git, allowed = [] } = {}) {
  return (await worktreeCandidates({ git, allowed })).retained;
}

/**
 * Report what Crew could clean up, and only delete when explicitly asked.
 *
 * `remove` defaults to false, and the default is the point. Deleting from a
 * background scan has been shown insufficient three separate ways: git removes a
 * worktree whose only content is ignored; it removes one whose tracked file
 * carries `assume-unchanged` or `skip-worktree`; and between validating a
 * worktree and deleting it, the worktree can change. Each was measured against
 * real git rather than reasoned about, and each ends with an operator's work
 * gone. Nothing in Crew calls this path, so the automatic capability buys nothing
 * and risks the one thing Crew must not lose.
 *
 * A caller that has decided to remove a specific worktree should pass
 * `remove: true`, or better, use `cleanupIsolatedWorkspace` for a worktree it
 * directly owns. Unattended deletion would need a lease on the worktree, not
 * another pre-delete observation.
 */
export async function pruneWorktrees({ git, allowed = [], remove = false } = {}) {
  const run = git ?? defaultRunner;
  const { stale, retained, unowned } = await worktreeCandidates({ git: run, allowed });
  const actions = [];

  if (!remove) {
    for (const entry of stale) actions.push(`stale Crew worktree, remove explicitly if it is finished with: ${entry.path}`);
    for (const w of unowned) actions.push(`not Crew-owned, left in place: ${w}`);
    for (const w of retained) actions.push(`taken over by an operator, left in place: ${w}`);
    return {
      ok: true,
      reportOnly: true,
      removed: 0,
      candidates: stale.map((entry) => entry.path),
      failed: [],
      unowned,
      retained,
      staleRecords: [],
      actions,
    };
  }

  const failed = [];
  const staleRecords = [];
  let removed = 0;
  for (const entry of stale) {
    // Not forced, and re-checked against what was scanned: background pruning
    // recognised this worktree from a name and a record, and neither survives the
    // tree itself being taken over. `--force` would discard whatever an operator
    // had put there; ownershipDrift would not notice if they had already.
    const r = await cleanupIsolatedWorkspace({
      worktreePath: entry.path,
      git: run,
      force: false,
      expect: { incarnation: entry.incarnation, head: entry.head },
    });
    // A locked worktree is left on disk, so counting it as removed would tell an
    // operator the machine is clean when it is not.
    if (r.ok && r.removed) {
      removed += 1;
      actions.push(...(r.actions ?? []));
      if (r.ownershipRecordStale) staleRecords.push(entry.path);
    } else {
      failed.push(entry.path);
      actions.push(`failed to remove ${entry.path}: ${r.error ?? 'unknown reason'}`);
    }
  }
  for (const w of unowned) actions.push(`not Crew-owned, left in place: ${w}`);
  for (const w of retained) actions.push(`taken over by an operator, left in place: ${w}`);
  return {
    ok: failed.length === 0,
    removed,
    failed,
    unowned,
    retained,
    staleRecords,
    actions,
    ...(failed.length ? { cleanupBlocked: true } : {}),
  };
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
