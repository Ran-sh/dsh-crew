import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCallabilityState } from '../src/client/model-callability-view.mjs';
import { READINESS_STATES } from '../src/client/host-readiness.mjs';

test('client maps only the server model_callability projection', () => {
  const now = Date.now();
  const callable = {
    schema_version: 1, captured_at: now, expires_at: now + 10_000, current_runtime_id: 'r1',
    enabled_roles: { worker: true, reviewer: false },
    roles: { worker: { state: 'CALLABLE' }, reviewer: { state: 'NOT_APPLICABLE' } }, overall: 'CALLABLE',
  };
  assert.equal(modelCallabilityState(callable, { runtime_id: 'r1' }, now), READINESS_STATES.READY);
  assert.equal(modelCallabilityState({ ...callable, expires_at: now - 1 }, { runtime_id: 'r1' }, now), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState(callable, { runtime_id: 'different' }, now), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState({ ...callable, overall: 'NOT_CALLABLE' }, { runtime_id: 'r1' }, now), READINESS_STATES.UNAVAILABLE);
  assert.equal(modelCallabilityState({ ...callable, overall: 'STALE' }, { runtime_id: 'r1' }, now), READINESS_STATES.DEGRADED);
  assert.equal(modelCallabilityState({ ...callable, overall: 'UNKNOWN' }, { runtime_id: 'r1' }, now), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState({ readiness_matrix: { rows: [{ id: 'model_execution', status: 'PASS' }] } }), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState(null), READINESS_STATES.UNKNOWN);
});
