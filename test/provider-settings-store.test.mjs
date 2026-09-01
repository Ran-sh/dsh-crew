import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectProviderSettings,
  readProviderSettingsDeclarations,
  removeProviderSettings,
  readHarnessDefault,
  replaceHarnessDefault,
  mutateProviderSettings,
} from '../src/provider-settings-store.mjs';

const SETTINGS = `ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\nllm-pi-ai:\n  providers:\n    opencode-go:\n      apiKeyEnv: OPENCODE_GO_API_KEY\n      models:\n        - id: deepseek-v4-flash\n    openrouter:\n      apiKeyEnv: OPENROUTER_API_KEY\nagent-presets:\n  default: minimal\n`;
const SETTINGS_WITH_DEFAULT = SETTINGS.replace('agent-presets:', 'agent-default-model:\n  provider: opencode-go\n  model: mimo-v2.5\nagent-presets:');

test('Harness settings parser discovers nested provider declarations with a stable authority', () => {
  const inspected = inspectProviderSettings(SETTINGS);
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.providerIds, ['opencode-go', 'openrouter']);
  const result = readProviderSettingsDeclarations(SETTINGS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.declarations, [
    { id: 'opencode-go', display_name: 'opencode-go', origin: 'profile-managed', ownership: 'crew-managed-profile', file: 'harness/settings.yaml', declaration_authority: { kind: 'harness-settings', locator: 'llm-pi-ai.providers.opencode-go' }, credential_ref: { kind: 'env', name_or_handle: 'OPENCODE_GO_API_KEY', ownership: 'unknown' } },
    { id: 'openrouter', display_name: 'openrouter', origin: 'profile-managed', ownership: 'crew-managed-profile', file: 'harness/settings.yaml', declaration_authority: { kind: 'harness-settings', locator: 'llm-pi-ai.providers.openrouter' }, credential_ref: { kind: 'env', name_or_handle: 'OPENROUTER_API_KEY', ownership: 'unknown' } },
  ]);
  assert.equal(JSON.stringify(result).includes('deepseek-v4-flash'), false);
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
