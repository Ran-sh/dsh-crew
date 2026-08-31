// Regression tests for Hub cancellation/timeout races around followup delivery.
// Every fake idle promise is explicitly released so RED and GREEN runs stay bounded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRegistry } from '../src/hub/index.mjs';

function makeRegistry(create) {
  return new WorkerRegistry({
    agents: { create: async (spec) => create(spec) },
    sessions: { flush: async () => {} },
    get: () => undefined,
  });
}

function makeRacyHandle(state) {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let released = false;
  const pending = [];
  const releaseIdle = () => {
    released = true;
    while (pending.length > 0) pending.shift()();
  };
  return {
    started,
    releaseIdle,
    handle: {
      agent: {
        session: {},
        whenIdle() {
          markStarted();
          if (released) return Promise.resolve();
          return new Promise((resolve) => pending.push(resolve));
        },
        followup() { state.followups += 1; },
      },
      dispose: async () => { state.disposed += 1; },
    },
  };
}

function makeImmediateHandle(state) {
  return {
    agent: {
      session: {},
      whenIdle: async () => {},
      followup() { state.followups += 1; },
    },
    dispose: async () => { state.disposed += 1; },
  };
}

test('cancel after first idle boundary suppresses followup and disposes once', async () => {
  const state = { followups: 0, disposed: 0 };
  const racy = makeRacyHandle(state);
  const registry = makeRegistry(async () => racy.handle);
  const job = await registry.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/repo' });

  await Promise.race([
    racy.started,
    new Promise((_, reject) => setTimeout(() => reject(new Error('first idle did not start')), 1000)),
  ]);
  await registry.cancel(job.id);
  racy.releaseIdle();
  await Promise.race([
    job.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('cancelled job did not settle')), 1000)),
  ]);

  assert.equal(job.status, 'cancelled');
  assert.equal(state.followups, 0);
  assert.equal(state.disposed, 1);
});

test('timeout after first idle boundary suppresses followup and disposes once', async () => {
  const state = { followups: 0, disposed: 0 };
  const racy = makeRacyHandle(state);
  const registry = makeRegistry(async () => racy.handle);
  const job = await registry.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/repo', timeout_seconds: 1 });

  await Promise.race([
    racy.started,
    new Promise((_, reject) => setTimeout(() => reject(new Error('first idle did not start')), 1000)),
  ]);
  const terminal = await registry.wait(job.id, 2500);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error_code, 'JOB_TIMEOUT');
  racy.releaseIdle();
  await Promise.race([
    job.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed-out job did not settle')), 1000)),
  ]);

  assert.equal(state.followups, 0);
  assert.equal(state.disposed, 1);
});

test('normal successful followup remains delivered exactly once', async () => {
  const state = { followups: 0, disposed: 0 };
  const registry = makeRegistry(async () => makeImmediateHandle(state));
  const job = await registry.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/repo' });
  await job.promise;
  assert.equal(state.followups, 1);
  assert.equal(state.disposed, 1);
});
