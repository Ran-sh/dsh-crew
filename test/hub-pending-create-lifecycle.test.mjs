// Regression coverage for pending agents.create() lifecycle handling.
// The fake create promise is intentionally unresolved; every assertion is bounded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRegistry } from '../src/hub/index.mjs';
import { JOB_PHASES } from '../src/workflow.mjs';

function makeRegistry(create) {
  return new WorkerRegistry({
    agents: { create: async (spec) => create(spec) },
    sessions: { flush: async () => {} },
    get: () => undefined,
  });
}

function deadline(ms, label) {
  return new Promise((resolve) => setTimeout(() => resolve({ timedOut: true, label }), ms));
}

function makeHandle(state) {
  return {
    agent: {
      session: {},
      whenIdle: async () => {},
      followup() { state.followups += 1; },
    },
    dispose: async () => { state.disposed += 1; },
  };
}

test('timeout while agents.create() never settles reaches failed phase and settles job promise', async () => {
  const state = { followups: 0, disposed: 0 };
  const registry = makeRegistry(() => new Promise(() => {}));
  const job = await registry.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/repo', timeout_seconds: 1 });

  const terminal = await registry.wait(job.id, 2500);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.phase, JOB_PHASES.FAILED);
  assert.equal(terminal.error_code, 'JOB_TIMEOUT');
  const settled = await Promise.race([job.promise.then(() => true), deadline(500, 'job promise')]);
  assert.equal(settled, true, settled.label);
  assert.equal(state.followups, 0);
  assert.equal(state.disposed, 0);
});

test('cancel while agents.create() never settles settles job promise without dispatch', async () => {
  const state = { followups: 0, disposed: 0 };
  const registry = makeRegistry(() => new Promise(() => {}));
  const job = await registry.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/repo' });

  await registry.cancel(job.id);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.phase, JOB_PHASES.CANCELLED);
  const settled = await Promise.race([job.promise.then(() => true), deadline(500, 'job promise')]);
  assert.equal(settled, true, settled.label);
  assert.equal(state.followups, 0);
  assert.equal(state.disposed, 0);
});
