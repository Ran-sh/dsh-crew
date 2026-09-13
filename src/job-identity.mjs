// The one name a Crew job is known by.
//
// A job has three identities an operator sees: the worktree directory, the
// conversation the Harness lists in its workspace panel, and whatever the host
// integration shows. Each of them is derived from something different — the
// worktree from the name Crew allocates, the conversation from the opening words
// of the first message the agent receives — so they only agree if they are built
// from the same string. This module is that string.
//
// The shape is `Crew_<YYYYMMDD>_<HHMMSS>_<purpose>`, matching the worktree naming
// rule; `src/workspace-isolation.mjs` allocates worktrees in the same shape, and a
// test asserts that every name produced here satisfies its ownership grammar, so
// the two cannot drift apart silently.

export const JOB_NAME_PREFIX = 'Crew_';
export const JOB_PURPOSE_MAX = 32;

export const JOB_NAME_RE = /^Crew_\d{8}_\d{6}_[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:-\d+)?$/;

/** Local wall-clock stamp: readable, and what an operator expects to see. */
export function jobNameStamp(at) {
  const d = at instanceof Date ? at : new Date(at ?? Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** A purpose reduced to something safe to put in a path and a heading. */
export function jobNamePurpose(purpose, max = JOB_PURPOSE_MAX) {
  // Truncate before trimming: trimming first lets the slice end on the separator
  // it just created, and the name then fails the grammar above.
  return String(purpose ?? 'job').replace(/[^A-Za-z0-9]+/g, '-')
    .slice(0, max).replace(/^-+|-+$/g, '') || 'job';
}

/** `Crew_<date>_<time>_<purpose>` for a job starting at `at`. */
export function jobDisplayName({ purpose, at } = {}) {
  return `${JOB_NAME_PREFIX}${jobNameStamp(at)}_${jobNamePurpose(purpose)}`;
}
