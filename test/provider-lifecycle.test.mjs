import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_DELETE_STATES,
  canTransitionProviderDelete,
  planProviderDelete,
  executeProviderDelete,
} from '../src/provider-lifecycle.mjs';

const records = [
  {
    id: 'opencode-go',
    display_name: 'OpenCode Go',
    origin: 'profile-managed',
    ownership: 'crew-managed-profile',
    declaration: { present: true, file: 'profiles/dsh-crew/cordis.patch.yml' },
    lifecycle: { installed: true, configured: true, enabled: true, catalogued: true },
    credential_refs: [{ kind: 'env', name_or_handle: 'OPENCODE_GO_API_KEY', ownership: 'crew' }],
    references: {
      harness_default: true, worker_priority: 0, worker_escalation: null,
      reviewer_priority: 0, active_jobs: 0, multimodal_refs: 0,
    },
    desired_state: 'present',
    activation: 'restart-required',
  },
  {
    id: 'openrouter',
    display_name: 'openrouter',
    origin: 'dynamic',
    ownership: 'dynamic-user',
    declaration: { present: true, file: 'settings.yaml' },
    lifecycle: { installed: true, configured: true, enabled: true, catalogued: true },
    credential_refs: [{ kind: 'env', name_or_handle: 'OPENROUTER_API_KEY', ownership: 'user' }],
    references: {
      harness_default: false, worker_priority: 1, worker_escalation: null,
      reviewer_priority: null, active_jobs: 0, multimodal_refs: 0,
    },
    desired_state: 'present',
    activation: 'restart-required',
  },
];

test('provider delete state machine allows only bounded lifecycle transitions', () => {
  assert.deepEqual(PROVIDER_DELETE_STATES, [
    'PLANNED', 'BLOCKED', 'APPLIED', 'RESTART_PENDING', 'VERIFYING',
    'VERIFIED', 'ROLLBACK_PENDING', 'ROLLED_BACK', 'FAILED',
  ]);
  assert.equal(canTransitionProviderDelete('PLANNED', 'APPLIED'), true);
  assert.equal(canTransitionProviderDelete('APPLIED', 'RESTART_PENDING'), true);
  assert.equal(canTransitionProviderDelete('VERIFIED', 'ROLLED_BACK'), false);
  assert.equal(canTransitionProviderDelete('FAILED', 'VERIFIED'), false);
});

test('delete plan fails closed for built-in, in-use, and default providers', () => {
  const builtin = planProviderDelete({
    providerId: 'deepseek-official',
    inventory: { records: [{ ...records[0], id: 'deepseek-official', ownership: 'harness', origin: 'builtin' }] },
    replacementDefault: 'openrouter',
  });
  assert.equal(builtin.ok, false);
  assert.equal(builtin.code, 'PROVIDER_OWNERSHIP_AMBIGUOUS');

  const inUse = planProviderDelete({
    providerId: 'openrouter', inventory: { records }, activeJobs: [{ provider: 'openrouter' }],
  });
  assert.equal(inUse.ok, false);
  assert.equal(inUse.code, 'PROVIDER_IN_USE');

  const defaultWithoutReplacement = planProviderDelete({
    providerId: 'opencode-go', inventory: { records },
  });
  assert.equal(defaultWithoutReplacement.ok, false);
  assert.equal(defaultWithoutReplacement.code, 'PROVIDER_DEFAULT_REPLACEMENT_REQUIRED');
});

test('delete plan records impact and sanitized credential references', () => {
  const result = planProviderDelete({
    providerId: 'opencode-go',
    inventory: { records },
    replacementDefault: 'openrouter',
    expectedRevision: 'a'.repeat(64),
  });
  assert.equal(result.ok, true);
  assert.match(result.plan.plan_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result.plan.will_remove, [
    'profile declaration', 'runtime desired registration',
    'worker priority references', 'reviewer priority references',
    'Harness Default reference', 'cache/health state',
  ]);
  assert.deepEqual(result.plan.credential_refs, [{
    kind: 'env', name_or_handle: 'OPENCODE_GO_API_KEY', ownership: 'crew',
  }]);
  assert.equal(JSON.stringify(result).includes('value'), false);
  assert.equal(result.plan.restart_required, true);
  assert.equal(result.plan.rollback.credentials_included, false);
});

test('delete transaction reaches VERIFIED only after restart and absence evidence', async () => {
  const calls = [];
  const plan = planProviderDelete({
    providerId: 'opencode-go', inventory: { records }, replacementDefault: 'openrouter',
  }).plan;
  const result = await executeProviderDelete(plan, {
    backup: async () => calls.push('backup'),
    markTombstone: async () => calls.push('tombstone'),
    scrubReferences: async () => calls.push('scrub'),
    removeDeclarations: async () => calls.push('declarations'),
    restart: async () => { calls.push('restart'); return { ok: true }; },
    verify: async () => { calls.push('verify'); return { providerAbsent: true, routingClear: true, tombstonePresent: true }; },
  });
  assert.equal(result.state, 'VERIFIED');
  assert.deepEqual(calls, ['backup', 'tombstone', 'scrub', 'declarations', 'restart', 'verify']);
  assert.equal(result.error_code, null);
});

test('delete transaction fails closed when restart or verification is incomplete', async () => {
  const plan = planProviderDelete({
    providerId: 'opencode-go', inventory: { records }, replacementDefault: 'openrouter',
  }).plan;
  const failedRestart = await executeProviderDelete(plan, {
    backup: async () => {}, markTombstone: async () => {}, scrubReferences: async () => {},
    removeDeclarations: async () => {}, restart: async () => ({ ok: false, code: 'CREW_BACKEND_START_TIMEOUT' }),
  });
  assert.equal(failedRestart.state, 'FAILED');
  assert.equal(failedRestart.error_code, 'CREW_BACKEND_START_TIMEOUT');

  const failedVerify = await executeProviderDelete(plan, {
    backup: async () => {}, markTombstone: async () => {}, scrubReferences: async () => {},
    removeDeclarations: async () => {}, restart: async () => ({ ok: true }),
    verify: async () => ({ providerAbsent: true, routingClear: false, tombstonePresent: true }),
  });
  assert.equal(failedVerify.state, 'FAILED');
  assert.equal(failedVerify.error_code, 'PROVIDER_DELETE_VERIFY_FAILED');
});
