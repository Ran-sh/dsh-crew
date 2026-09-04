import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addProviderSettings,
  hasInlineProviderCredentials,
  inspectProviderSettings,
  readProviderSettingsDeclarations,
  readProviderSettingsMaterialization,
  removeProviderSettings,
  readHarnessDefault,
  replaceHarnessDefault,
  mutateProviderSettings,
} from '../src/provider-settings-store.mjs';

const SETTINGS = `ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\nllm-pi-ai:\n  providers:\n    opencode-go:\n      apiKeyEnv: OPENCODE_GO_API_KEY\n      models:\n        - id: deepseek-v4-flash\n    openrouter:\n      apiKeyEnv: OPENROUTER_API_KEY\nagent-presets:\n  default: minimal\n`;
const SETTINGS_WITH_DEFAULT = SETTINGS.replace('agent-presets:', 'agent-default-model:\n  provider: opencode-go\n  model: mimo-v2.5\nagent-presets:');

// Harness 0.1.2-rc.1 persists the provider map as a multiline flow
// collection. Keep this fixture credential-reference-only: no secret values.
const FLOW_SETTINGS = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
llm-pi-ai:
  providers:
    {
      opencode-go-muse:
        {
          displayName: opencode-go-muse,
          apiKeyEnv: OPENCODE_GO_MUSE_API_KEY,
          api: openai-responses,
          baseURL: https://opencode.ai/zen/go/v1,
          models:
            [
              { id: muse-spark-1.3-contributor, name: Muse Spark 1.3 },
              { id: muse-spark-1.2-contributor, name: Muse Spark 1.2 }
            ]
        },
      opencode1:
        {
          displayName: Opencode 1,
          apiKeyEnv: OPENCODE1_API_KEY,
          api: openai-completions,
          baseURL: https://opencode.ai/zen/go/v1,
          models:
            [
              { id: deepseek-v4-flash, name: DeepSeek V4 Flash },
              { id: mimo-v2.5, name: MiMo V2.5 }
            ]
        }
    }
agent-default-model:
  provider: opencode-go-muse
  model: muse-spark-1.3-contributor
permission:
  defaultPreset: danger-full-access
