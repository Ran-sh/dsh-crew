// P2 hardening tests from the v0.5.6 advisory review:
//
//   - timed-out long-poll waiters must unregister themselves (hub, workflow);
//   - status shards must publish atomically with no temp residue;
//   - custom CLI providers must fail closed on Windows with a precise error;
//   - the shared local-request guard keeps the hub/bridge Origin policies
//     distinct on purpose (hub: any loopback origin; bridge: exact authority).
//
// Run with: node --test test/local-surface-hardening.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WorkerRegistry } from '../src/hub/index.mjs';
import { createWorkflowRuntime } from '../src/workflow-runtime.mjs';
import { createShardWriter, readMergedStatus } from '../src/status-shard.mjs';
import { CUSTOM_CLI_UNSUPPORTED, customCliInvocation } from '../src/multimodal.mjs';
import { isLoopbackRequest } from '../src/hub/index.mjs';
import { isTrustedLocalRequest } from '../src/official-web-bridge.mjs';
import { normalizeGlobalConfig } from '../src/policy.mjs';

// ---------- waiter cleanup ----------

function makePendingRegistry() {
  return new WorkerRegistry({
    agents: { create: () => new Promise(() => {}) },
    sessions: { flush: async () => {} },
    get: (key) => key === 'loader' ? { await: async () => {} } : undefined,
  });
}

test('repeated timed-out hub waits leave no registered waiters behind', async () => {
  const reg = makePendingRegistry();
  const job = await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/repo' });
  for (let i = 0; i < 3; i++) await reg.wait(job.id, 20);
  assert.equal(reg.jobs.get(job.id).waiters.length, 0, 'timed-out waiters must unregister');
  await reg.cancel(job.id);
  assert.equal(reg.jobs.get(job.id).waiters.length, 0);
});

test('repeated timed-out workflow waits leave no registered waiters behind', async () => {
  let releaseAttempt;
  const adapter = {
    executeAttempt: (spec) => new Promise((resolve) => { releaseAttempt = () => resolve({ id: 'w1', role: 'worker', attempt: spec.attempt, provider: 'p', model: 'm', selection_source: 'policy', status: 'done', result: 'x', stopReason: 'completed' }); }),
    cancelAttempt: async () => { releaseAttempt?.(); },
    allocateWorkspace: async (spec) => ({ ok: true, execution_cwd: spec.cwd, base_revision: 'abc', isolation: 'shared', primary_workspace_dirty: false, handle: null }),
    captureCandidate: async () => null,
    releaseWorkspace: async () => ({ ok: true }),
    buildReviewTask: (t) => `review: ${t}`,
    getConfig: () => normalizeGlobalConfig({}),
  };
  const rt = createWorkflowRuntime(adapter, { idFactory: () => `wf-hardening-${Date.now()}` });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 'test' });
  for (let i = 0; i < 3; i++) await rt.wait(job.id, 20);
  assert.equal(job.waiters.length, 0, 'timed-out waiters must unregister');
  await rt.cancel(job.id);
  assert.equal(job.waiters.length, 0);
});

// ---------- status shard durability ----------

test('shard publish is atomic: valid JSON, no temp residue, disposable', () => {
  const w = createShardWriter('test-hardening');
  const file = join(homedir(), '.config', 'dsh-crew', 'status.d', `${w.writer}.json`);
  try {
    w.publish([{ id: 'j1' }, { id: 'j2' }]);
    const shard = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(shard.writer, w.writer);
    assert.equal(shard.jobs.length, 2);
    const merged = readMergedStatus({ excludeWriter: w.writer });
    assert.ok(!merged.some((j) => j.origin === w.writer), 'excluded writer must not merge');
    const temps = readdirSync(join(homedir(), '.config', 'dsh-crew', 'status.d')).filter((f) => f.startsWith(w.writer) && f.includes('.tmp-'));
    assert.equal(temps.length, 0, 'no temp files may survive a publish');
  } finally {
    w.dispose();
  }
  assert.equal(existsSync(file), false, 'dispose must remove the shard');
});

// ---------- custom CLI platform gate ----------

test('custom CLI providers fail closed on Windows with a precise error', () => {
  const win = customCliInvocation('tool --run {image}', { platform: 'win32' });
  assert.equal(win.ok, false);
  assert.equal(win.error.code, CUSTOM_CLI_UNSUPPORTED);
  assert.ok(win.error.message.length > 10);
  const posix = customCliInvocation('tool --run {image}', { platform: 'linux' });
  assert.deepEqual(posix, { ok: true, file: '/bin/bash', args: ['-lc', 'tool --run {image}'] });
});

// ---------- shared local-request guard: hub vs bridge Origin policies ----------

function request(headers, remoteAddress = '127.0.0.1') {
  return { socket: { remoteAddress }, headers };
}

test('hub accepts any loopback origin; bridge requires exact authority', () => {
  const crossPort = request({ host: '127.0.0.1:3210', origin: 'http://127.0.0.1:3080' });
  assert.equal(isLoopbackRequest(crossPort), true, '3080 panel calls the hub cross-port');
  assert.equal(isTrustedLocalRequest(crossPort), false, 'bridge only serves its own origin');

  const sameAuthority = request({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' });
  assert.equal(isTrustedLocalRequest(sameAuthority), true);

  const rebinding = request({ host: 'evil.example:3210' });
  assert.equal(isLoopbackRequest(rebinding), false);
  assert.equal(isTrustedLocalRequest(rebinding), false);

  const evilOrigin = request({ host: '127.0.0.1:3210', origin: 'https://evil.example' });
  assert.equal(isLoopbackRequest(evilOrigin), false);
  assert.equal(isTrustedLocalRequest(evilOrigin), false);

  const mapped = request({ host: '127.0.0.1:3210' }, '::ffff:127.0.0.1');
  assert.equal(isLoopbackRequest(mapped), true, 'IPv4-mapped loopback peers are local');
  assert.equal(isTrustedLocalRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { host: '127.0.0.1:3080' } }), true);
});
