import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLOBAL_CONFIG_DEFAULTS, mergeStoredGlobalConfig, readGlobalConfig } from '../src/install/install.mjs';
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
  assert.equal(GLOBAL_CONFIG_DEFAULTS.worker_provider_mode, 'deepseek-official');
  assert.deepEqual(GLOBAL_CONFIG_DEFAULTS.flash_model_priority, []);
  assert.deepEqual(GLOBAL_CONFIG_DEFAULTS.pro_model_priority, []);
  assert.equal(GLOBAL_CONFIG_DEFAULTS.vision_provider, 'off');
  assert.equal(GLOBAL_CONFIG_DEFAULTS.imagegen_provider, 'off');
  assert.deepEqual(GLOBAL_CONFIG_DEFAULTS.custom_providers, []);
  assert.deepEqual(GLOBAL_CONFIG_DEFAULTS.extra_models, {});
  assert.equal(GLOBAL_CONFIG_DEFAULTS.preset_flash, 'default');
});

test('a missing config file reads and normalizes to the fresh runtime workflow', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-crew-fresh-config-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const config = normalizeGlobalConfig(readGlobalConfig({ configFile: join(fixture, 'missing-config.json') }));
  assert.equal(config.subagents_enabled, true);
  assert.equal(config.collaboration_mode, 'flash-only');
  assert.equal(config.flash_state, 'auto');
  assert.equal(config.pro_state, 'disabled');
  assert.equal(config.main_agent_mode, 'direct-allowed');
  assert.equal(config.worker_provider_mode, 'deepseek-official');
  assert.equal(config.vision_enabled, false);
  assert.equal(config.imagegen_enabled, false);
  assert.equal(config.vision_provider, 'off');
  assert.equal(config.imagegen_provider, 'off');
  assert.deepEqual(config.custom_providers, []);
  assert.deepEqual(config.extra_models, {});
  assert.equal(config.flash_model_fallback, 'harness-default');
  assert.equal(config.pro_model_fallback, 'harness-default');
  assert.equal(config.preset_flash, 'default');
});

test('an existing pre-feature config keeps legacy modes while gaining safe model fields and preset', () => {
  const config = normalizeGlobalConfig(mergeStoredGlobalConfig({ tier_policy: 'auto', vision_provider: 'claude-code', imagegen_provider: 'codex' }));
  assert.equal(config.collaboration_mode, 'balanced');
  assert.equal(config.flash_state, 'auto');
  assert.equal(config.pro_state, 'auto');
  assert.equal(config.main_agent_mode, 'coordinator-first');
  assert.equal(config.worker_provider_mode, 'deepseek-official');
  assert.equal(config.vision_enabled, true);
  assert.equal(config.imagegen_enabled, true);
  assert.equal(config.preset_flash, 'default');
  assert.deepEqual(config.flash_model_priority, []);
});

test('an explicit existing configuration survives merge and normalization', () => {
  const config = normalizeGlobalConfig(mergeStoredGlobalConfig({
    collaboration_mode: 'review-pipeline',
    main_agent_mode: 'dispatcher-only',
    worker_provider_mode: 'deepseek-official',
    vision_enabled: true,
    preset_flash: 'minimal',
    flash_model_priority: [{ provider: 'a', model: 'm1' }],
    pro_model_priority: [{ provider: 'b', model: 'm2' }],
  }));
  assert.equal(config.collaboration_mode, 'review-pipeline');
  assert.equal(config.main_agent_mode, 'dispatcher-only');
  assert.equal(config.worker_provider_mode, 'deepseek-official');
  assert.equal(config.vision_enabled, true);
  assert.equal(config.preset_flash, 'minimal');
  assert.deepEqual(config.flash_model_priority, [{ provider: 'a', model: 'm1' }]);
  assert.deepEqual(config.pro_model_priority, [{ provider: 'b', model: 'm2' }]);
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

test('v0.2 runtime execution fields are persistable and normalize into the runtime shape', () => {
  assert.equal(GLOBAL_CONFIG_DEFAULTS.max_parallel, 3);
  assert.equal(GLOBAL_CONFIG_DEFAULTS.isolation, 'worktree');
  const stored = mergeStoredGlobalConfig({ max_parallel: 2, isolation: 'shared' });
  const normalized = normalizeGlobalConfig(stored);
  assert.equal(normalized.execution.max_parallel, 2);
  assert.equal(normalized.execution.isolation, 'shared');
});

test('v0.2 role-state overrides normalize into the canonical shape (writable via config)', () => {
  const normalized = normalizeGlobalConfig({ worker_state: 'manual', review_state: 'disabled', auto_review: true });
  assert.equal(normalized.worker.state, 'manual');
  assert.equal(normalized.review.state, 'disabled');
  assert.equal(normalized.review.auto_review, true);
});
