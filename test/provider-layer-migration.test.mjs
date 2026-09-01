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
