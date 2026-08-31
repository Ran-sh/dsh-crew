import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectProviderProfile,
  removeProviderDeclarations,
} from '../src/provider-profile-store.mjs';

const PROFILE = `# managed provider patch\n- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        displayName: OpenCode Go\n        apiKeyEnv: OPENCODE_GO_API_KEY\n      opencode-alt:\n        displayName: Opencode\n        apiKeyEnv: OPENCODE_ALT_API_KEY\n      opencode-muse:\n        displayName: opencode-go-muse\n        apiKeyEnv: OPENCODE_MUSE_API_KEY\n      openrouter:\n        displayName: openrouter\n        apiKeyEnv: OPENROUTER_API_KEY\n- insert:\n    - id: dsh-crew-hub\n      name: '@ran-sh/dsh-crew'\n`;

test('inspectProviderProfile returns provider ids and a revision without values', () => {
  const result = inspectProviderProfile(PROFILE);
  assert.equal(result.ok, true);
  assert.deepEqual(result.providerIds, ['opencode-go', 'opencode-alt', 'opencode-muse', 'openrouter']);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('OPENCODE_GO_API_KEY'), false);
});

test('removeProviderDeclarations removes only selected providers and preserves the rest', () => {
  const inspected = inspectProviderProfile(PROFILE);
  const result = removeProviderDeclarations(PROFILE, {
    providerIds: ['opencode-go', 'opencode-alt', 'opencode-muse'],
    expectedRevision: inspected.revision,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, ['opencode-go', 'opencode-alt', 'opencode-muse']);
  assert.deepEqual(result.remaining, ['openrouter']);
  assert.equal(result.text.includes('opencode-go:'), false);
  assert.equal(result.text.includes('opencode-alt:'), false);
  assert.equal(result.text.includes('opencode-muse:'), false);
  assert.equal(result.text.includes('openrouter:'), true);
  assert.equal(result.text.includes('dsh-crew-hub'), true);
});

test('profile revision mismatch fails closed before writing', () => {
  const result = removeProviderDeclarations(PROFILE, {
    providerIds: ['opencode-go'],
    expectedRevision: '0'.repeat(64),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_PROFILE_CHANGED');
  assert.equal(result.text, undefined);
});

test('unknown profile shape and missing provider fail closed', () => {
  const unknown = removeProviderDeclarations('- insert:\n    - id: other\n', {
    providerIds: ['opencode-go'],
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED');

  const missing = removeProviderDeclarations(PROFILE, { providerIds: ['missing'] });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PROVIDER_NOT_FOUND');
});
