import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeProviderLayerMigration } from '../src/provider-layer-migration.mjs';
import { createProviderLayerMigrationFileHooks, readProviderLayerMigrationTransactions } from '../src/provider-layer-migration-adapters.mjs';
import { readProviderMaterialization } from '../src/provider-profile-store.mjs';

const PLAN = {
  schema_version: 1,
  kind: 'provider-layer-migration',
  plan_id: 'migration-1',
  provider_id: 'custom',
  action: 'materialize-user',
  expected_revisions: { profile: 'a'.repeat(64), settings: null },
  materialization: { provider: { id: 'custom', display_name: 'Custom', models: [{ id: 'model-1' }] } },
};

test('migration execution requires explicit confirmation and stays side-effect free', async () => {
  let called = false;
  const result = await executeProviderLayerMigration(PLAN, { backup: async () => { called = true; } }, { confirm: false });
  assert.deepEqual(result, { ok: false, state: 'BLOCKED', code: 'PROVIDER_MIGRATION_CONFIRM_REQUIRED', transaction_id: 'migration-1' });
  assert.equal(called, false);
});

test('migration execution supports deferred restart and ordered adapters', async () => {
  const calls = [];
  const hooks = {
    backup: async () => calls.push('backup'),
    materialize: async () => calls.push('materialize'),
    removeBase: async () => calls.push('removeBase'),
    rollback: async () => calls.push('rollback'),
  };
  const result = await executeProviderLayerMigration(PLAN, hooks, { confirm: true, deferRestart: true });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'RESTART_PENDING');
  assert.deepEqual(calls, ['backup', 'materialize', 'removeBase']);
});

