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
    delete_capability: 'supported',
    declaration_authorities: [{ kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.opencode-go' }],
    models: ['mimo-v2.5'],
    lifecycle: { installed: true, configured: true, enabled: true, catalogued: true },
    credential_refs: [{ kind: 'env', name_or_handle: 'OPENCODE_GO_API_KEY', ownership: 'crew' }],
    references: {
      harness_default: true, harness_default_authority: { kind: 'harness-settings', locator: 'agent-default-model' }, worker_priority: 0, worker_escalation: null,
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
    delete_capability: 'supported',
    declaration_authorities: [{ kind: 'harness-settings', locator: 'llm-pi-ai.providers.openrouter' }],
    models: ['minimax/minimax-m3:free'],
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
  assert.equal(builtin.code, 'PROVIDER_BUILTIN_IMMUTABLE');

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

test('only deepseek-official is immutable and DeepSeek may replace a deleted default', () => {
  const inventory = {
    records: [
      { ...records[0], id: 'deepseek-official', ownership: 'harness', origin: 'builtin', delete_capability: 'immutable-builtin', delete_blocker: 'PROVIDER_BUILTIN_IMMUTABLE', models: ['deepseek-v4-flash'], references: { harness_default: false, active_jobs: 0 } },
      { ...records[0], id: 'opencode-go', references: { ...records[0].references, harness_default: true }, delete_capability: 'supported', declaration_authorities: [{ kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.opencode-go' }] },
    ],
  };
  assert.equal(planProviderDelete({ providerId: 'deepseek-official', inventory, replacementDefault: 'opencode-go' }).code, 'PROVIDER_BUILTIN_IMMUTABLE');
  const plan = planProviderDelete({ providerId: 'opencode-go', inventory, replacementDefault: 'deepseek-official', expectedRevision: 'a'.repeat(64) });
  assert.equal(plan.ok, true);
  assert.equal(plan.plan.replacement_default, 'deepseek-official');
  assert.equal(plan.plan.replacement_default_model, 'deepseek-v4-flash');
});

test('source-unresolved non-official providers fail with a specific lifecycle code', () => {
  const result = planProviderDelete({
    providerId: 'openrouter',
    inventory: { records: [{ ...records[1], id: 'openrouter', ownership: 'unknown', origin: 'unknown', delete_capability: 'source-unresolved', delete_blocker: 'PROVIDER_DELETE_SOURCE_UNRESOLVED' }] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_DELETE_SOURCE_UNRESOLVED');
});

test('destructive planning fails closed when live catalog evidence is unavailable', () => {
  const result = planProviderDelete({
    providerId: 'opencode-go', inventory: {
      catalog_evidence: { ok: false, code: 'MODEL_CATALOG_UNAVAILABLE' }, records,
    }, replacementDefault: 'openrouter',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_CATALOG_UNAVAILABLE');
});

test('destructive planning fails closed when persisted and live Harness Defaults disagree', () => {
  const result = planProviderDelete({
    providerId: 'openrouter',
    inventory: {
      default_evidence: { ok: false, code: 'PROVIDER_DEFAULT_AUTHORITY_MISMATCH' },
      records: records.map((record) => ({ ...record, references: { ...record.references, harness_default: record.id === 'openrouter' } })),
    },
    replacementDefault: 'opencode-go',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_DEFAULT_AUTHORITY_MISMATCH');
});

test('mixed known and unknown declaration authority is not deletable', () => {
  const result = planProviderDelete({
    providerId: 'opencode-go', inventory: { records: [{
      ...records[0], references: { ...records[0].references, harness_default: false },
      declaration_authorities: [
        { kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.opencode-go' },
        { kind: 'future-store', locator: 'future.providers.opencode-go' },
      ],
    }] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_DELETE_SOURCE_UNRESOLVED');
});

test('declaration authority locator must bind to the selected provider id', () => {
  const result = planProviderDelete({
    providerId: 'opencode-go', inventory: { records: [{
      ...records[0], references: { ...records[0].references, harness_default: false },
      declaration_authorities: [{ kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.some-other-provider' }],
    }] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_DELETE_SOURCE_UNRESOLVED');
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

test('Harness Default deletion requires an advertised replacement model', () => {
  const inventory = { records: records.map((record) => ({ ...record, models: record.id === 'openrouter' ? [] : record.models })) };
  const result = planProviderDelete({
    providerId: 'opencode-go', inventory, replacementDefault: 'openrouter',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_DEFAULT_REPLACEMENT_MODEL_REQUIRED');
});

test('Harness Default replacement must be present in the live catalog', () => {
  const inventory = { records: records.map((record) => ({ ...record, lifecycle: { ...record.lifecycle, catalogued: record.id === 'opencode-go' } })) };
  const result = planProviderDelete({ providerId: 'opencode-go', inventory, replacementDefault: 'openrouter' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_DEFAULT_REPLACEMENT_REQUIRED');
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
    rollback: async () => calls.push('rollback'),
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
    removeDeclarations: async () => {}, restart: async () => ({ ok: false, code: 'CREW_BACKEND_START_TIMEOUT' }), rollback: async () => {},
  });
  assert.equal(failedRestart.state, 'FAILED');
  assert.equal(failedRestart.error_code, 'CREW_BACKEND_START_TIMEOUT');

  const failedVerify = await executeProviderDelete(plan, {
    backup: async () => {}, markTombstone: async () => {}, scrubReferences: async () => {},
    removeDeclarations: async () => {}, restart: async () => ({ ok: true }), rollback: async () => {},
    verify: async () => ({ providerAbsent: true, routingClear: false, tombstonePresent: true }),
  });
  assert.equal(failedVerify.state, 'FAILED');
  assert.equal(failedVerify.error_code, 'PROVIDER_DELETE_VERIFY_FAILED');
});

test('post-write failure invokes compensating rollback before reporting FAILED', async () => {
  const calls = [];
  const plan = planProviderDelete({
    providerId: 'opencode-go', inventory: { records }, replacementDefault: 'openrouter',
  }).plan;
  const result = await executeProviderDelete(plan, {
    backup: async () => calls.push('backup'),
    markTombstone: async () => calls.push('tombstone'),
    scrubReferences: async () => calls.push('scrub'),
    removeDeclarations: async () => calls.push('declarations'),
    restart: async () => { calls.push('restart'); return { ok: false, code: 'CREW_BACKEND_START_TIMEOUT' }; },
    rollback: async () => calls.push('rollback'),
  });
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error_code, 'CREW_BACKEND_START_TIMEOUT');
  assert.equal(result.rollback_attempted, true);
  assert.deepEqual(calls, ['backup', 'tombstone', 'scrub', 'declarations', 'restart', 'rollback']);
});

test('missing rollback hook fails before any destructive adapter runs', async () => {
  const calls = [];
  const plan = planProviderDelete({
    providerId: 'opencode-go', inventory: { records }, replacementDefault: 'openrouter',
  }).plan;
  const result = await executeProviderDelete(plan, {
    backup: async () => calls.push('backup'),
    markTombstone: async () => calls.push('tombstone'),
    scrubReferences: async () => calls.push('scrub'),
    removeDeclarations: async () => calls.push('declarations'),
    restart: async () => ({ ok: true }),
    verify: async () => ({ providerAbsent: true, routingClear: true, tombstonePresent: true }),
  });
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error_code, 'PROVIDER_LIFECYCLE_HOOK_MISSING');
  assert.equal(result.rollback_attempted, false);
  assert.deepEqual(calls, []);
});

test('failed deletion restarts and verifies the restored runtime when hooks provide it', async () => {
  const calls = [];
  const plan = planProviderDelete({
    providerId: 'opencode-go', inventory: { records }, replacementDefault: 'openrouter',
  }).plan;
  const result = await executeProviderDelete(plan, {
    backup: async () => {}, markTombstone: async () => {}, scrubReferences: async () => {},
    removeDeclarations: async () => {}, restart: async () => ({ ok: false, code: 'CREW_BACKEND_START_TIMEOUT' }),
    rollback: async () => calls.push('rollback'),
    restartRollback: async () => { calls.push('restart-rollback'); return { ok: true }; },
    verifyRollback: async () => { calls.push('verify-rollback'); return { ok: true }; },
  });
  assert.equal(result.state, 'FAILED');
  assert.equal(result.rollback_runtime_restarted, true);
  assert.equal(result.rollback_runtime_verified, true);
  assert.deepEqual(calls, ['rollback', 'restart-rollback', 'verify-rollback']);
});

test('provider deletion records a bounded transaction audit when requested', async () => {
  const calls = [];
  const plan = planProviderDelete({
    providerId: 'opencode-go', inventory: { records }, replacementDefault: 'openrouter',
  }).plan;
  const result = await executeProviderDelete(plan, {
    backup: async () => {}, markTombstone: async () => {}, scrubReferences: async () => {},
    removeDeclarations: async () => {}, restart: async () => ({ ok: true }), rollback: async () => {},
    verify: async () => ({ providerAbsent: true, routingClear: true, tombstonePresent: true }),
    recordTransaction: async (audit) => calls.push(audit),
  });
  assert.equal(result.state, 'VERIFIED');
  assert.equal(result.audit_recorded, true);
  assert.deepEqual(calls.map(({ transaction_id, provider_id, state }) => ({ transaction_id, provider_id, state })), [
    { transaction_id: plan.plan_id, provider_id: 'opencode-go', state: 'VERIFIED' },
  ]);
});

test('bridged provider deletion can stop at RESTART_PENDING without false verification', async () => {
  const calls = [];
  const plan = planProviderDelete({
    providerId: 'opencode-go', inventory: { records }, replacementDefault: 'openrouter',
  }).plan;
  const result = await executeProviderDelete(plan, {
    backup: async () => calls.push('backup'),
    markTombstone: async () => calls.push('tombstone'),
    scrubReferences: async () => calls.push('scrub'),
    removeDeclarations: async () => calls.push('declarations'),
    restart: async () => calls.push('restart'),
    rollback: async () => calls.push('rollback'),
    recordTransaction: async (audit) => calls.push(`audit:${audit.state}`),
  }, { deferRestart: true });
  assert.equal(result.state, 'RESTART_PENDING');
  assert.equal(result.verification, null);
  assert.deepEqual(calls, ['backup', 'tombstone', 'scrub', 'declarations', 'audit:RESTART_PENDING']);
});
