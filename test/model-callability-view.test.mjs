import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCallabilityState } from '../src/client/model-callability-view.mjs';
import { READINESS_STATES } from '../src/client/host-readiness.mjs';

test('client maps only the server model_callability projection', () => {
  const now = Date.now();
  const runtime = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'r1' };
  const callable = {
    schema_version: 2, captured_at: now, expires_at: now + 10_000, current_runtime_id: 'r1',
    runtime_identity: runtime,
    enabled_roles: { worker: true, reviewer: false },
    roles: { worker: { state: 'CALLABLE' }, reviewer: { state: 'NOT_APPLICABLE' } }, overall: 'CALLABLE',
  };
  assert.equal(modelCallabilityState(callable, runtime, now), READINESS_STATES.READY);
  assert.equal(modelCallabilityState({ ...callable, schema_version: 1 }, runtime, now), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState({ ...callable, expires_at: now - 1 }, runtime, now), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState(callable, { ...runtime, execution_plane: 'official-bridge' }, now), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState({ ...callable, overall: 'NOT_CALLABLE', roles: { worker: { state: 'NOT_CALLABLE', expires_at: now + 5_000 }, reviewer: { state: 'NOT_APPLICABLE' } } }, runtime, now), READINESS_STATES.UNAVAILABLE);
  assert.equal(modelCallabilityState({ ...callable, overall: 'NOT_CALLABLE', roles: { worker: { state: 'NOT_CALLABLE', expires_at: now - 1 }, reviewer: { state: 'NOT_APPLICABLE' } } }, runtime, now), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState({ ...callable, overall: 'STALE' }, runtime, now), READINESS_STATES.DEGRADED);
  assert.equal(modelCallabilityState({ ...callable, overall: 'UNKNOWN' }, runtime, now), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState({ ...callable, roles: { ...callable.roles, reviewer: { state: 'NOT_CALLABLE' } } }, runtime, now), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState({ readiness_matrix: { rows: [{ id: 'model_execution', status: 'PASS' }] } }), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState(null), READINESS_STATES.UNKNOWN);
});
