import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderInventory } from '../src/provider-inventory.mjs';

const catalog = {
  providers: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash' }],
    },
    {
      id: 'opencode-go',
      name: 'OpenCode Go',
      models: [{ id: 'deepseek-v4-flash' }, { id: 'mimo-v2.5' }],
    },
    {
      id: 'openrouter',
      name: 'openrouter',
      models: [{ id: 'minimax/minimax-m3:free' }],
    },
  ],
  harness_default: { provider: 'opencode-go', model: 'mimo-v2.5' },
};

const declarations = [
  {
    id: 'opencode-go',
    display_name: 'OpenCode Go',
    origin: 'profile-managed',
    ownership: 'crew-managed-profile',
    file: 'profiles/dsh-crew/cordis.patch.yml',
    credential_ref: 'OPENCODE_GO_API_KEY',
  },
  {
    id: 'openrouter',
    display_name: 'openrouter',
    origin: 'dynamic',
    ownership: 'dynamic-user',
    file: 'settings.yaml',
    credential_ref: 'OPENROUTER_API_KEY',
  },
];

const policy = {
  worker: {
    priority: [
      { provider: 'opencode-go', model: 'mimo-v2.5' },
      { provider: 'openrouter', model: 'minimax/minimax-m3:free' },
    ],
    escalation_priority: [],
  },
  reviewer: {
    priority: [{ provider: 'opencode-go', model: 'deepseek-v4-flash' }],
    escalation_priority: [],
  },
};

test('provider inventory merges catalog, declaration provenance and routing references', () => {
  const result = buildProviderInventory({ catalog, declarations, policy });
  assert.ok(Array.isArray(result.records));
  assert.deepEqual(result.records.map((record) => record.id), [
    'deepseek-official', 'opencode-go', 'openrouter',
  ]);

  const opencode = result.records.find((record) => record.id === 'opencode-go');
  assert.equal(opencode.display_name, 'OpenCode Go');
  assert.equal(opencode.origin, 'profile-managed');
  assert.equal(opencode.ownership, 'crew-managed-profile');
  assert.equal(opencode.declaration.file, 'profiles/dsh-crew/cordis.patch.yml');
  assert.equal(opencode.lifecycle.catalogued, true);
  assert.equal(opencode.references.harness_default, true);
  assert.equal(opencode.references.worker_priority, 0);
  assert.equal(opencode.references.reviewer_priority, 0);
});

test('tombstones mark a provider absent without exposing credential values', () => {
  const result = buildProviderInventory({
    catalog,
    declarations,
    policy,
    tombstones: { 'opencode-go': 'absent' },
  });
  const opencode = result.records.find((record) => record.id === 'opencode-go');
  assert.equal(opencode.desired_state, 'absent');
  assert.deepEqual(opencode.credential_refs, [{
    kind: 'env', name_or_handle: 'OPENCODE_GO_API_KEY', ownership: 'crew',
  }]);
  assert.equal('value' in opencode.credential_refs[0], false);
  assert.equal(JSON.stringify(opencode).includes('secret'), false);
});

test('catalog-only and declaration-only providers remain machine-visible with bounded lifecycle state', () => {
  const result = buildProviderInventory({
    catalog: { providers: [{ id: 'catalog-only', name: 'Catalog only', models: [] }] },
    declarations: [{
      id: 'declaration-only', display_name: 'Declaration only', origin: 'profile-managed',
      ownership: 'crew-managed-profile', file: 'profile.yml', credential_ref: 'DECLARATION_KEY',
    }],
  });
  const catalogOnly = result.records.find((record) => record.id === 'catalog-only');
  const declarationOnly = result.records.find((record) => record.id === 'declaration-only');
  assert.equal(catalogOnly.lifecycle.catalogued, true);
  assert.equal(catalogOnly.lifecycle.configured, false);
  assert.equal(declarationOnly.lifecycle.catalogued, false);
  assert.equal(declarationOnly.lifecycle.configured, true);
});
