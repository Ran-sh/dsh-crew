import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModelCallabilityV2 } from '../src/model-callability-contract.mjs';

const now = 10_000;
const runtime = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'r1' };
const base = {
  schema_version: 2, captured_at: now, expires_at: 20_000, current_runtime_id: 'r1', runtime_identity: runtime,
  enabled_roles: { worker: true, reviewer: false },
  roles: {
    worker: { state: 'CALLABLE', selected: { provider: 'p', model: 'm' }, source: 'provider_health', observed_at: 9_000, expires_at: 20_000 },
    reviewer: { state: 'NOT_APPLICABLE', reason_code: 'ROLE_DISABLED' },
  },
  overall: 'CALLABLE',
};

test('schema-v2 validator rejects incomplete, contradictory, and expired role evidence', () => {
  assert.equal(validateModelCallabilityV2({ projection: base, runtime, now }).ok, true);
  for (const projection of [
    { ...base, enabled_roles: { worker: true } },
    { ...base, enabled_roles: { worker: 1, reviewer: false } },
    { ...base, roles: { worker: base.roles.worker } },
    { ...base, roles: { ...base.roles, reviewer: { state: 'UNKNOWN' } } },
    { ...base, roles: { ...base.roles, worker: { ...base.roles.worker, expires_at: 9_999 } } },
    { ...base, roles: { ...base.roles, worker: { ...base.roles.worker, selected: null } } },
    { ...base, roles: { ...base.roles, worker: { ...base.roles.worker, selected: { provider: {}, model: 42 } } } },
    { ...base, overall: 'UNKNOWN' },
  ]) {
    assert.equal(validateModelCallabilityV2({ projection, runtime, now }).ok, false);
  }
});

test('schema-v2 validator enforces configured role enablement and complete runtime', () => {
  assert.equal(validateModelCallabilityV2({ projection: base, runtime, expectedEnabledRoles: { worker: true, reviewer: true }, now }).ok, false);
  assert.equal(validateModelCallabilityV2({ projection: base, runtime, expectedSelections: { worker: { provider: 'other', model: 'm' }, reviewer: null }, now }).ok, false);
  assert.equal(validateModelCallabilityV2({ projection: base, runtime, expectedSelections: { worker: null, reviewer: null }, now }).ok, false);
  assert.equal(validateModelCallabilityV2({ projection: base, runtime: { ...runtime, listen_port: 3080 }, now }).ok, false);
  const disabledRoute = structuredClone(base);
  disabledRoute.roles.reviewer.selected = { provider: 'wrong', model: 'route' };
  assert.equal(validateModelCallabilityV2({ projection: disabledRoute, runtime, expectedSelections: { worker: base.roles.worker.selected, reviewer: null }, now }).ok, false);
  const enabledNotApplicable = structuredClone(base);
  enabledNotApplicable.enabled_roles.reviewer = true;
  enabledNotApplicable.roles.reviewer = { state: 'NOT_APPLICABLE', reason_code: 'ROLE_DISABLED' };
  assert.equal(validateModelCallabilityV2({ projection: enabledNotApplicable, runtime, expectedEnabledRoles: { worker: true, reviewer: true }, expectedSelections: { worker: base.roles.worker.selected, reviewer: null }, now }).ok, false);
});
