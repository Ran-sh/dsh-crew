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
  writeFileSync(file, JSON.stringify(tampered, null, 2));

  const config = normalizeGlobalConfig(readGlobalConfig({ configFile: file }));
  assert.equal(config.execution.max_parallel, 6);
  assert.equal(config.max_parallel, 6);
  assert.equal(config.worker.state, 'manual');
  assert.equal(config.worker_state, 'manual');
  assert.deepEqual(config.flash_model_priority, [{ provider: 'opencode-go', model: 'qwen3.7-plus' }]);

  const diagnostics = getGlobalConfigDiagnostics({ configFile: file });
  assert.equal(diagnostics.authority, 'canonical');
  assert.equal(diagnostics.migration_required, false);
  assert.ok(diagnostics.legacy_mirror_conflicts.includes('max_parallel'));
  assert.ok(diagnostics.legacy_mirror_conflicts.includes('worker_state'));
  assert.ok(diagnostics.legacy_mirror_conflicts.includes('flash_model_priority'));
});

test('explicit canonical patches update the authority and regenerate compatibility mirrors', (t) => {
  const file = fixture(t);
  writeGlobalConfig({}, { configFile: file });
  const saved = writeGlobalConfig({
    execution: { max_parallel: 7 },
    worker: { state: 'manual' },
  }, { configFile: file });

  assert.equal(saved.execution.max_parallel, 7);
  assert.equal(saved.max_parallel, 7);
  assert.equal(saved.worker.state, 'manual');
  assert.equal(saved.worker_state, 'manual');

  const stored = disk(file);
  assert.equal(stored.execution.max_parallel, 7);
  assert.equal(stored.max_parallel, 7);
  assert.equal(stored.worker.state, 'manual');
  assert.equal(stored.worker_state, 'manual');
});
