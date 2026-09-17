// The two stable per-project Crew workspaces, and the lock that keeps one job
// at a time in each.
//
// What these pin is the pair of properties that make the design safe: one
// workspace per (project, role) that survives across jobs, and a job never
// starting on a tree another job is still using or has left dirty.
//
// Real git in a temp repo — the creation path is `git worktree add`, which a
// fake runner would only pretend to exercise.
// Run with: node --test test/crew-workspaces.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  CREW_WORKSPACE_REVIEW,
  CREW_WORKSPACE_WORKER,
  WORKSPACE_CONFLICT,
  crewProjectKey,
  crewWorkspaceLockPath,
  crewWorkspaceName,
  crewWorkspacePath,
  ensureCrewWorkspace,
  isCrewWorkspaceName,
  releaseCrewWorkspace,
} from '../src/crew-workspaces.mjs';
import { DEFAULT_LOCK_MAX_HOLD_MS, WORKSPACE_BUSY, acquireWorkspaceLock } from '../src/workspace-lock.mjs';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-ws-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'crew@local'], dir);
  git(['config', 'user.name', 'crew'], dir);
  // The machine's global autocrlf would otherwise decide what a checked-out
  // file contains, so these assertions would mean different things on different
  // hosts.
  git(['config', 'core.autocrlf', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'first\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'first'], dir);
  return dir;
}

function worktreeRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-ws-root-'));
  t.after(() => {
    // Worktrees are registered in the repo, which the caller removes; make the
    // root removable regardless of what is left in it.
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

// ---------- naming ----------

test('the two roles map to the two workspace names', () => {
  assert.equal(crewWorkspaceName('worker'), CREW_WORKSPACE_WORKER);
  assert.equal(crewWorkspaceName(undefined), CREW_WORKSPACE_WORKER);
  assert.equal(crewWorkspaceName('reviewer'), CREW_WORKSPACE_REVIEW);
  assert.equal(crewWorkspaceName('review'), CREW_WORKSPACE_REVIEW);
  assert.equal(isCrewWorkspaceName(CREW_WORKSPACE_WORKER), true);
  assert.equal(isCrewWorkspaceName(CREW_WORKSPACE_REVIEW), true);
  assert.equal(isCrewWorkspaceName('Crew_20260917_120000_worker'), false, 'the old per-job shape is not a stable workspace');
});

test('two projects never share a workspace path', () => {
  const a = crewProjectKey('/home/u/alpha');
  const b = crewProjectKey('/home/u/beta');
  assert.notEqual(a, b, 'different repositories must not collide');
  assert.match(a, /^dsh-crew-alpha-[0-9a-f]{8}$/);

  // Same leaf name, different parents: the identity is the whole path.
  assert.notEqual(crewProjectKey('/one/app'), crewProjectKey('/two/app'));

  // ...and it is stable for the same path.
  assert.equal(crewProjectKey('/home/u/alpha'), a);

  assert.equal(
    crewWorkspacePath({ repoRoot: '/home/u/alpha', role: 'worker', root: '/root' }),
    join(resolve('/root'), a, 'dsh-crew-worker'),
  );
  assert.notEqual(
    crewWorkspacePath({ repoRoot: '/home/u/alpha', role: 'worker', root: '/root' }),
    crewWorkspacePath({ repoRoot: '/home/u/alpha', role: 'reviewer', root: '/root' }),
  );
});

test('the lock sits beside the workspace, not inside the tree', () => {
  const lockPath = crewWorkspaceLockPath({ repoRoot: '/home/u/alpha', role: 'worker', root: '/root' });
  const workspacePath = crewWorkspacePath({ repoRoot: '/home/u/alpha', role: 'worker', root: '/root' });
  assert.equal(lockPath.startsWith(workspacePath), false, 'a lock inside the tree would pollute the diffs it protects');
  assert.match(lockPath.replace(/\\/g, '/'), /\.locks\/dsh-crew-worker\.lock$/);
});

// ---------- the lock ----------

test('a held lock is waited for and then refused, never taken by force', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-lock-'));
  const lockPath = join(dir, 'workspace.lock');
  const held = await acquireWorkspaceLock({ lockPath, purpose: 'first' });
  assert.equal(held.ok, true);

  const refused = await acquireWorkspaceLock({
    lockPath, purpose: 'second', waitMs: 0, isAlive: () => true,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, WORKSPACE_BUSY);
  assert.match(refused.error, /held by another job/);
  assert.equal(refused.holder.purpose, 'first');

  held.release();
  const next = await acquireWorkspaceLock({ lockPath, purpose: 'third' });
  assert.equal(next.ok, true, 'releasing frees it for the next job');
  next.release();
  rmSync(dir, { recursive: true, force: true });
});

test('a lock whose owner is gone is reclaimed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-lock-stale-'));
  const lockPath = join(dir, 'workspace.lock');
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: 1, pid: 999999, purpose: 'dead', nonce: 'x', startedAt: Date.now() })}\n`);

  const taken = await acquireWorkspaceLock({ lockPath, isAlive: () => false });
  assert.equal(taken.ok, true, 'a dead holder must not block the workspace forever');
  taken.release();
  rmSync(dir, { recursive: true, force: true });
});

test('a lock held past any plausible job is reclaimed even if the pid looks alive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-lock-old-'));
  const lockPath = join(dir, 'workspace.lock');
  mkdirSync(dir, { recursive: true });
  const startedAt = 1_000_000;
  writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, purpose: 'zombie', nonce: 'x', startedAt })}\n`);

  const taken = await acquireWorkspaceLock({
    lockPath, isAlive: () => true, now: () => startedAt + DEFAULT_LOCK_MAX_HOLD_MS + 1,
  });
  assert.equal(taken.ok, true);
  taken.release();
  rmSync(dir, { recursive: true, force: true });
});

