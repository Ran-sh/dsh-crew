import test from 'node:test';
import assert from 'node:assert/strict';

import { QUICK_CONFIG_KEYS } from '../src/hub/index.mjs';

test('quick-config allowlist contains exactly the user-facing toggles and priorities', () => {
  assert.deepEqual([...QUICK_CONFIG_KEYS].sort(), [
    'flash_model_priority',
    'imagegen_enabled',
    'imagegen_provider',
    'pro_model_priority',
    'subagents_enabled',
    'vision_enabled',
    'vision_provider',
  ].sort());
});

test('quick-config allowlist excludes privileged and engine keys', () => {
  const forbidden = [
    'worker', 'review', 'custom_providers', 'extra_models',
    'workspace', 'credentials', 'collaboration_mode', 'tier_policy',
    'adaptive', 'model_policy', 'execution', 'legacy',
  ];
  for (const key of forbidden) {
    assert.equal(QUICK_CONFIG_KEYS.includes(key), false, `quick surface must not write ${key}`);
  }
});