test('migration execution rolls back when verification fails', async () => {
  const calls = [];
  const result = await executeProviderLayerMigration(PLAN, {
    backup: async () => calls.push('backup'),
    materialize: async () => calls.push('materialize'),
    removeBase: async () => calls.push('removeBase'),
    restart: async () => calls.push('restart'),
    verify: async () => ({ nativeRemovable: false, baseAbsent: false, userPresent: true }),
    rollback: async () => calls.push('rollback'),
  }, { confirm: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_MIGRATION_VERIFY_FAILED');
  assert.equal(result.rollback_attempted, true);
  assert.deepEqual(calls, ['backup', 'materialize', 'removeBase', 'restart', 'rollback']);
});

test('filesystem adapter materializes settings, removes base, and can restore the snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-'));
  try {
    const profileFile = join(root, 'profile.yml');
    const settingsFile = join(root, 'settings.yaml');
    const backupDir = join(root, 'backups');
    const profile = `- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        displayName: Custom\n        apiKeyEnv: CUSTOM_API_KEY\n        api: openai-completions\n        baseURL: https://example.test/v1\n        models:\n          - id: model-1\n            name: Model One\n- insert:\n    - id: dsh-crew-hub\n`;
    const settings = 'llm-pi-ai:\n  providers: {}\nagent-default-model:\n  provider: custom\n  model: model-1\n';
    writeFileSync(profileFile, profile, 'utf8');
    writeFileSync(settingsFile, settings, 'utf8');
    const material = readProviderMaterialization(profile, { providerId: 'custom' });
    assert.equal(material.ok, true);
    assert.deepEqual(material.provider.models, [{ id: 'model-1', name: 'Model One' }]);
    const plan = {
      ...PLAN,
      expected_revisions: {
        profile: createHash('sha256').update(profile, 'utf8').digest('hex'),
        settings: createHash('sha256').update(settings, 'utf8').digest('hex'),
      },
      materialization: { provider: material.provider },
    };
    const hooks = createProviderLayerMigrationFileHooks({ profileFile, settingsFile, backupDir });
    await hooks.acquireLock();
    const result = await executeProviderLayerMigration(plan, hooks, { confirm: true, deferRestart: true });
    await hooks.release();
    assert.equal(result.state, 'RESTART_PENDING');
    assert.equal(readProviderMaterialization(readFileSync(profileFile, 'utf8'), { providerId: 'custom' }).ok, false);
    assert.equal(readFileSync(settingsFile, 'utf8').includes('    custom:'), true);

    const rollbackHooks = createProviderLayerMigrationFileHooks({ profileFile, settingsFile, backupDir, existingMigrationId: plan.plan_id });
    await rollbackHooks.acquireLock();
    await rollbackHooks.backup({});
    await rollbackHooks.rollback();
    await rollbackHooks.release();
    assert.equal(readProviderMaterialization(readFileSync(profileFile, 'utf8'), { providerId: 'custom' }).ok, true);
    assert.equal(readFileSync(settingsFile, 'utf8'), settings);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration recovery scanner exposes only nonterminal, secret-free transactions', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-scan-'));
  try {
    mkdirSync(join(root, 'tx-1'), { recursive: true });
    const manifest = {
      kind: 'provider-layer-migration', plan_id: 'tx-1', provider_id: 'custom', phase: 'BASE_REMOVED',
      plan: { plan_id: 'tx-1', provider_id: 'custom', action: 'materialize-user', expected_revisions: { profile: 'a'.repeat(64), settings: 'b'.repeat(64) }, materialization: { provider: { id: 'custom', display_name: 'Custom', models: [] } } },
      files: {
        profile: { existed: true, revision: 'a'.repeat(64) },
        settings: { existed: true, revision: 'b'.repeat(64) },
      },
    };
    const withoutChecksum = JSON.stringify(manifest);
    manifest.checksum = createHash('sha256').update(withoutChecksum, 'utf8').digest('hex');
    writeFileSync(join(root, 'tx-1', 'manifest.json'), JSON.stringify(manifest), 'utf8');
    mkdirSync(join(root, 'tx-2'), { recursive: true });
    const terminalManifest = {
      kind: 'provider-layer-migration', plan_id: 'tx-2', provider_id: 'done', phase: 'VERIFIED',
      plan: { plan_id: 'tx-2', provider_id: 'done', action: 'materialize-user', expected_revisions: { profile: 'a'.repeat(64), settings: 'b'.repeat(64) }, materialization: { provider: { id: 'done', display_name: 'Done', models: [] } } },
      files: {
        profile: { existed: true, revision: 'a'.repeat(64) },
        settings: { existed: true, revision: 'b'.repeat(64) },
      },
    };
    terminalManifest.checksum = createHash('sha256').update(JSON.stringify(terminalManifest), 'utf8').digest('hex');
    writeFileSync(join(root, 'tx-2', 'manifest.json'), JSON.stringify(terminalManifest), 'utf8');
    const records = readProviderLayerMigrationTransactions(root);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], {
      storage_id: 'tx-1', action_id: records[0].action_id, transaction_id: 'tx-1', provider_id: 'custom', phase: 'BASE_REMOVED',
      updated_at: records[0].updated_at, recoverable: true, unresolved: false, source: 'provider-layer-migration',
    });
    assert.doesNotMatch(JSON.stringify(records), /drop/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration backup refuses inline credentials belonging to a retained sibling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-secret-'));
  try {
    const profileFile = join(root, 'profile.yml');
    const settingsFile = join(root, 'settings.yaml');
    const backupDir = join(root, 'backups');
    writeFileSync(profileFile, `- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        displayName: Custom\n      retained:\n        apiKey: RETAINED_SECRET\n`, 'utf8');
    writeFileSync(settingsFile, 'llm-pi-ai:\n  providers: {}\n', 'utf8');
    const hooks = createProviderLayerMigrationFileHooks({ profileFile, settingsFile, backupDir });
    await assert.rejects(() => hooks.backup(PLAN), (error) => error.code === 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED');
    assert.equal(readFileSync(profileFile, 'utf8').includes('RETAINED_SECRET'), true);
    assert.equal(readProviderLayerMigrationTransactions(backupDir).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration scanner marks incomplete manifests unresolved with an opaque action id', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-invalid-'));
  try {
    mkdirSync(join(root, 'broken'), { recursive: true });
    writeFileSync(join(root, 'broken', 'manifest.json'), JSON.stringify({ kind: 'provider-layer-migration', plan_id: 'broken', provider_id: 'custom', phase: 'BASE_REMOVED' }), 'utf8');
    const records = readProviderLayerMigrationTransactions(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].unresolved, true);
    assert.equal(records[0].recoverable, false);
    assert.match(records[0].action_id, /^[a-f0-9]{32}$/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration lock refuses malformed owner metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-lock-'));
  try {
    const backupDir = join(root, 'backups');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, '.migration.lock'), 'null', 'utf8');
    const hooks = createProviderLayerMigrationFileHooks({ profileFile: join(root, 'profile.yml'), settingsFile: join(root, 'settings.yaml'), backupDir });
    await assert.rejects(() => hooks.acquireLock(), (error) => error.code === 'PROVIDER_MIGRATION_BUSY');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration quarantine uses the fenced adapter and moves unresolved entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-quarantine-'));
  try {
    const profileFile = join(root, 'profile.yml');
    const settingsFile = join(root, 'settings.yaml');
    const backupDir = join(root, 'backups');
    mkdirSync(join(backupDir, 'broken'), { recursive: true });
    writeFileSync(join(backupDir, 'broken', 'manifest.json'), '{}', 'utf8');
    const actionId = createHash('sha256').update('broken', 'utf8').digest('hex').slice(0, 32);
    const hooks = createProviderLayerMigrationFileHooks({ profileFile, settingsFile, backupDir });
    const result = await hooks.quarantine(actionId);
    assert.equal(result.ok, true);
    assert.equal(result.state, 'QUARANTINED');
    assert.equal(readProviderLayerMigrationTransactions(backupDir).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('provider materialization rejects credential-bearing base URLs', () => {
  const source = `- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        displayName: Custom\n        baseURL: https://user:sk-live-secret@example.test/v1\n`;
  const result = readProviderMaterialization(source, { providerId: 'custom' });
  assert.deepEqual(result, { ok: false, code: 'PROVIDER_BASE_URL_UNSAFE' });
  assert.equal(JSON.stringify(result).includes('sk-live-secret'), false);
});
