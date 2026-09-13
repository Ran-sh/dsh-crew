// The coordinated-update runtime lifecycle, as one ordered state machine.
//
// The update transaction stops the owned 3210, swaps its runtime tree, starts
// the candidate, verifies a dual identity and only then moves the release
// pointer. Every one of those steps can be interrupted by a crash or a power
// loss, and what recovery is allowed to do afterwards depends entirely on how
// far the transaction got — in particular on whether a start *may* already have
// happened, because replacing a runtime tree under a live process is the damage
// this whole path exists to avoid.
//
// That question used to be answered by a state written at the last moment
// before the start, which left the earlier part of the transaction implicit:
// "no state recorded" and "state recorded but nothing done yet" were the same
// thing, and there was no name at all for the committed end. This module names
// all five checkpoints and rejects any write that would skip or rewind one, so
// the journal on disk is always a record of a transaction that actually
// followed this order.

export const RUNTIME_LIFECYCLE_STATES = Object.freeze([
  'before-stop', // Intent is journaled; the owned runtime has not been touched.
  'stopped', // A durable maintenance window is open; mutating the tree is authorized.
  'restarted', // A start has been INITIATED — written before the start call, so a
  //             crash in flight is indistinguishable from a completed start.
  //             That ambiguity is deliberate: it is the safe direction, and it
  //             means "the live runtime may already be the candidate".
  'verified', // Candidate is running and its dual identity checked out.
  'committed', // Release pointer moved. Terminal.
]);

// Exactly one forward edge is legal between neighbouring checkpoints. A
// multi-step jump would describe work that never recorded its intermediate
// proof, and a rewind would rewrite history recovery has already acted on.
export const RUNTIME_LIFECYCLE_TRANSITIONS = Object.freeze({
  'before-stop': Object.freeze(['stopped']),
  stopped: Object.freeze(['restarted']),
  restarted: Object.freeze(['verified']),
  verified: Object.freeze(['committed']),
  committed: Object.freeze([]),
});

// Journals written by earlier versions used different names for the first two
// checkpoints. They are read, never written.
const LEGACY_RUNTIME_STATES = Object.freeze({ staged: 'before-stop', starting: 'restarted' });

export function normalizeRuntimeState(state) {
  if (typeof state !== 'string' || state === '') return null;
  const mapped = LEGACY_RUNTIME_STATES[state] ?? state;
  return RUNTIME_LIFECYCLE_STATES.includes(mapped) ? mapped : null;
}

export function runtimeLifecycleIndex(state) {
  const normalized = normalizeRuntimeState(state);
  return normalized === null ? -1 : RUNTIME_LIFECYCLE_STATES.indexOf(normalized);
}

// The only question recovery must never get wrong. Anything from `restarted`
// onward means a start was initiated; `before-stop` and `stopped` mean the
// candidate tree has never been handed to a process.
export function runtimeStateMayHaveStarted(state) {
  return runtimeLifecycleIndex(state) >= RUNTIME_LIFECYCLE_STATES.indexOf('restarted');
}

export function canAdvanceRuntimeState(from, to) {
  const current = normalizeRuntimeState(from);
  const next = normalizeRuntimeState(to);
  if (current === null || next === null) return false;
  return RUNTIME_LIFECYCLE_TRANSITIONS[current].includes(next);
}

export function checkRuntimeAdvance(from, to) {
  const current = normalizeRuntimeState(from);
  const next = normalizeRuntimeState(to);
  if (current === null) {
    return { ok: false, code: 'RUNTIME_LIFECYCLE_UNKNOWN_STATE', error: `unrecognized runtime lifecycle state ${JSON.stringify(from)}` };
  }
  if (next === null) {
    return { ok: false, code: 'RUNTIME_LIFECYCLE_UNKNOWN_STATE', error: `unrecognized runtime lifecycle state ${JSON.stringify(to)}` };
  }
  if (!RUNTIME_LIFECYCLE_TRANSITIONS[current].includes(next)) {
    return {
      ok: false,
      code: 'RUNTIME_LIFECYCLE_INVALID_TRANSITION',
      error: `runtime lifecycle cannot go ${current} -> ${next}`,
    };
  }
  return { ok: true, from: current, to: next };
}
