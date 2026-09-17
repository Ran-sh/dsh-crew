// One job at a time per Crew workspace.
//
// A stable workspace is shared by every job that uses it, which is the point —
// the sessions group under one directory instead of multiplying. The cost is
// that two jobs running in it at once would corrupt each other's evidence: the
// client only captures a candidate for `worktree` isolation, the Hub diffs the
// whole tree before and after and would attribute a concurrent job's edits to
// this one, and the reviewer's before/after fingerprint would see the other
// job's writes as a mutated candidate and force `request_changes`. Nothing in
// the runtime serialised by directory before, so this does.
//
// The lock lives beside the workspace, never inside it: a file in the tree would
// show up in the very diffs it is there to keep clean.
//
// It fails closed. A holder that died leaves a lock behind, so an obviously
// abandoned one (its process is gone, or it has held the lock past any plausible
// job) is reclaimed; but a lock whose owner still looks alive is waited for and
// then refused with `WORKSPACE_BUSY`, never taken by force. Waiting is bounded,
// and the bound is part of the caller's attempt budget.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const WORKSPACE_BUSY = 'WORKSPACE_BUSY';
const WORKSPACE_LOCK_SCHEMA = 1;

export const DEFAULT_LOCK_WAIT_MS = 120_000;
const DEFAULT_LOCK_POLL_MS = 500;
// The two reasons a lock outlives its job are not the same, and they are covered
// by different things. A holder whose process died is caught immediately by the
// pid check below. This bound covers the other case — the process is alive but
// the job is gone, which is what a job that ended without releasing looks like —
// and it is only a backstop, so it wants to be as short as it can safely be.
//
// It must still exceed the longest a job may legitimately run, or a live job
// would lose its own workspace: `timeout_seconds` is capped at 2h, so this is
// that plus half an hour of margin. Six hours, the first value here, would have
// stalled a workspace for four hours longer than any job can last.
export const DEFAULT_LOCK_MAX_HOLD_MS = (2 * 60 + 30) * 60 * 1000;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Is a process with this pid running? Unknown pids read as dead. */
function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else; ESRCH means it is gone.
    return error?.code === 'EPERM';
  }
}

function readRecord(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Acquire the workspace lock, waiting up to `waitMs` for a live holder.
 *
 * Returns `{ ok: true, release }` or `{ ok: false, reason, error, holder }`.
 * `release` only removes the lock this call created: after a reclaim, a stale
 * holder waking up must not delete its successor's lock.
 */
export async function acquireWorkspaceLock({
  lockPath,
  purpose = null,
  waitMs = DEFAULT_LOCK_WAIT_MS,
  pollMs = DEFAULT_LOCK_POLL_MS,
  maxHoldMs = DEFAULT_LOCK_MAX_HOLD_MS,
  pid = process.pid,
  now = Date.now,
  sleep = defaultSleep,
  isAlive = defaultIsAlive,
} = {}) {
  if (typeof lockPath !== 'string' || lockPath === '') {
    return { ok: false, reason: WORKSPACE_BUSY, error: 'workspace lock requires a path' };
  }
  const deadline = now() + Math.max(0, waitMs);
  const nonce = randomBytes(16).toString('hex');

  for (;;) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, `${JSON.stringify({
        schemaVersion: WORKSPACE_LOCK_SCHEMA,
        pid,
        purpose,
        nonce,
        startedAt: now(),
      })}\n`, { flag: 'wx' });
      return {
        ok: true,
        release: () => {
          const held = readRecord(lockPath);
          if (held?.nonce !== nonce) return false;
          try { rmSync(lockPath, { force: true }); return true; } catch { return false; }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: WORKSPACE_BUSY, error: `cannot take workspace lock: ${error?.message ?? error}` };
      }
    }

    const holder = readRecord(lockPath);
    const startedAt = Number.isFinite(holder?.startedAt) ? holder.startedAt : null;
    const abandoned = holder === null
      || !isAlive(holder.pid)
      || (startedAt !== null && now() - startedAt > maxHoldMs);
    if (abandoned) {
      // Reclaim and loop: the exclusive create on the next pass decides the
      // race, so two waiters cannot both take it.
      try { rmSync(lockPath, { force: true }); } catch { /* the retry decides */ }
      continue;
    }
    if (now() >= deadline) {
      return {
        ok: false,
        reason: WORKSPACE_BUSY,
        error: `workspace is held by another job (pid ${holder.pid}${holder.purpose ? `, ${holder.purpose}` : ''})`,
        holder,
      };
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}
