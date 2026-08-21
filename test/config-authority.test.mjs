import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GLOBAL_CONFIG_DEFAULTS,
  GLOBAL_CONFIG_SCHEMA_VERSION,
  getGlobalConfigDiagnostics,
  readGlobalConfig,
  writeGlobalConfig,
} from '../src/install/install.mjs';
import { normalizeGlobalConfig } from '../src/policy.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-config-authority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'config.json');
}

function disk(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('fresh config exposes schema-v3 canonical authority without writing a file', (t) => {
  const file = fixture(t);
  const config = readGlobalConfig({ configFile: file });
  assert.equal(GLOBAL_CONFIG_SCHEMA_VERSION, 3);
  assert.equal(GLOBAL_CONFIG_DEFAULTS.config_schema_version, 3);
  assert.equal(config.config_schema_version, 3);
  assert.equal(config.config_authority, 'canonical');
  assert.equal(config.config_migration_required, false);
  assert.equal(config.execution.max_parallel, 3);
  assert.equal(config.worker.state, 'auto');
  assert.equal(config.review.state, 'disabled');
});

test('legacy files are imported read-only and report migration required', (t) => {
  const file = fixture(t);
  writeFileSync(file, JSON.stringify({
    tier_policy: 'auto',
    max_parallel: 2,
    worker_provider_mode: 'follow-dsh',
  }));

  const config = readGlobalConfig({ configFile: file });
  assert.equal(config.config_schema_version, 0);
  assert.equal(config.config_authority, 'legacy-import');
  assert.equal(config.config_migration_required, true);
  assert.equal(config.execution.max_parallel, 2);
  assert.equal(config.worker.provider_mode, 'follow-dsh');
  assert.equal(disk(file).config_schema_version, undefined, 'read must not mutate legacy file');

  const diagnostics = getGlobalConfigDiagnostics({ configFile: file });
  assert.equal(diagnostics.authority, 'legacy-import');
  assert.equal(diagnostics.migration_required, true);
});

test('first explicit save upgrades a legacy file and recompiles flat settings into canonical state', (t) => {
  const file = fixture(t);
  writeFileSync(file, JSON.stringify({ tier_policy: 'auto', max_parallel: 2 }));

  const saved = writeGlobalConfig({
    max_parallel: 5,
    collaboration_mode: 'review-pipeline',
    flash_model_priority: [{ provider: 'opencode-go', model: 'mimo-v2.5' }],
  }, { configFile: file });

  assert.equal(saved.config_schema_version, 3);
  assert.equal(saved.config_authority, 'canonical');
  assert.equal(saved.execution.max_parallel, 5);
  assert.equal(saved.review.auto_review, true);
  assert.deepEqual(saved.worker.model_policy.priority, [{ provider: 'opencode-go', model: 'mimo-v2.5' }]);

  const stored = disk(file);
  assert.equal(stored.config_schema_version, 3);
  assert.equal(stored.max_parallel, 5);
  assert.equal(stored.execution.max_parallel, 5);
  assert.equal(stored.tier_policy, 'auto');
  assert.equal(stored.review.auto_review, true);
  assert.equal(stored.config_authority, undefined, 'read metadata is not persisted');
  assert.equal(stored.config_migration_required, undefined, 'read metadata is not persisted');
});

test('schema-v3 canonical snapshot wins over conflicting legacy mirrors', (t) => {
  const file = fixture(t);
  writeGlobalConfig({
    max_parallel: 6,
    worker_state: 'manual',
    flash_model_priority: [{ provider: 'opencode-go', model: 'qwen3.7-plus' }],
  }, { configFile: file });

  const tampered = disk(file);
  tampered.max_parallel = 1;
  tampered.worker_state = 'disabled';
  tampered.flash_model_priority = [{ provider: 'wrong', model: 'wrong' }];
  tampered.collaboration_mode = 'balanced';
  tampered.tier_policy = 'auto';
  tampered.flash_state = 'disabled';
  tampered.pro_state = 'auto';
  writeFileSync(file, JSON.stringify(tampered, null, 2));

  const config = normalizeGlobalConfig(readGlobalConfig({ configFile: file }));
  assert.equal(config.execution.max_parallel, 6);
  assert.equal(config.max_parallel, 6);
  assert.equal(config.worker.state, 'manual');
  assert.equal(config.worker_state, 'manual');
  assert.equal(config.collaboration_mode, 'flash-only');
  assert.equal(config.tier_policy, 'flash-only');
  // Role state and legacy tier state are separate canonical dimensions in v3:
  // flash-only keeps its tier Auto while the worker role may be Manual.
  assert.equal(config.flash_state, 'auto');
  assert.equal(config.pro_state, 'disabled');
  assert.deepEqual(config.flash_model_priority, [{ provider: 'opencode-go', model: 'qwen3.7-plus' }]);

  const diagnostics = getGlobalConfigDiagnostics({ configFile: file });
  assert.equal(diagnostics.authority, 'canonical');
  assert.equal(diagnostics.migration_required, false);
  for (const key of [
    'max_parallel', 'worker_state', 'flash_model_priority',
    'collaboration_mode', 'tier_policy', 'flash_state', 'pro_state',
  ]) assert.ok(diagnostics.legacy_mirror_conflicts.includes(key), `${key} conflict should be reported`);
});

test('explicit canonical patches update authority and regenerate singular compatibility mirrors', (t) => {
  const file = fixture(t);
  writeGlobalConfig({}, { configFile: file });
  const saved = writeGlobalConfig({
    execution: { max_parallel: 7, enabled: false },
    worker: { state: 'manual', provider_mode: 'deepseek-official' },
    review: { provider_mode: 'follow-dsh' },
  }, { configFile: file });

  assert.equal(saved.execution.max_parallel, 7);
  assert.equal(saved.max_parallel, 7);
  assert.equal(saved.worker.state, 'manual');
  assert.equal(saved.worker_state, 'manual');
  assert.equal(saved.subagents_enabled, false);
  assert.equal(saved.execution.enabled, false);
  // One provider selector remains authoritative in v0.3. Worker wins when a
  // caller supplies both canonical branches in one patch.
  assert.equal(saved.worker_provider_mode, 'deepseek-official');
  assert.equal(saved.worker.provider_mode, 'deepseek-official');
  assert.equal(saved.review.provider_mode, 'deepseek-official');

  const stored = disk(file);
  assert.equal(stored.execution.max_parallel, 7);
  assert.equal(stored.max_parallel, 7);
  assert.equal(stored.worker.state, 'manual');
  assert.equal(stored.worker_state, 'manual');
  assert.equal(stored.subagents_enabled, false);
  assert.equal(stored.execution.enabled, false);
  assert.equal(stored.worker.provider_mode, stored.review.provider_mode);
});

test('an unrelated legacy UI write preserves canonical-only policy state', (t) => {
  const file = fixture(t);
  writeGlobalConfig({}, { configFile: file });
  const before = writeGlobalConfig({
    worker: {
      model_policy: {
        escalation: { enabled: true, max_attempts: 5 },
        escalation_priority: [{ provider: 'opencode-go', model: 'mimo-v2.5-pro' }],
        escalation_priority_configured: true,
      },
    },
  }, { configFile: file });
  assert.equal(before.worker.model_policy.escalation.max_attempts, 5);

  // This is the existing Settings UI shape: one flat field only. It must not
  // recompile the rest of canonical state from compatibility mirrors.
  const after = writeGlobalConfig({ max_parallel: 9 }, { configFile: file });
  assert.equal(after.execution.max_parallel, 9);
  assert.equal(after.worker.model_policy.escalation.enabled, true);
  assert.equal(after.worker.model_policy.escalation.max_attempts, 5);
  assert.deepEqual(after.worker.model_policy.escalation_priority, [
    { provider: 'opencode-go', model: 'mimo-v2.5-pro' },
  ]);
  assert.equal(after.worker.model_policy.escalation_priority_configured, true);
});

test('legacy routing commands translate only their owned canonical dimensions', (t) => {
  const file = fixture(t);
  writeGlobalConfig({}, { configFile: file });
  writeGlobalConfig({
    worker: { model_policy: { escalation: { enabled: true, max_attempts: 4 } } },
  }, { configFile: file });

  const reviewPipeline = writeGlobalConfig({ collaboration_mode: 'review-pipeline' }, { configFile: file });
  assert.equal(reviewPipeline.collaboration_mode, 'review-pipeline');
  assert.equal(reviewPipeline.worker.state, 'auto');
  assert.equal(reviewPipeline.review.state, 'auto');
  assert.equal(reviewPipeline.review.auto_review, true);
  assert.equal(reviewPipeline.worker.model_policy.escalation.max_attempts, 4);

  const balanced = writeGlobalConfig({ collaboration_mode: 'balanced' }, { configFile: file });
  assert.equal(balanced.collaboration_mode, 'balanced');
  assert.equal(balanced.worker.state, 'auto');
  assert.equal(balanced.review.state, 'manual');
  assert.equal(balanced.worker.model_policy.escalation.max_attempts, 4);
});

test('cache-busted config imports still resolve the v0.3 authority facade', async (t) => {
  const file = fixture(t);
  const moduleUrl = new URL('../src/install/install.mjs', import.meta.url);
  moduleUrl.searchParams.set('route-contract', `${Date.now()}-${Math.random()}`);
  const fresh = await import(moduleUrl.href);
  assert.equal(fresh.GLOBAL_CONFIG_SCHEMA_VERSION, 3);
  assert.equal(typeof fresh.readGlobalConfig, 'function');
  assert.equal(typeof fresh.writeGlobalConfig, 'function');

  writeFileSync(file, JSON.stringify({ tier_policy: 'auto', max_parallel: 2 }));
  const before = fresh.readGlobalConfig({ configFile: file });
  assert.equal(before.config_authority, 'legacy-import');
  const after = fresh.writeGlobalConfig({ max_parallel: 4 }, { configFile: file });
  assert.equal(after.config_authority, 'canonical');
  assert.equal(after.execution.max_parallel, 4);
});
