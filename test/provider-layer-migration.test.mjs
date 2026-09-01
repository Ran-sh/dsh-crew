import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderLayerMigrationPlan, hasProviderLayerMigration } from '../src/provider-layer-migration.mjs';

test('layer migration plans non-builtin base providers without exposing credentials', () => {
  const plan = buildProviderLayerMigrationPlan({
    declarations: [
      { id: 'opencode-muse', display_name: 'opencode-go-muse', credential_ref: { name_or_handle: 'OPENCODE_MUSE_API_KEY' }, declaration_authority: { kind: 'crew-profile' } },
      { id: 'opencode-muse', display_name: 'opencode-go-muse', credential_ref: { name_or_handle: 'OPENCODE_MUSE_API_KEY' }, declaration_authority: { kind: 'harness-settings' } },
      { id: 'deepseek-official', declaration_authority: { kind: 'crew-profile' } },
    ],
    routingReferences: [{ provider: 'opencode-muse', model: 'mimo-v2.5' }],
    harnessDefault: { provider: 'opencode-muse', model: 'mimo-v2.5' },
    catalogProviders: [{ id: 'opencode-muse', adapter_owned: false }],
  });
  assert.equal(hasProviderLayerMigration(plan), true);
  assert.deepEqual(plan.providers[0], {
    provider_id: 'opencode-muse',
    action: 'promote-existing-user',
    current_native_removable: false,
    target_native_removable: true,
    native_removable_after: 'pending-verification',
    requires_base_removal: true,
    target_user_layer: true,
    source: {
      base: { id: 'opencode-muse', display_name: 'opencode-go-muse', credential_ref: 'OPENCODE_MUSE_API_KEY' },
      user: { id: 'opencode-muse', display_name: 'opencode-go-muse', credential_ref: 'OPENCODE_MUSE_API_KEY' },
    },
    credential_reference: 'OPENCODE_MUSE_API_KEY',
    collision: null,
    referenced_by: [{ provider: 'opencode-muse', model: 'mimo-v2.5' }],
    harness_default: true,
  });
  assert.equal(JSON.stringify(plan).includes('secret'), false);
});

test('opencode-go adapter collisions require an explicit target id', () => {
  const plan = buildProviderLayerMigrationPlan({
    declarations: [{ id: 'opencode-go', declaration_authority: { kind: 'crew-profile' } }],
    catalogProviders: [{ id: 'opencode-go', adapter_owned: true }],
  });
  assert.equal(plan.providers[0].action, 'collision-review');
  assert.equal(plan.providers[0].collision.reason_code, 'HARNESS_PROVIDER_ID_COLLISION');
  assert.equal(plan.requires_confirmation, true);
});

test('opencode-go without explicit ownership metadata fails closed', () => {
  const plan = buildProviderLayerMigrationPlan({
    declarations: [{ id: 'opencode-go', declaration_authority: { kind: 'crew-profile' } }],
    catalogProviders: [],
  });
  assert.equal(plan.providers[0].action, 'collision-review');
  assert.equal(plan.blocked[0].code, 'HARNESS_PROVIDER_OWNERSHIP_UNAVAILABLE');
});

test('explicitly non-adapter opencode-go may be materialized', () => {
  const plan = buildProviderLayerMigrationPlan({
    declarations: [{ id: 'opencode-go', declaration_authority: { kind: 'crew-profile' } }],
    catalogProviders: [{ id: 'opencode-go', adapter_owned: false }],
  });
  assert.equal(plan.providers[0].action, 'materialize-user');
});

test('adapter ownership gates are generic for future provider ids', () => {
  const owned = buildProviderLayerMigrationPlan({
    declarations: [{ id: 'future-adapter', declaration_authority: { kind: 'crew-profile' } }],
    catalogProviders: [{ id: 'future-adapter', adapter_owned: true }],
  });
  assert.equal(owned.providers[0].action, 'collision-review');
  assert.equal(owned.blocked[0].code, 'HARNESS_PROVIDER_ID_COLLISION');
  const unknown = buildProviderLayerMigrationPlan({
    declarations: [{ id: 'future-adapter', declaration_authority: { kind: 'crew-profile' } }],
    catalogProviders: [{ id: 'future-adapter' }],
  });
  assert.equal(unknown.providers[0].action, 'collision-review');
  assert.equal(unknown.blocked[0].code, 'HARNESS_PROVIDER_OWNERSHIP_UNAVAILABLE');
});

