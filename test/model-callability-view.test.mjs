import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCallabilityState } from '../src/client/model-callability-view.mjs';
import { READINESS_STATES } from '../src/client/host-readiness.mjs';

test('client maps only the server model_callability projection', () => {
  assert.equal(modelCallabilityState({ overall: 'CALLABLE' }), READINESS_STATES.READY);
  assert.equal(modelCallabilityState({ overall: 'NOT_CALLABLE' }), READINESS_STATES.UNAVAILABLE);
  assert.equal(modelCallabilityState({ overall: 'STALE' }), READINESS_STATES.DEGRADED);
  assert.equal(modelCallabilityState({ overall: 'UNKNOWN' }), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState({ readiness_matrix: { rows: [{ id: 'model_execution', status: 'PASS' }] } }), READINESS_STATES.UNKNOWN);
  assert.equal(modelCallabilityState(null), READINESS_STATES.UNKNOWN);
});
