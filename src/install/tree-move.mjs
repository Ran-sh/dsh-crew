import { renameSync } from 'node:fs';

/**
 * Rename a directory, absorbing the transient refusal Windows gives for a tree
 * that was just in use.
 *
 * Every runtime-tree move in this codebase happens immediately after the process
 * using that tree was stopped: parking the live cohort, restoring a parked one
 * during recovery, rotating a displaced cohort. On Windows the rename can be
 * refused with EPERM/EACCES for a moment afterwards — a handle another process
 * still holds, an indexer, or the previous child's own teardown — and the same
 * call succeeds a few milliseconds later. Treating the first refusal as fatal
 * turns that timing artifact into a failed upgrade, a failed rollback, or worst
 * of all a recovery that cannot finish.
 *
 * Only the transient codes are retried. A missing source or a cross-device move
 * is not going to become possible on the next attempt, so it is raised at once.
 */
export const TRANSIENT_RENAME_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

export function renameTree(from, to, { rename = renameSync, delays = [0, 40, 120, 300, 700] } = {}) {
  let lastError = null;
  for (const delay of delays) {
    if (delay > 0) {
      const until = Date.now() + delay;
      while (Date.now() < until) { /* bounded wait: this path is not hot */ }
    }
    try {
      rename(from, to);
      return { ok: true };
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_RENAME_CODES.includes(error?.code)) throw error;
    }
  }
  throw lastError;
}
