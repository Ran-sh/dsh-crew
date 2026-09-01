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
    declaration_authority: { kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.opencode-go' },
    credential_ref: 'OPENCODE_GO_API_KEY',
  },
  {
    id: 'openrouter',
    display_name: 'openrouter',
    origin: 'dynamic',
    ownership: 'dynamic-user',
    file: 'settings.yaml',
    declaration_authority: { kind: 'harness-settings', locator: 'llm-pi-ai.providers.openrouter' },
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

test('only deepseek-official is immutable; catalog-only non-official providers are source-unresolved', () => {
  const result = buildProviderInventory({
    catalog: { providers: [
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash' }] },
      { id: 'openrouter', name: 'openrouter', models: [{ id: 'minimax/minimax-m3:free' }] },
    ] },
  });
  const official = result.records.find((record) => record.id === 'deepseek-official');
  const unresolved = result.records.find((record) => record.id === 'openrouter');
  assert.equal(official.delete_capability, 'immutable-builtin');
  assert.equal(official.delete_blocker, 'PROVIDER_BUILTIN_IMMUTABLE');
  assert.equal(unresolved.delete_capability, 'source-unresolved');
  assert.equal(unresolved.ownership, 'unknown');
  assert.equal(unresolved.origin, 'unknown');
});

test('declared non-official providers are explicitly deletable', () => {
  const result = buildProviderInventory({ catalog, declarations, policy });
  for (const id of ['opencode-go', 'openrouter']) {
    const record = result.records.find((entry) => entry.id === id);
    assert.equal(record.delete_capability, 'supported', id);
    assert.ok(Array.isArray(record.declaration_authorities), id);
  }
});

test('unknown declaration authority does not advertise a destructive capability', () => {
  const result = buildProviderInventory({ declarations: [{
    id: 'mystery', display_name: 'mystery', declaration_authority: { kind: 'future-store', locator: 'providers.mystery' },
  }] });
  assert.equal(result.records[0].delete_capability, 'source-unresolved');
  assert.equal(result.records[0].delete_blocker, 'PROVIDER_DELETE_SOURCE_UNRESOLVED');
});

test('provider inventory counts only non-terminal jobs as active', () => {
  const result = buildProviderInventory({
    catalog,
    declarations,
    policy,
    activeJobs: [
      { provider: 'opencode-go', status: 'running' },
      { provider: 'opencode-go', status: 'done' },
      { provider: 'opencode-go', status: 'cancelled' },
      { provider: 'opencode-go', status: 'failed' },
    ],
  });
  assert.equal(result.records.find((record) => record.id === 'opencode-go').references.active_jobs, 1);
});

test('malformed authority alongside a valid declaration fails closed for the whole provider', () => {
  const result = buildProviderInventory({ declarations: [
    { id: 'mixed', declaration_authority: { kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.mixed' } },
    { id: 'mixed', declaration_authority: { kind: 'crew-profile' } },
  ] });
  assert.equal(result.records[0].delete_capability, 'source-unresolved');
});

test('provider credential references aggregate across every declaration authority', () => {
  const result = buildProviderInventory({ declarations: [
    { id: 'dual', credential_ref: 'PROFILE_DUAL_KEY', declaration_authority: { kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.dual' } },
    { id: 'dual', credential_ref: 'SETTINGS_DUAL_KEY', declaration_authority: { kind: 'harness-settings', locator: 'llm-pi-ai.providers.dual' } },
  ] });
  assert.deepEqual(result.records[0].credential_refs.map((ref) => ref.name_or_handle), ['PROFILE_DUAL_KEY', 'SETTINGS_DUAL_KEY']);
});

test('credential refs preserve kind identity and downgrade ownership conflicts', () => {
  const result = buildProviderInventory({ declarations: [
    { id: 'refs', credential_ref: { kind: 'env', name_or_handle: 'SAME', ownership: 'user' }, declaration_authority: { kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.refs' } },
    { id: 'refs', credential_ref: { kind: 'env', name_or_handle: 'SAME', ownership: 'crew' }, declaration_authority: { kind: 'harness-settings', locator: 'llm-pi-ai.providers.refs' } },
    { id: 'refs', credential_ref: { kind: 'crew-store', name_or_handle: 'SAME', ownership: 'crew' }, declaration_authority: { kind: 'harness-settings', locator: 'llm-pi-ai.providers.refs' } },
  ] });
  assert.deepEqual(result.records[0].credential_refs, [
    { kind: 'env', name_or_handle: 'SAME', ownership: 'unknown' },
    { kind: 'crew-store', name_or_handle: 'SAME', ownership: 'crew' },
  ]);
});
