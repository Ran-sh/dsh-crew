// The two stable workspaces a Crew job runs in, one pair per project.
//
// Every job used to get its own git worktree named `Crew_<date>_<time>_<role>`,
// so the Harness — which groups sessions by the job's cwd, and matches the
// workspace exactly (`resolveByPath`, never a parent directory) — grew a new
// workspace entry for every job an operator ran. A pair that is created once and
// reused means the session list stops growing: a worker job and its automatic
// review both run in `dsh-crew-worker` (the reviewer has to see the tree the
// worker produced), and an explicit reviewer dispatch runs in `dsh-crew-review`.
//
// Two cwds per project, never shared between projects: a worktree belongs to one
// repository, so the pair is namespaced under a key derived from the repository
// path.
//
// Because the workspace outlives the job, two jobs sharing it would corrupt each
// other's evidence — see `workspace-lock.mjs`, which this takes for the whole
// job, and the reset below, which is what keeps a job from inheriting the last
// one's work.

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve, sep } from 'node:path';

import {
  createWorktreeAt,
  crewOwnsWorktree,
  defaultWorktreeRoot,
  inspectRepository,
  resetWorktreeTo,
  sameRepoPath,
  withSafeDirectory,
} from './workspace-isolation.mjs';
import { acquireWorkspaceLock, DEFAULT_LOCK_WAIT_MS } from './workspace-lock.mjs';

export const CREW_WORKSPACE_WORKER = 'dsh-crew-worker';
export const CREW_WORKSPACE_REVIEW = 'dsh-crew-review';
const CREW_WORKSPACE_NAMES = Object.freeze([CREW_WORKSPACE_WORKER, CREW_WORKSPACE_REVIEW]);
export const WORKSPACE_CONFLICT = 'WORKSPACE_CONFLICT';

/** The workspace a role runs in. Only the reviewer is separated out. */
export function crewWorkspaceName(role) {
  return role === 'reviewer' || role === 'review' ? CREW_WORKSPACE_REVIEW : CREW_WORKSPACE_WORKER;
}

/** Is this directory name one of the two stable workspaces? */
export function isCrewWorkspaceName(name) {
  return CREW_WORKSPACE_NAMES.includes(String(name ?? ''));
}

/**
 * A stable, filesystem-safe key for a repository.
 *
 * Two projects' `dsh-crew-worker` directories must not collide, and the human
 * part is kept because the key is visible in the session path: the directory
 * name plus eight hex characters of the resolved path, the same shape the legacy
 * worktree names used.
 */
export function crewProjectKey(repoRoot) {
  const identity = resolve(String(repoRoot ?? '')).split(sep).join('/');
  const normalized = process.platform === 'win32' ? identity.toLowerCase() : identity;
  const safe = basename(identity).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 32).replace(/^-+|-+$/g, '') || 'project';
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `dsh-crew-${safe}-${digest}`;
}

/** `<worktreeRoot>/<projectKey>/<name>` — where this project's pair lives. */
export function crewWorkspacePath({ repoRoot, role, root = defaultWorktreeRoot() } = {}) {
  return join(resolve(root), crewProjectKey(repoRoot), crewWorkspaceName(role));
}

/** The lock for a workspace lives beside the pair, never inside the tree. */
export function crewWorkspaceLockPath({ repoRoot, role, root = defaultWorktreeRoot() } = {}) {
  return join(resolve(root), crewProjectKey(repoRoot), '.locks', `${crewWorkspaceName(role)}.lock`);
}

/**
 * The workspace this job should run in, held for the job's duration.
 *
 * Creates the pair member on first use and adopts it afterwards; the adopted
 * tree is reset to the job's base revision so the candidate diff is this job's
 * work alone, exactly as a fresh worktree gave it. Returns a `release` that
 * drops the lock but leaves the directory — the next job reuses it.
 */
export async function ensureCrewWorkspace({
  cwd,
  // The repository root the REQUEST named, when Crew may trust it for this job's git
  // subprocesses. A shared checkout can be owned by another account, and Git refuses
  // to read it without a `safe.directory` exception; the exception is scoped to this
  // one root, and the repository Git resolves must be exactly that root — anything
  // else (a subdirectory cwd, a different repo) fails closed rather than widening the
  // trust. Worktree-local operations do not get the exception: the worktree Crew
  // creates is owned by the account Crew runs as.
  trustedRepoRoot = null,
  role,
  baseRevision,
  at,
  root = defaultWorktreeRoot(),
  git,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  now,
  sleep,
  isAlive,
  pid,
} = {}) {
  const run = trustedRepoRoot ? withSafeDirectory(git, trustedRepoRoot) : git;
  const repo = await inspectRepository({ cwd, git: run });
  if (!repo.ok) return { ok: false, reason: repo.reason, error: repo.error };
  if (trustedRepoRoot && !sameRepoPath(repo.repoRoot, trustedRepoRoot)) {
    return {
      ok: false,
      reason: 'WORKSPACE_TRUST_ANCHOR_MISMATCH',
      error: `git resolved ${repo.repoRoot}, not the trusted root ${trustedRepoRoot}; run the job at the repository root or register a workspace context`,
    };
  }
  const repoRoot = repo.repoRoot;
  const revision = baseRevision ?? repo.baseRevision;
  const name = crewWorkspaceName(role);
  const worktreePath = crewWorkspacePath({ repoRoot, role, root });
  const lockPath = crewWorkspaceLockPath({ repoRoot, role, root });

  const lock = await acquireWorkspaceLock({ lockPath, purpose: name, waitMs: lockWaitMs, now, sleep, isAlive, pid });
  if (!lock.ok) return { ok: false, reason: lock.reason, error: lock.error, holder: lock.holder ?? null };
  const release = lock.release;

  const fail = (reason, error) => {
    release();
    return { ok: false, reason, error };
  };

  const reused = await crewOwnsWorktree({ worktreePath, repoRoot, git: run });
  if (!reused) {
    if (existsSync(worktreePath)) {
      // Something is there that Crew did not create. Deleting it would be a
      // destructive guess about a directory Crew cannot claim, so refuse and
      // say which path is in the way.
      return fail(WORKSPACE_CONFLICT, `workspace path exists but is not a Crew worktree of this repository: ${worktreePath}`);
    }
    const created = await createWorktreeAt({ dir: worktreePath, repoRoot, revision, purpose: name, at, git: run });
    if (!created.ok) return fail(created.reason, created.error);
  }

  const reset = await resetWorktreeTo({ worktreePath, revision, git });
  if (!reset.ok) return fail(reset.reason, reset.error);

  return { ok: true, worktreePath, repoRoot, baseRevision: revision, name, reused, release };
}

/**
 * Release the lock a job held. The directory stays: it is the workspace the
 * next job — and every session it produced — belongs to.
 */
export function releaseCrewWorkspace(handle) {
  try { return handle?.release?.() === true; } catch { return false; }
}
