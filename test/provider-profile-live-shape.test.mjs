import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectProviderProfile,
  readProviderDeclarations,
  removeProviderDeclarations,
} from '../src/provider-profile-store.mjs';

// This is the shape emitted by the live Crew-owned llm-pi-ai patch: provider
// values contain nested model sequences. The fixture intentionally contains
// only model/provider references and no credential values.
const LIVE_SHAPE = `# managed provider patch
- id: llm-pi-ai
  config:
    providers:
      opencode-muse:
        displayName: opencode-go-muse
        apiKeyEnv: OPENCODE_MUSE_API_KEY
        models:
          - id: deepseek-v4-flash
            name: DeepSeek-V4-Flash
          - id: deepseek-v4-pro
            name: DeepSeek-V4-Pro
      openrouter:
        displayName: openrouter
        apiKeyEnv: OPENROUTER_API_KEY
- insert:
    - id: dsh-crew-hub
`;

test('provider profile parser accepts live nested model sequences', () => {
  const inspected = inspectProviderProfile(LIVE_SHAPE);
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.providerIds, ['opencode-muse', 'openrouter']);
  const declarations = readProviderDeclarations(LIVE_SHAPE);
  assert.equal(declarations.ok, true);
  assert.equal(JSON.stringify(declarations).includes('OPENCODE_MUSE_API_KEY'), true);
  assert.equal(JSON.stringify(declarations).includes('deepseek-v4-flash'), false);
});

test('provider profile removal preserves valid nested model YAML for remaining providers', () => {
  const inspected = inspectProviderProfile(LIVE_SHAPE);
  const result = removeProviderDeclarations(LIVE_SHAPE, {
    providerIds: ['opencode-muse'],
    expectedRevision: inspected.revision,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.remaining, ['openrouter']);
  assert.equal(result.text.includes('opencode-muse:'), false);
  assert.equal(result.text.includes('openrouter:'), true);
  assert.equal(result.text.includes('deepseek-v4-flash'), false);
});

test('provider profile parser still rejects a sequence at provider-field indentation', () => {
  const malformed = LIVE_SHAPE.replace(
    '        models:\n          - id: deepseek-v4-flash',
    '        models:\n        - id: deepseek-v4-flash',
  );
  const result = inspectProviderProfile(malformed);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED');
});