test('suspicious credential values are redacted from migration output', () => {
  for (const value of ['sk-live-secret', 'secret_LIVE123', 'token_ABC123', 'sk_live_ABC123', 'Bearer live-token', 'https://example.test/key', 'KEY=live']) {
    const plan = buildProviderLayerMigrationPlan({
      declarations: [{ id: 'custom', credential_ref: value, declaration_authority: { kind: 'crew-profile' } }],
    });
    assert.equal(plan.providers[0].credential_reference, null, value);
    assert.equal(JSON.stringify(plan).includes(value), false, value);
  }
});

test('layer-specific credential references remain distinct and lifecycle blockers win', () => {
  const declarations = [
    { id: 'dual', credential_ref: 'PROFILE_KEY', declaration_authority: { kind: 'crew-profile' } },
    { id: 'dual', credential_ref: 'SETTINGS_KEY', declaration_authority: { kind: 'harness-settings' } },
  ];
  const plan = buildProviderLayerMigrationPlan({
    declarations,
    tombstones: { dual: 'absent' },
  });
  assert.deepEqual(plan.providers[0].source.base.credential_ref, 'PROFILE_KEY');
  assert.deepEqual(plan.providers[0].source.user.credential_ref, 'SETTINGS_KEY');
  assert.equal(plan.providers[0].action, 'blocked');
  assert.equal(plan.providers[0].blocked_reason, 'PROVIDER_ALREADY_ABSENT');
  assert.equal(plan.blocked[0].code, 'PROVIDER_ALREADY_ABSENT');
});

test('pending provider recovery blocks migration', () => {
  const plan = buildProviderLayerMigrationPlan({
    declarations: [{ id: 'custom', declaration_authority: { kind: 'crew-profile' } }],
    recoveryTransactions: [{ provider_id: 'other-provider' }],
  });
  assert.equal(plan.providers[0].action, 'blocked');
  assert.equal(plan.providers[0].blocked_reason, 'PROVIDER_DELETE_RECOVERY_PENDING');
});

test('pending recovery for one provider globally fences another migration', () => {
  const plan = buildProviderLayerMigrationPlan({
    declarations: [{ id: 'candidate', declaration_authority: { kind: 'crew-profile' } }],
    catalogProviders: [{ id: 'candidate', adapter_owned: false }],
    recoveryTransactions: [{ provider_id: 'other-provider', recoverable: true }],
  });
  assert.equal(plan.providers[0].action, 'blocked');
  assert.equal(plan.providers[0].blocked_reason, 'PROVIDER_DELETE_RECOVERY_PENDING');
});

test('catalog and lifecycle evidence failures never produce migration actions', () => {
  const declarations = [{ id: 'candidate', declaration_authority: { kind: 'crew-profile' } }];
  for (const evidence of [
    { catalogEvidence: { ok: false }, expected: 'MODEL_CATALOG_UNAVAILABLE' },
    { catalogEvidence: { ok: true, partial: true }, expected: 'MODEL_CATALOG_UNAVAILABLE' },
    { lifecycleEvidence: { ok: false }, expected: 'PROVIDER_LIFECYCLE_UNAVAILABLE' },
    { declarationEvidence: { ok: false }, expected: 'PROVIDER_SOURCE_UNRESOLVED' },
    { defaultEvidence: { ok: false }, expected: 'PROVIDER_DEFAULT_AUTHORITY_UNAVAILABLE' },
  ]) {
    const plan = buildProviderLayerMigrationPlan({ declarations, catalogProviders: [{ id: 'candidate', adapter_owned: false }], ...evidence });
    assert.equal(plan.providers[0].action, 'blocked', evidence.expected);
    assert.equal(plan.providers[0].blocked_reason, evidence.expected);
  }
});
