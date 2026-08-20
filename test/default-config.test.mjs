import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLOBAL_CONFIG_DEFAULTS, mergeStoredGlobalConfig } from '../src/install/install.mjs';
import { normalizeGlobalConfig } from '../src/policy.mjs';

test('fresh defaults are the minimal Codex to Flash workflow', () => {
  assert.equal(GLOBAL_CONFIG_DEFAULTS.subagents_enabled, true);
  assert.equal(GLOBAL_CONFIG_DEFAULTS.collaboration_mode, 'flash-only');
  assert.equal(GLOBAL_CONFIG_DEFAULTS.tier_policy, 'flash-only');
  assert.equal(GLOBAL_CONFIG_DEFAULTS.flash_state, 'auto');
  assert.equal(GLOBAL_CONFIG_DEFAULTS.pro_state, 'disabled');
  assert.equal(GLOBAL_CONFIG_DEFAULTS.main_agent_mode, 'direct-allowed');
  assert.equal(GLOBAL_CONFIG_DEFAULTS.vision_enabled, false);
  assert.equal(GLOBAL_CONFIG_DEFAULTS.imagegen_enabled, false);
  assert.equal(GLOBAL_CONFIG_DEFAULTS.worker_provider_mode, 'follow-dsh');
  assert.deepEqual(GLOBAL_CONFIG_DEFAULTS.flash_model_priority, []);
  assert.deepEqual(GLOBAL_CONFIG_DEFAULTS.pro_model_priority, []);
});

test('an existing pre-feature config keeps legacy modes while gaining safe model fields', () => {
  const config = mergeStoredGlobalConfig({ tier_policy: 'auto', vision_provider: 'claude-code', imagegen_provider: 'codex' });
  assert.equal(config.collaboration_mode, 'balanced');
  assert.equal(config.flash_state, 'auto');
  assert.equal(config.pro_state, 'auto');
  assert.equal(config.main_agent_mode, 'coordinator-first');
  assert.equal(config.worker_provider_mode, 'deepseek-official');
  assert.equal(config.vision_enabled, true);
  assert.equal(config.imagegen_enabled, true);
  assert.deepEqual(config.flash_model_priority, []);
});

test('existing explicit advanced settings and model priorities survive normalization', () => {
  for (const mode of ['balanced', 'pro-only', 'review-pipeline', 'custom']) {
    const normalized = normalizeGlobalConfig({
      collaboration_mode: mode,
      flash_state: 'manual', pro_state: 'auto', vision_enabled: true, imagegen_enabled: true,
      flash_model_priority: [{ provider: 'a', model: 'm1' }],
      pro_model_priority: [{ provider: 'b', model: 'm2' }],
    });
    assert.equal(normalized.collaboration_mode, mode);
    assert.equal(normalized.vision_enabled, true);
    assert.equal(normalized.imagegen_enabled, true);
    assert.deepEqual(normalized.flash_model_priority, [{ provider: 'a', model: 'm1' }]);
    assert.deepEqual(normalized.pro_model_priority, [{ provider: 'b', model: 'm2' }]);
  }
});