`;

test('Harness settings parser discovers nested provider declarations with a stable authority', () => {
  const inspected = inspectProviderSettings(SETTINGS);
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.providerIds, ['opencode-go', 'openrouter']);
  const result = readProviderSettingsDeclarations(SETTINGS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.declarations, [
    { id: 'opencode-go', display_name: 'opencode-go', origin: 'dynamic', ownership: 'dynamic-user', file: 'harness/settings.yaml', declaration_authority: { kind: 'harness-settings', locator: 'llm-pi-ai.providers.opencode-go' }, credential_ref: { kind: 'env', name_or_handle: 'OPENCODE_GO_API_KEY', ownership: 'unknown' } },
    { id: 'openrouter', display_name: 'openrouter', origin: 'dynamic', ownership: 'dynamic-user', file: 'harness/settings.yaml', declaration_authority: { kind: 'harness-settings', locator: 'llm-pi-ai.providers.openrouter' }, credential_ref: { kind: 'env', name_or_handle: 'OPENROUTER_API_KEY', ownership: 'unknown' } },
  ]);
  assert.equal(JSON.stringify(result).includes('deepseek-v4-flash'), false);
});

test('settings declarations are user-layer provenance, not Crew profile ownership', () => {
  const result = readProviderSettingsDeclarations(SETTINGS_WITH_DEFAULT);
  assert.equal(result.ok, true);
  for (const declaration of result.declarations) {
    assert.equal(declaration.origin, 'dynamic');
    assert.equal(declaration.ownership, 'dynamic-user');
    assert.equal(declaration.declaration_authority.kind, 'harness-settings');
  }
});

test('settings credential values are redacted while presence remains visible', () => {
  for (const value of ['sk-live-secret', 'secret_LIVE123', 'token_ABC123', 'sk_live_ABC123']) {
    const source = SETTINGS.replace('apiKeyEnv: OPENCODE_GO_API_KEY', `apiKeyEnv: ${value}`);
    const result = readProviderSettingsDeclarations(source);
    const declaration = result.declarations.find((entry) => entry.id === 'opencode-go');
    assert.equal(declaration.credential_ref, undefined, value);
    assert.equal(declaration.credential_status, 'present-redacted', value);
    assert.equal(JSON.stringify(result).includes(value), false, value);
  }
});

test('Harness settings removal is revision checked and preserves unrelated sections', () => {
  const inspected = inspectProviderSettings(SETTINGS);
  const removed = removeProviderSettings(SETTINGS, { providerIds: ['opencode-go'], expectedRevision: inspected.revision });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.removed, ['opencode-go']);
  assert.equal(removed.text.includes('opencode-go:'), false);
  assert.equal(removed.text.includes('openrouter:'), true);
  assert.equal(removed.text.includes('agent-presets:'), true);
  assert.equal(removeProviderSettings(SETTINGS, { providerIds: ['opencode-go'], expectedRevision: '0'.repeat(64) }).code, 'PROVIDER_SETTINGS_CHANGED');
});

test('Harness settings parser fails closed on malformed provider indentation', () => {
  const malformed = SETTINGS.replace('    openrouter:', '   openrouter:');
  assert.equal(inspectProviderSettings(malformed).ok, false);
  assert.equal(removeProviderSettings(malformed, { providerIds: ['openrouter'] }).ok, false);
});

test('Harness settings exposes and replaces the real agent-default-model authority', () => {
  const inspected = readHarnessDefault(SETTINGS_WITH_DEFAULT);
  assert.deepEqual(inspected, {
    ok: true,
    provider: 'opencode-go',
    model: 'mimo-v2.5',
    locator: 'agent-default-model',
  });
  const replaced = replaceHarnessDefault(SETTINGS_WITH_DEFAULT, {
    provider: 'deepseek-official', model: 'deepseek-v4-flash', expectedRevision: inspectProviderSettings(SETTINGS_WITH_DEFAULT).revision,
  });
  assert.equal(replaced.ok, true);
  assert.match(replaced.text, /agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash/);
  assert.equal(replaceHarnessDefault(SETTINGS_WITH_DEFAULT, { provider: 'x', model: 'y', expectedRevision: '0'.repeat(64) }).code, 'PROVIDER_SETTINGS_CHANGED');
});

test('removing the final Harness settings provider leaves a valid empty managed block', () => {
  const only = SETTINGS.replace(/    openrouter:[\s\S]*?agent-presets:/, 'agent-presets:');
  const inspected = inspectProviderSettings(only);
  const removed = removeProviderSettings(only, { providerIds: ['opencode-go'], expectedRevision: inspected.revision });
  assert.equal(removed.ok, true);
  assert.match(removed.text, /  providers: \{\}/);
  assert.equal(inspectProviderSettings(removed.text).ok, true);
  assert.equal(readProviderSettingsDeclarations(removed.text).declarations.length, 0);
});

test('provider deletion mutates settings declaration and Harness Default in one revision transaction', () => {
  const inspected = inspectProviderSettings(SETTINGS_WITH_DEFAULT);
  const result = mutateProviderSettings(SETTINGS_WITH_DEFAULT, {
    providerId: 'opencode-go', removeProvider: true,
    replacementDefault: 'deepseek-official', replacementModel: 'deepseek-v4-flash',
    expectedRevision: inspected.revision,
  });
  assert.equal(result.ok, true);
  assert.equal(result.removed.includes('opencode-go'), true);
  assert.equal(result.previous_default.provider, 'opencode-go');
  assert.match(result.text, /agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash/);
  assert.doesNotMatch(result.text, /    opencode-go:/);
  assert.equal(inspectProviderSettings(result.text).ok, true);
});

test('Harness 0.1.2 multiline flow provider map is discovered with safe provenance', () => {
  const inspected = inspectProviderSettings(FLOW_SETTINGS);
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.providerIds, ['opencode-go-muse', 'opencode1']);

  const result = readProviderSettingsDeclarations(FLOW_SETTINGS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.declarations.map(({ id, display_name, credential_ref }) => ({ id, display_name, credential_ref })), [
    {
      id: 'opencode-go-muse', display_name: 'opencode-go-muse',
      credential_ref: { kind: 'env', name_or_handle: 'OPENCODE_GO_MUSE_API_KEY', ownership: 'unknown' },
    },
    {
      id: 'opencode1', display_name: 'Opencode 1',
      credential_ref: { kind: 'env', name_or_handle: 'OPENCODE1_API_KEY', ownership: 'unknown' },
    },
  ]);
  assert.equal(JSON.stringify(result).includes('muse-spark-1.3-contributor'), false);
});

test('flow provider materialization keeps only bounded non-secret connection and model metadata', () => {
  const result = readProviderSettingsMaterialization(FLOW_SETTINGS, { providerId: 'opencode-go-muse' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.provider, {
    id: 'opencode-go-muse',
    display_name: 'opencode-go-muse',
    credential_ref: 'OPENCODE_GO_MUSE_API_KEY',
    api: 'openai-responses',
    base_url: 'https://opencode.ai/zen/go/v1',
    models: [
      { id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3' },
      { id: 'muse-spark-1.2-contributor', name: 'Muse Spark 1.2' },
    ],
    source_file: 'harness/settings.yaml',
  });
});

test('flow provider removal preserves the sibling, default, and unrelated settings', () => {
  const inspected = inspectProviderSettings(FLOW_SETTINGS);
  const removed = removeProviderSettings(FLOW_SETTINGS, {
    providerIds: ['opencode1'], expectedRevision: inspected.revision,
  });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.remaining, ['opencode-go-muse']);
  assert.doesNotMatch(removed.text, /^ {6}opencode1:/m);
  assert.match(removed.text, /^ {6}opencode-go-muse:/m);
  assert.match(removed.text, /agent-default-model:\n  provider: opencode-go-muse/);
  assert.match(removed.text, /permission:\n  defaultPreset: danger-full-access/);
  assert.deepEqual(inspectProviderSettings(removed.text).providerIds, ['opencode-go-muse']);
});

test('adding a provider to a flow map preserves flow syntax and remains readable', () => {
  const crlf = FLOW_SETTINGS.replace(/\n/gu, '\r\n');
  const inspected = inspectProviderSettings(crlf);
  const added = addProviderSettings(crlf, {
    expectedRevision: inspected.revision,
    provider: {
      id: 'new-provider', display_name: 'New Provider', api: 'openai-completions',
      base_url: 'https://example.test/v1', credential_ref: 'NEW_PROVIDER_API_KEY',
      models: [{ id: 'new-model', name: 'New Model', input: ['text'] }],
    },
  });
  assert.equal(added.ok, true);
  assert.match(added.text, /\r\n/u);
  assert.match(added.text, /agent-default-model:\r\n  provider: opencode-go-muse/u);
  assert.match(added.text, /permission:\r\n  defaultPreset: danger-full-access/u);
  assert.deepEqual(inspectProviderSettings(added.text).providerIds, ['opencode-go-muse', 'opencode1', 'new-provider']);
  assert.equal(readProviderSettingsMaterialization(added.text, { providerId: 'new-provider' }).ok, true);
});

test('flow provider writer never turns an unsafe model id into a literal null model', () => {
  const added = addProviderSettings(FLOW_SETTINGS, {
    provider: {
      id: 'safe-provider', display_name: 'Safe Provider',
      models: [{ id: 'unsafe\nmodel' }, { id: 'safe-model' }],
    },
  });
  assert.equal(added.ok, true);
  const materialized = readProviderSettingsMaterialization(added.text, { providerId: 'safe-provider' });
  assert.equal(materialized.ok, true);
  assert.deepEqual(materialized.provider.models, [{ id: 'safe-model' }]);
  assert.doesNotMatch(added.text, /id:\s+null/u);
});

test('flow materialization bounds provider scalars and model projections', () => {
  const modelLines = Array.from({ length: 300 }, (_, index) => `              { id: model-${index}, name: Model ${index} }${index < 299 ? ',' : ''}`).join('\n');
  const oversized = FLOW_SETTINGS
    .replace('displayName: opencode-go-muse,', `displayName: ${'x'.repeat(300)},`)
    .replace('https://opencode.ai/zen/go/v1,', `https://example.test/${'y'.repeat(2050)},`)
    .replace(
      '              { id: muse-spark-1.3-contributor, name: Muse Spark 1.3 },\n              { id: muse-spark-1.2-contributor, name: Muse Spark 1.2 }',
      modelLines,
    );
  const result = readProviderSettingsMaterialization(oversized, { providerId: 'opencode-go-muse' });
  assert.equal(result.ok, true);
  assert.equal(result.provider.display_name, 'opencode-go-muse');
  assert.equal(result.provider.base_url, undefined);
  assert.equal(result.provider.models.length, 256);
  assert.equal(JSON.stringify(result).includes('y'.repeat(2050)), false);
});

