import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeReadinessSnapshot, reprojectRuntimeModelCallability } from '../src/runtime-readiness-snapshot.mjs';
import { createProviderHealthStore } from '../src/provider-health.mjs';

const matrix = { rows: [
  { id: 'hub_compatibility', status: 'PASS', reason_code: 'LIVE_CHECK_PASSED' },
  { id: 'provider_lifecycle_consistent', status: 'PASS', reason_code: 'PROVIDER_LIFECYCLE_CONSISTENT' },
], summary: { PASS: 2 } };

test('runtime readiness snapshot centralizes provenance, selections, health and matrix', () => {
  const snapshot = buildRuntimeReadinessSnapshot({
    runtime: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1', capabilities: ['jobs'] },
    readinessMatrix: matrix,
    selections: { worker: { provider: 'opencode-muse', model: 'mimo-v2.5', source: 'priority' } },
    health: [{ provider: 'opencode-muse', model: 'mimo-v2.5', state: 'callable', fresh: true, observed_at: 9_000, expires_at: 20_000 }],
    jobs: [{ id: 'job-1', role: 'worker', task: 'SECRET TASK', result: 'SECRET RESULT' }],
    now: 10_000,
  });
  assert.equal(snapshot.schema_version, 1);
  assert.equal(typeof snapshot.captured_at, 'number');
  assert.equal(snapshot.expires_at, 20_000);
  assert.equal(snapshot.model_callability.roles.worker.state, 'CALLABLE');
  assert.deepEqual(snapshot.runtime, { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' });
  assert.deepEqual(snapshot.runtime_identity, { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' });
  assert.deepEqual(snapshot.model_callability.runtime_identity, snapshot.runtime_identity);
  assert.deepEqual(snapshot.worker.selected, { provider: 'opencode-muse', model: 'mimo-v2.5', source: 'priority' });
  assert.deepEqual(snapshot.worker.health, [{ provider: 'opencode-muse', model: 'mimo-v2.5', state: 'callable', observed_at: 9_000, expires_at: 20_000, fresh: true }]);
  assert.deepEqual(snapshot.readiness_matrix, matrix);
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false);
});

test('runtime readiness snapshot bounds health and ignores foreign runtime provenance', () => {
  const snapshot = buildRuntimeReadinessSnapshot({
    runtime: { execution_plane: 'standalone', profile: 'legacy', listen_port: 3080, runtime_id: 'foreign', secret: 'x' },
    health: Array.from({ length: 300 }, (_, index) => ({ provider: `p-${index}`, model: 'm', state: 'callable', fresh: true })),
  });
  assert.deepEqual(snapshot.runtime, { execution_plane: 'standalone', profile: 'legacy', listen_port: 3080, runtime_id: 'foreign' });
  assert.equal(snapshot.health.length, 128);
  assert.equal(typeof snapshot.captured_at, 'number');
});

test('missing health collection status fails closed over historical success', () => {
  const runtime = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' };
  const snapshot = buildRuntimeReadinessSnapshot({
    runtime,
    selections: { worker: { provider: 'p', model: 'm' } },
    jobs: [{ id: 'job-1', role: 'worker', provider: 'p', model: 'm', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:09.000Z', execution_context: runtime }],
    now: 10_000,
  });
  assert.equal(snapshot.health_status, 'UNKNOWN');
  assert.equal(snapshot.model_callability.roles.worker.state, 'UNKNOWN');
});

test('non-native runtime identity cannot produce callable model evidence', () => {
  const snapshot = buildRuntimeReadinessSnapshot({
    runtime: { execution_plane: 'standalone', profile: 'legacy', listen_port: 3080, runtime_id: 'runtime-foreign' },
    selections: { worker: { provider: 'p', model: 'm' } },
    health: [{ provider: 'p', model: 'm', state: 'callable', fresh: true, observed_at: 9_000, expires_at: 20_000 }],
    now: 10_000,
  });
  assert.equal(snapshot.model_callability.roles.worker.state, 'UNKNOWN');
  assert.notEqual(snapshot.model_callability.overall, 'CALLABLE');
});

test('session role disablement re-projects a Hub snapshot without reviewer blocking Worker', () => {
  const runtime = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' };
  const snapshot = buildRuntimeReadinessSnapshot({
    runtime,
    selections: { worker: { provider: 'p', model: 'worker' }, reviewer: { provider: 'p', model: 'reviewer' } },
    health: [
      { provider: 'p', model: 'worker', state: 'callable', fresh: true, observed_at: 9_000, expires_at: 20_000 },
      { provider: 'p', model: 'reviewer', state: 'quota-exhausted', fresh: true, observed_at: 9_000, expires_at: 20_000 },
    ],
    enabled_roles: { worker: true, reviewer: true },
    now: 10_000,
  });
  const projected = reprojectRuntimeModelCallability(snapshot, { enabled_roles: { worker: true, reviewer: false }, now: 10_000 });
  assert.equal(projected.overall, 'CALLABLE');
  assert.equal(projected.roles.reviewer.state, 'NOT_APPLICABLE');
});

test('session re-projection preserves bounded same-runtime execution evidence', () => {
  const runtime = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' };
  const snapshot = buildRuntimeReadinessSnapshot({
    runtime,
    selections: { worker: { provider: 'p', model: 'worker' } },
    health_status: 'AVAILABLE',
    jobs: [{ id: 'job-1', role: 'worker', provider: 'p', model: 'worker', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:09.000Z', execution_context: runtime }],
    enabled_roles: { worker: true, reviewer: false },
    now: 10_000,
  });
  const projected = reprojectRuntimeModelCallability(snapshot, { enabled_roles: { worker: true, reviewer: false }, now: 10_000 });
  assert.equal(projected.roles.worker.state, 'CALLABLE');
  assert.equal(projected.overall, 'CALLABLE');
});

test('health store equal-time failure remains authoritative in the canonical snapshot', () => {
  const runtime = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' };
  const store = createProviderHealthStore({ clock: () => 10_000 });
  store.record('p', 'm', { error: { status: 500 }, observed_at: 9_000 });
  store.record('p', 'm', { ok: true, observed_at: 9_000 });
  const snapshot = buildRuntimeReadinessSnapshot({
    runtime,
    selections: { worker: { provider: 'p', model: 'm' } },
    health: store.list(),
    health_status: 'AVAILABLE',
    jobs: [{ id: 'job-1', role: 'worker', provider: 'p', model: 'm', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:09.000Z', execution_context: runtime }],
    enabled_roles: { worker: true, reviewer: false },
    now: 10_000,
  });
  assert.equal(snapshot.model_callability.roles.worker.state, 'NOT_CALLABLE');
});

test('session re-projection does not transplant or renew execution evidence', () => {
  const runtime = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' };
  const snapshot = buildRuntimeReadinessSnapshot({
    runtime,
    selections: { worker: { provider: 'p1', model: 'm1' } },
    health_status: 'AVAILABLE',
    jobs: [{ id: 'job-1', role: 'worker', provider: 'p1', model: 'm1', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:09.000Z', execution_context: runtime }],
    enabled_roles: { worker: true, reviewer: false },
    now: 10_000,
  });
  snapshot.worker.selected = { provider: 'p2', model: 'm2' };
  const mismatched = reprojectRuntimeModelCallability(snapshot, { enabled_roles: { worker: true, reviewer: false }, now: 10_000 });
  assert.equal(mismatched.roles.worker.state, 'UNKNOWN');
  const expired = structuredClone(snapshot);
  expired.worker.selected = { provider: 'p1', model: 'm1' };
  expired.model_callability.roles.worker.last_success.expires_at = 9_999;
  expired.model_callability.roles.worker.expires_at = 9_999;
  expired.expires_at = 9_999;
  const expiredProjection = reprojectRuntimeModelCallability(expired, { enabled_roles: { worker: true, reviewer: false }, now: 10_000 });
  assert.equal(expiredProjection.roles.worker.state, 'UNKNOWN');
  const malformed = structuredClone(snapshot);
  delete malformed.model_callability.roles.worker.last_success.job_id;
  const malformedProjection = reprojectRuntimeModelCallability(malformed, { enabled_roles: { worker: true, reviewer: false }, now: 10_000 });
  assert.equal(malformedProjection.roles.worker.state, 'UNKNOWN');
});