test('the backstop outlives the longest permitted job, and not by much', () => {
  // Too short and a live job loses its own workspace; too long and a lock left by
  // a job that ended without releasing stalls it for hours. timeout_seconds is
  // capped at two hours, so the bound belongs just above that.
  const MAX_ATTEMPT_MS = 7200 * 1000;
  assert.ok(DEFAULT_LOCK_MAX_HOLD_MS > MAX_ATTEMPT_MS, 'a live job must never lose its workspace');
  assert.ok(DEFAULT_LOCK_MAX_HOLD_MS <= MAX_ATTEMPT_MS * 2, 'and a leaked lock must not stall for half a day');
});

test('release only drops the lock this call created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-lock-owner-'));
  const lockPath = join(dir, 'workspace.lock');
  const first = await acquireWorkspaceLock({ lockPath, purpose: 'first' });
  assert.equal(first.ok, true);
  // A stale holder waking up after its lock was reclaimed must not delete the
  // successor's lock.
  writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: 1, pid: 1, purpose: 'second', nonce: 'other', startedAt: Date.now() })}\n`);
  assert.equal(first.release(), false, 'a lock it no longer owns is left alone');
  assert.equal(existsSync(lockPath), true);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- ensure: create, reuse, reset ----------

test('the workspace is created once and reused, and each job starts from its base revision', { skip: !gitAvailable() }, async (t) => {
  const repoRoot = repo(t);
  const root = worktreeRoot(t);

  const first = await ensureCrewWorkspace({ cwd: repoRoot, role: 'worker', root });
  assert.equal(first.ok, true, first.error ?? '');
  assert.equal(first.reused, false, 'the first job creates it');
  assert.equal(first.worktreePath, crewWorkspacePath({ repoRoot: first.repoRoot, role: 'worker', root }));
  assert.equal(existsSync(join(first.worktreePath, 'README.md')), true, 'a real worktree of the repo');
  releaseCrewWorkspace(first);

  // The first job leaves work behind — tracked edit and an untracked file.
  writeFileSync(join(first.worktreePath, 'README.md'), 'changed by job one\n');
  writeFileSync(join(first.worktreePath, 'leftover.txt'), 'scratch\n');

  const second = await ensureCrewWorkspace({ cwd: repoRoot, role: 'worker', root });
  assert.equal(second.ok, true, second.error ?? '');
  assert.equal(second.worktreePath, first.worktreePath, 'the same workspace, so sessions keep grouping there');
  assert.equal(second.reused, true);
  releaseCrewWorkspace(second);

  assert.equal(readFileSync(join(second.worktreePath, 'README.md'), 'utf8'), 'first\n', 'a job must not inherit the last one\'s edit');
  assert.equal(existsSync(join(second.worktreePath, 'leftover.txt')), false, 'nor its untracked files');

  // The workspace survives the job: it is the directory the sessions belong to.
  assert.equal(existsSync(second.worktreePath), true);
});

test('the reviewer gets the other workspace and the two never mix', { skip: !gitAvailable() }, async (t) => {
  const repoRoot = repo(t);
  const root = worktreeRoot(t);

  const worker = await ensureCrewWorkspace({ cwd: repoRoot, role: 'worker', root });
  const review = await ensureCrewWorkspace({ cwd: repoRoot, role: 'reviewer', root });
  assert.equal(worker.ok && review.ok, true);
  assert.notEqual(worker.worktreePath, review.worktreePath);
  assert.match(review.worktreePath.replace(/\\/g, '/'), /dsh-crew-review$/);
  releaseCrewWorkspace(worker);
  releaseCrewWorkspace(review);
});

test('a directory Crew did not create is refused, not deleted', { skip: !gitAvailable() }, async (t) => {
  const repoRoot = repo(t);
  const root = worktreeRoot(t);
  // Place an unowned directory exactly where the workspace would go.
  const target = crewWorkspacePath({ repoRoot, role: 'worker', root });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'someone-elses-file.txt'), 'do not delete me\n');

  const res = await ensureCrewWorkspace({ cwd: repoRoot, role: 'worker', root });
  assert.equal(res.ok, false);
  assert.equal(res.reason, WORKSPACE_CONFLICT);
  assert.match(res.error, /not a Crew worktree/);
  assert.equal(readFileSync(join(target, 'someone-elses-file.txt'), 'utf8'), 'do not delete me\n', 'the foreign directory is untouched');
});

test('a busy workspace fails closed with a clear reason instead of running anyway', { skip: !gitAvailable() }, async (t) => {
  const repoRoot = repo(t);
  const root = worktreeRoot(t);

  const held = await ensureCrewWorkspace({ cwd: repoRoot, role: 'worker', root });
  assert.equal(held.ok, true);
  // The lock is held for the whole job, so a second job finds it taken.
  const second = await ensureCrewWorkspace({ cwd: repoRoot, role: 'worker', root, lockWaitMs: 0, isAlive: () => true });
  assert.equal(second.ok, false);
  assert.equal(second.reason, WORKSPACE_BUSY);

  releaseCrewWorkspace(held);
  const third = await ensureCrewWorkspace({ cwd: repoRoot, role: 'worker', root, lockWaitMs: 0 });
  assert.equal(third.ok, true, 'the lock is released when the job ends');
  releaseCrewWorkspace(third);
});

test('a non-git directory is refused the same way per-job isolation refuses it', { skip: !gitAvailable() }, async (t) => {
  const plain = mkdtempSync(join(tmpdir(), 'crew-ws-plain-'));
  const root = worktreeRoot(t);
  t.after(() => rmSync(plain, { recursive: true, force: true }));

  const res = await ensureCrewWorkspace({ cwd: plain, role: 'worker', root });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'NOT_GIT_REPOSITORY');
});
