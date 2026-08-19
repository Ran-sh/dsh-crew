// Windows path regression tests for WorkerRegistry.spawn: the hub jobs API
// must accept Windows drive-letter absolute paths (D:\..., D:/...) exactly
// like POSIX paths, because the MCP shim on Windows always passes
// process.cwd() in that form. Previously only '/'-prefixed paths passed the
// guard, so every Windows hub dispatch was rejected before reaching the
// worker runtime.
//
// spawn() synchronously validates tier/effort/cwd and returns the job (the
// async run is fire-and-forget inside the promise), so a valid cwd resolves
// with a job object while an invalid cwd rejects with the guard error.
//
// Run with: node --test test/hub-windows.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRegistry } from '../src/hub/index.mjs';

// Minimal ctx: spawn() only needs ctx.get('loader') synchronously; the rest
// of the host API is never reached because the async run catches its own
// failures inside the returned job.
function makeRegistry() {
  return new WorkerRegistry({
    get: (key) => {
      if (key === 'loader') return { await: async () => {} };
      return undefined;
    },
  });
}

const GUARD = 'cwd must be an absolute path';

test('spawn accepts a POSIX absolute cwd (regression baseline)', async () => {
  const reg = makeRegistry();
  const job = await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/home/user/proj' });
  assert.equal(job.tier, 'flash');
  assert.equal(job.cwd, '/home/user/proj');
});

test('spawn accepts a Windows drive cwd with forward slashes (D:/...)', async () => {
  const reg = makeRegistry();
  const job = await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: 'D:/Users/me/proj' });
  assert.equal(job.tier, 'flash');
  assert.equal(job.cwd, 'D:/Users/me/proj');
});

test('spawn accepts a Windows drive cwd with backslashes (D:\\...)', async () => {
  const reg = makeRegistry();
  const job = await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: 'D:\\Users\\me\\proj' });
  assert.equal(job.tier, 'flash');
  assert.equal(job.cwd, 'D:\\Users\\me\\proj');
});

test('spawn accepts a lowercase drive cwd (d:\\...)', async () => {
  const reg = makeRegistry();
  const job = await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: 'd:\\users\\me\\proj' });
  assert.equal(job.tier, 'flash');
});

test('spawn still rejects a relative cwd', async () => {
  const reg = makeRegistry();
  await assert.rejects(
    reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: 'relative/path' }),
    (err) => err.message === GUARD,
  );
});

test('spawn still rejects a missing cwd', async () => {
  const reg = makeRegistry();
  await assert.rejects(
    reg.spawn({ task: 't', tier: 'flash', effort: 'off' }),
    (err) => err.message === GUARD,
  );
});
