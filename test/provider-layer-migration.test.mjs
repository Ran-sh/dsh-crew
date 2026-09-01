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
  });
  assert.equal(hasProviderLayerMigration(plan), true);
  assert.deepEqual(plan.providers[0], {
    provider_id: 'opencode-muse',
    action: 'promote-existing-user',
    native_removable_after: true,
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
  assert.equal(plan.blocked[0].code, 'HARNESS_PROVIDER_ID_COLLISION');
});

test('explicitly non-adapter opencode-go may be materialized', () => {
  const plan = buildProviderLayerMigrationPlan({
    declarations: [{ id: 'opencode-go', declaration_authority: { kind: 'crew-profile' } }],
    catalogProviders: [{ id: 'opencode-go', adapter_owned: false }],
  });
  assert.equal(plan.providers[0].action, 'materialize-user');
});

test('suspicious credential values are redacted from migration output', () => {
  const plan = buildProviderLayerMigrationPlan({
    declarations: [{ id: 'custom', credential_ref: 'sk-live-secret', declaration_authority: { kind: 'crew-profile' } }],
  });
  assert.equal(plan.providers[0].credential_reference, null);
  assert.equal(JSON.stringify(plan).includes('sk-live-secret'), false);
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
    recoveryTransactions: [{ provider_id: 'custom', unresolved: true }],
  });
  assert.equal(plan.providers[0].action, 'blocked');
  assert.equal(plan.providers[0].blocked_reason, 'PROVIDER_DELETE_RECOVERY_PENDING');
});
