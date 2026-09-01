import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectProviderSettings,
  readProviderSettingsDeclarations,
  removeProviderSettings,
} from '../src/provider-settings-store.mjs';

const SETTINGS = `ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\nllm-pi-ai:\n  providers:\n    opencode-go:\n      apiKeyEnv: OPENCODE_GO_API_KEY\n      models:\n        - id: deepseek-v4-flash\n    openrouter:\n      apiKeyEnv: OPENROUTER_API_KEY\nagent-presets:\n  default: minimal\n`;

test('Harness settings parser discovers nested provider declarations with a stable authority', () => {
  const inspected = inspectProviderSettings(SETTINGS);
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.providerIds, ['opencode-go', 'openrouter']);
  const result = readProviderSettingsDeclarations(SETTINGS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.declarations, [
    { id: 'opencode-go', display_name: 'opencode-go', origin: 'profile-managed', ownership: 'crew-managed-profile', file: 'harness/settings.yaml', declaration_authority: { kind: 'harness-settings', locator: 'llm-pi-ai.providers.opencode-go' }, credential_ref: 'OPENCODE_GO_API_KEY' },
    { id: 'openrouter', display_name: 'openrouter', origin: 'profile-managed', ownership: 'crew-managed-profile', file: 'harness/settings.yaml', declaration_authority: { kind: 'harness-settings', locator: 'llm-pi-ai.providers.openrouter' }, credential_ref: 'OPENROUTER_API_KEY' },
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