test('flow credential scanning still rejects inline secrets without returning them', () => {
  const unsafe = FLOW_SETTINGS.replace('apiKeyEnv: OPENCODE1_API_KEY', 'apiKey: sk-live-do-not-return');
  const result = hasInlineProviderCredentials(unsafe, { providerIds: ['opencode1'] });
  assert.deepEqual(result, { ok: true, inline: true });
  assert.equal(JSON.stringify(result).includes('sk-live-do-not-return'), false);
});

test('removing the final flow provider emits an empty map and updates the default atomically', () => {
  const firstRemoval = removeProviderSettings(FLOW_SETTINGS, { providerIds: ['opencode1'] });
  assert.equal(firstRemoval.ok, true);
  const inspected = inspectProviderSettings(firstRemoval.text);
  const result = mutateProviderSettings(firstRemoval.text, {
    providerId: 'opencode-go-muse', removeProvider: true,
    replacementDefault: 'deepseek-official', replacementModel: 'deepseek-v4-flash',
    expectedRevision: inspected.revision,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.remaining, []);
  assert.match(result.text, /llm-pi-ai:\n  providers: \{\}/u);
  assert.match(result.text, /agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash/u);
  assert.match(result.text, /permission:\n  defaultPreset: danger-full-access/u);
  assert.deepEqual(inspectProviderSettings(result.text).providerIds, []);
});

test('flow parsing is quote-aware for commas, colons, brackets, and braces', () => {
  const quoted = FLOW_SETTINGS.replace(
    'name: Muse Spark 1.3',
    'name: "Muse, Spark: [1.3] {Contributor}"',
  );
  const result = readProviderSettingsMaterialization(quoted, { providerId: 'opencode-go-muse' });
  assert.equal(result.ok, true);
  assert.equal(result.provider.models[0].name, 'Muse, Spark: [1.3] {Contributor}');
});

test('malformed flow collections fail closed without returning provider values', () => {
  const cases = [
    {
      source: FLOW_SETTINGS.replace('    {\n      opencode-go-muse:', '      opencode-go-muse:'),
      operation: inspectProviderSettings,
      code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED',
    },
    {
      source: FLOW_SETTINGS.replace('        },\n      opencode1:', '        }\n      opencode1:'),
      operation: inspectProviderSettings,
      code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED',
    },
    {
      source: FLOW_SETTINGS.replace('            ]\n        },', '        },'),
      operation: (source) => readProviderSettingsMaterialization(source, { providerId: 'opencode-go-muse' }),
      code: 'PROVIDER_MODEL_SCHEMA_UNSUPPORTED',
    },
    {
      source: FLOW_SETTINGS.replace('          api: openai-responses,', '          unknownField: retained-value,'),
      operation: (source) => readProviderSettingsMaterialization(source, { providerId: 'opencode-go-muse' }),
      code: 'PROVIDER_MATERIALIZATION_UNSUPPORTED_FIELDS',
    },
  ];
  for (const { source, operation, code } of cases) {
    const result = operation(source);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes('retained-value'), false);
  }
});

test('missing flow separators fail closed across inspection and mutation entry points', () => {
  const malformed = [
    FLOW_SETTINGS.replace('          displayName: opencode-go-muse,', '          displayName: opencode-go-muse'),
    FLOW_SETTINGS.replace(
      '              { id: muse-spark-1.3-contributor, name: Muse Spark 1.3 },\n              { id: muse-spark-1.2-contributor, name: Muse Spark 1.2 }',
      '              { id: muse-spark-1.3-contributor, name: Muse Spark 1.3 }\n              { id: muse-spark-1.2-contributor, name: Muse Spark 1.2 }',
    ),
  ];
  for (const source of malformed) {
    assert.equal(inspectProviderSettings(source).ok, false);
    assert.equal(readProviderSettingsMaterialization(source, { providerId: 'opencode-go-muse' }).ok, false);
    assert.equal(removeProviderSettings(source, { providerIds: ['opencode1'] }).ok, false);
    assert.equal(addProviderSettings(source, {
      provider: { id: 'new-provider', display_name: 'New Provider', models: [{ id: 'new-model' }] },
    }).ok, false);
  }
});
