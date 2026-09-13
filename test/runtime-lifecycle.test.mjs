import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_LIFECYCLE_STATES,
  RUNTIME_LIFECYCLE_TRANSITIONS,
  canAdvanceRuntimeState,
  checkRuntimeAdvance,
  normalizeRuntimeState,
  runtimeLifecycleIndex,
  runtimeStateMayHaveStarted,
} from '../src/install/runtime-lifecycle.mjs';

test('the lifecycle is the five checkpoints, in order', () => {
  assert.deepEqual([...RUNTIME_LIFECYCLE_STATES], ['before-stop', 'stopped', 'restarted', 'verified', 'committed']);
  assert.deepEqual([...RUNTIME_LIFECYCLE_TRANSITIONS['before-stop']], ['stopped']);
  assert.deepEqual([...RUNTIME_LIFECYCLE_TRANSITIONS.committed], []);
});

test('only the single forward edge between neighbours is legal', () => {
  assert.equal(canAdvanceRuntimeState('before-stop', 'stopped'), true);
  assert.equal(canAdvanceRuntimeState('stopped', 'restarted'), true);
  assert.equal(canAdvanceRuntimeState('restarted', 'verified'), true);
  assert.equal(canAdvanceRuntimeState('verified', 'committed'), true);
  // A jump skips the checkpoint that carries the proof recovery relies on.
  for (const [from, to] of [
    ['before-stop', 'restarted'],
    ['before-stop', 'verified'],
    ['stopped', 'verified'],
    ['stopped', 'committed'],
    ['restarted', 'committed'],
  ]) {
    assert.equal(canAdvanceRuntimeState(from, to), false, `${from} -> ${to} must not be legal`);
  }
  // A rewind would rewrite history recovery has already acted on.
  assert.equal(canAdvanceRuntimeState('verified', 'restarted'), false);
  assert.equal(canAdvanceRuntimeState('stopped', 'before-stop'), false);
  assert.equal(canAdvanceRuntimeState('committed', 'verified'), false);
  assert.equal(canAdvanceRuntimeState('verified', 'verified'), false);
});

test('an unknown state is refused rather than coerced', () => {
  assert.equal(normalizeRuntimeState('mid-flight'), null);
  assert.equal(normalizeRuntimeState(''), null);
  assert.equal(normalizeRuntimeState(undefined), null);
  assert.equal(normalizeRuntimeState(7), null);
  assert.equal(runtimeLifecycleIndex('mid-flight'), -1);
  const checked = checkRuntimeAdvance('verified', 'mid-flight');
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'RUNTIME_LIFECYCLE_UNKNOWN_STATE');
  assert.equal(checkRuntimeAdvance('before-stop', 'stopped').ok, true);
});

test('journals from earlier versions are still read, under their new name', () => {
  // `staged` and `starting` are what 1.10.x wrote. They must keep their meaning
  // so an update that crashes across the upgrade still recovers correctly.
  assert.equal(normalizeRuntimeState('staged'), 'before-stop');
  assert.equal(normalizeRuntimeState('starting'), 'restarted');
  assert.equal(runtimeStateMayHaveStarted('staged'), false);
  assert.equal(runtimeStateMayHaveStarted('starting'), true);
  // A legacy value must not be silently accepted as an edge either.
  assert.equal(canAdvanceRuntimeState('staged', 'restarted'), false);
  assert.equal(canAdvanceRuntimeState('staged', 'stopped'), true);
});

test('may-have-started splits the lifecycle at exactly one point', () => {
  // This is the only question recovery must never get wrong: replacing a
  // runtime tree under a live process is the damage the journal guards.
  assert.deepEqual(
    RUNTIME_LIFECYCLE_STATES.map((s) => runtimeStateMayHaveStarted(s)),
    [false, false, true, true, true],
  );
  assert.equal(runtimeStateMayHaveStarted(undefined), false, 'an absent state means no start was ever recorded');
});
