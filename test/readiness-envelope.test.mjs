import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptReadinessResponse, readinessExpiryDelay } from '../src/client/readiness-envelope.mjs';

const r1 = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'r1' };
const r2 = { ...r1, runtime_id: 'r2' };
const response = (runtime) => ({ ok: true, extension: {
  runtime,
  capabilities: { 'deepseek.worker': true, 'deepseek.reviewer': false },
  readiness_snapshot: {
    runtime,
    captured_at: 1,
    model_callability: {
      schema_version: 2, captured_at: 1, expires_at: null, current_runtime_id: runtime.runtime_id, runtime_identity: runtime,
      enabled_roles: { worker: true, reviewer: false },
      roles: { worker: { state: 'UNKNOWN' }, reviewer: { state: 'NOT_APPLICABLE', reason_code: 'ROLE_DISABLED' } },
      overall: 'UNKNOWN',
    },
  },
} });

test('readiness envelope clears failures, recovers after restart, and ignores delayed responses', () => {
  const first = acceptReadinessResponse(response(r1), { generation: 1, latestGeneration: 1 });
  assert.equal(first.accepted, true);
  assert.equal(first.envelope.runtime.runtime_id, 'r1');

  const failed = acceptReadinessResponse(null, { generation: 2, latestGeneration: 2 });
  assert.deepEqual(failed.envelope, {});

  const recovered = acceptReadinessResponse(response(r2), { generation: 3, latestGeneration: 3 });
  assert.equal(recovered.envelope.runtime.runtime_id, 'r2');

  const delayed = acceptReadinessResponse(response(r1), { generation: 2, latestGeneration: 3 });
  assert.equal(delayed.accepted, false);
  assert.equal(delayed.envelope, null);
});

test('mismatched snapshot identity never becomes an envelope', () => {
  const result = acceptReadinessResponse({ ok: true, extension: { runtime: r1, readiness_snapshot: { runtime: r2 } } }, { generation: 1, latestGeneration: 1 });
  assert.deepEqual(result.envelope, {});
});

test('invalid model projection clears an otherwise identity-valid envelope', () => {
  const invalid = response(r1);
  invalid.extension.readiness_snapshot.model_callability.roles.worker.selected = { provider: {}, model: 42 };
  assert.deepEqual(acceptReadinessResponse(invalid, { generation: 1, latestGeneration: 1 }).envelope, {});
});

test('readiness expiry invalidates a rendered envelope even when polling is pending', () => {
  assert.equal(readinessExpiryDelay(10_000, 9_000), 1_010);
  assert.equal(readinessExpiryDelay(9_000, 10_000), 0);
  assert.equal(readinessExpiryDelay(null, 10_000), null);
});
