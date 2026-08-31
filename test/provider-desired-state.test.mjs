import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileProviderDesiredState } from '../src/provider-desired-state.mjs';

const PROFILE = `- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        displayName: OpenCode Go
        models:
          - id: deepseek-v4-flash
      openrouter:
        displayName: openrouter
- insert:
    - id: dsh-crew-hub
`;

test('desired-state reconciliation removes tombstoned declarations without touching retained providers', () => {
  const result = reconcileProviderDesiredState(PROFILE, {
    tombstones: { 'opencode-go': 'absent' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, ['opencode-go']);
  assert.equal(result.text.includes('opencode-go:'), false);
  assert.equal(result.text.includes('openrouter:'), true);
  assert.equal(result.text.includes('deepseek-v4-flash'), false);
});

test('desired-state reconciliation is a no-op when no tombstoned declaration is present', () => {
  const result = reconcileProviderDesiredState(PROFILE, { tombstones: { missing: 'absent' } });
  assert.deepEqual(result, { ok: true, changed: false, removed: [], text: PROFILE });
});

test('desired-state reconciliation fails closed on an unsupported profile shape', () => {
  const result = reconcileProviderDesiredState('- insert:\n    - id: dsh-crew-hub\n', { tombstones: { 'opencode-go': 'absent' } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED');
  assert.equal(result.text, undefined);
});
