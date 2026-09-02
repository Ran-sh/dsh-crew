import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeProviderLayerMigration } from '../src/provider-layer-migration.mjs';
import { createProviderLayerMigrationFileHooks, readProviderLayerMigrationTransactions } from '../src/provider-layer-migration-adapters.mjs';
import { readProviderMaterialization } from '../src/provider-profile-store.mjs';
import { readProviderSettingsMaterialization } from '../src/provider-settings-store.mjs';

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
    const profile = `- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        displayName: Custom\n        apiKeyEnv: CUSTOM_API_KEY\n        api: openai-completions\n        baseURL: https://example.test/v1\n        models:\n          - id: model-1\n            name: Model One\n            contextWindow: 1000000\n            maxTokens: 384000\n            input: [text]\n            reasoningEfforts:\n              off: null\n              max: reasoning_effort_max\n- insert:\n    - id: dsh-crew-hub\n`;
    const settings = 'llm-pi-ai:\n  providers: {}\nagent-default-model:\n  provider: custom\n  model: model-1\n';
    writeFileSync(profileFile, profile, 'utf8');
    writeFileSync(settingsFile, settings, 'utf8');
    const material = readProviderMaterialization(profile, { providerId: 'custom' });
    assert.equal(material.ok, true);
    assert.deepEqual(material.provider.models, [{ id: 'model-1', name: 'Model One', context_window: 1000000, max_tokens: 384000, input: ['text'], reasoning_efforts: { off: null, max: 'reasoning_effort_max' } }]);
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
    await rollbackHooks.rollback();
    await rollbackHooks.release();
    assert.equal(readProviderMaterialization(readFileSync(profileFile, 'utf8'), { providerId: 'custom' }).ok, true);
    assert.equal(readFileSync(settingsFile, 'utf8'), settings);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration runtime baselines survive reopen in both restart phases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-baseline-'));
  try {
    const profileFile = join(root, 'profile.yml');
    const settingsFile = join(root, 'settings.yaml');
    const backupDir = join(root, 'backups');
    const profile = '- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        displayName: Custom\n';
    writeFileSync(profileFile, profile, 'utf8');
    const plan = {
      ...PLAN,
      plan_id: '11111111-1111-4111-8111-111111111111',
      expected_revisions: { profile: createHash('sha256').update(profile, 'utf8').digest('hex'), settings: null },
      materialization: { provider: { id: 'custom', display_name: 'Custom', models: [] } },
    };
    const hooks = createProviderLayerMigrationFileHooks({ profileFile, settingsFile, backupDir });
    await hooks.acquireLock();
    const applied = await executeProviderLayerMigration(plan, hooks, { confirm: true, deferRestart: true });
    assert.equal(applied.state, 'RESTART_PENDING');
    await hooks.setRestartRuntimeBaseline('runtime-before-migrate-restart');
    await hooks.release();

    const reopened = createProviderLayerMigrationFileHooks({ profileFile, settingsFile, backupDir, existingMigrationId: plan.plan_id });
    await reopened.acquireLock();
    await reopened.backup({});
    assert.equal(reopened.backupPlan().runtime_id_before_restart, 'runtime-before-migrate-restart');
    await reopened.rollback();
    await reopened.setRollbackRuntimeBaseline('runtime-before-rollback-restart');
    await reopened.release();

    const reopenedRollback = createProviderLayerMigrationFileHooks({ profileFile, settingsFile, backupDir, existingMigrationId: plan.plan_id });
    await reopenedRollback.acquireLock();
    await reopenedRollback.backup({});
    assert.equal(reopenedRollback.backupPlan().rollback_runtime_id_before, 'runtime-before-rollback-restart');
    await reopenedRollback.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('promote-existing-user rollback rejects drifted user-layer semantics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-promote-drift-'));
  try {
    const profileFile = join(root, 'profile.yml');
    const settingsFile = join(root, 'settings.yaml');
    const backupDir = join(root, 'backups');
    const profile = '- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        displayName: Custom\n        api: openai-completions\n        baseURL: https://example.test/v1\n        models:\n          - id: model-1\n';
    const settings = 'llm-pi-ai:\n  providers:\n    custom:\n      displayName: Custom\n      api: openai-completions\n      baseURL: https://example.test/v1\n      models:\n        - id: model-1\nagent-default-model:\n  provider: custom\n  model: model-1\n';
    writeFileSync(profileFile, profile, 'utf8');
    writeFileSync(settingsFile, settings, 'utf8');
    const user = readProviderSettingsMaterialization(settings, { providerId: 'custom' });
    assert.equal(user.ok, true);
    const plan = {
      ...PLAN,
      plan_id: '22222222-2222-4222-8222-222222222222',
      action: 'promote-existing-user',
      expected_revisions: {
        profile: createHash('sha256').update(profile, 'utf8').digest('hex'),
        settings: createHash('sha256').update(settings, 'utf8').digest('hex'),
      },
      materialization: { provider: readProviderMaterialization(profile, { providerId: 'custom' }).provider },
      user_materialization_before: user.provider,
    };
    const hooks = createProviderLayerMigrationFileHooks({ profileFile, settingsFile, backupDir });
    await hooks.acquireLock();
    const applied = await executeProviderLayerMigration(plan, hooks, { confirm: true, deferRestart: true });
    assert.equal(applied.state, 'RESTART_PENDING');
    await hooks.release();
    writeFileSync(settingsFile, settings.replace('openai-completions', 'anthropic-messages'), 'utf8');
    const reopened = createProviderLayerMigrationFileHooks({ profileFile, settingsFile, backupDir, existingMigrationId: plan.plan_id });
    await reopened.acquireLock();
    await reopened.backup({});
    await assert.rejects(() => reopened.rollback(), (error) => error.code === 'PROVIDER_MIGRATION_STATE_CHANGED');
    await reopened.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('promote-existing-user forward verification rejects drift before finalization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-forward-drift-'));
  try {
    const profileFile = join(root, 'profile.yml');
    const settingsFile = join(root, 'settings.yaml');
    const backupDir = join(root, 'backups');
    const profile = '- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        displayName: Custom\n        api: openai-completions\n        baseURL: https://example.test/v1\n        models:\n          - id: model-1\n';
    const settings = 'llm-pi-ai:\n  providers:\n    custom:\n      displayName: Custom\n      api: openai-completions\n      baseURL: https://example.test/v1\n      models:\n        - id: model-1\nagent-default-model:\n  provider: custom\n  model: model-1\n';
    writeFileSync(profileFile, profile, 'utf8');
    writeFileSync(settingsFile, settings, 'utf8');
    const base = readProviderMaterialization(profile, { providerId: 'custom' });
    const user = readProviderSettingsMaterialization(settings, { providerId: 'custom' });
    const plan = {
      ...PLAN,
      plan_id: '33333333-3333-4333-8333-333333333333',
      action: 'promote-existing-user',
      expected_revisions: { profile: createHash('sha256').update(profile, 'utf8').digest('hex'), settings: createHash('sha256').update(settings, 'utf8').digest('hex') },
      materialization: { provider: base.provider },
      user_materialization_before: user.provider,
    };
    const hooks = createProviderLayerMigrationFileHooks({ profileFile, settingsFile, backupDir });
    await hooks.acquireLock();
    assert.equal((await executeProviderLayerMigration(plan, hooks, { confirm: true, deferRestart: true })).state, 'RESTART_PENDING');
    writeFileSync(settingsFile, settings.replace('openai-completions', 'anthropic-messages'), 'utf8');
    const verification = await hooks.verify(plan);
    assert.equal(verification.ok, false);
    assert.equal(verification.userSemanticsPreserved, false);
    await hooks.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration recovery scanner exposes only nonterminal, secret-free transactions', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-scan-'));
  try {
    mkdirSync(join(root, 'tx-1'), { recursive: true });
    const manifest = {
      schema_version: 1, kind: 'provider-layer-migration', plan_id: 'tx-1', provider_id: 'custom', phase: 'BASE_REMOVED',
      plan: { schema_version: 1, kind: 'provider-layer-migration', plan_id: 'tx-1', provider_id: 'custom', action: 'materialize-user', expected_revisions: { profile: 'a'.repeat(64), settings: 'b'.repeat(64) }, materialization: { provider: { id: 'custom', display_name: 'Custom', models: [] } } },
      files: {
        profile: { existed: true, revision: 'a'.repeat(64) },
        settings: { existed: true, revision: 'b'.repeat(64) },
      },
      applied_revisions: {},
      mutation_journal: {},
      created_at: '2024-01-01T00:00:00.000Z',
    };
    const withoutChecksum = JSON.stringify(manifest);
    manifest.checksum = createHash('sha256').update(withoutChecksum, 'utf8').digest('hex');
    writeFileSync(join(root, 'tx-1', 'manifest.json'), JSON.stringify(manifest), 'utf8');
    mkdirSync(join(root, 'tx-2'), { recursive: true });
    const terminalManifest = {
      schema_version: 1, kind: 'provider-layer-migration', plan_id: 'tx-2', provider_id: 'done', phase: 'VERIFIED',
      plan: { schema_version: 1, kind: 'provider-layer-migration', plan_id: 'tx-2', provider_id: 'done', action: 'materialize-user', expected_revisions: { profile: 'a'.repeat(64), settings: 'b'.repeat(64) }, materialization: { provider: { id: 'done', display_name: 'Done', models: [] } } },
      files: {
        profile: { existed: true, revision: 'a'.repeat(64) },
        settings: { existed: true, revision: 'b'.repeat(64) },
      },
      applied_revisions: {},
      mutation_journal: {},
      created_at: '2024-01-01T00:00:00.000Z',
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

test('migration recovery scanner preserves every unresolved transaction beyond the UI window', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-many-'));
  try {
    for (let index = 0; index < 70; index += 1) {
      mkdirSync(join(root, `broken-${index}`), { recursive: true });
      writeFileSync(join(root, `broken-${index}`, 'manifest.json'), '{ malformed', 'utf8');
    }
    const records = readProviderLayerMigrationTransactions(root);
    assert.equal(records.length, 70);
    assert.equal(records.every((entry) => entry.unresolved === true), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration scanner rejects unknown executable manifest fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-schema-'));
  try {
    mkdirSync(join(root, 'tx-unknown'), { recursive: true });
    writeFileSync(join(root, 'tx-unknown', 'manifest.json'), JSON.stringify({
      schema_version: 1,
      kind: 'provider-layer-migration',
      plan_id: 'tx-unknown',
      provider_id: 'custom',
      phase: 'BASE_REMOVED',
      evil: 'must-fail-closed',
    }), 'utf8');
    const records = readProviderLayerMigrationTransactions(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].unresolved, true);
    assert.equal(records[0].recoverable, false);
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
    const unsafeProfile = readFileSync(profileFile, 'utf8');
    const unsafeSettings = readFileSync(settingsFile, 'utf8');
    const unsafePlan = { ...PLAN, expected_revisions: { profile: createHash('sha256').update(unsafeProfile, 'utf8').digest('hex'), settings: createHash('sha256').update(unsafeSettings, 'utf8').digest('hex') } };
    await assert.rejects(() => hooks.backup(unsafePlan), (error) => error.code === 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED');
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

test('migration scanner surfaces non-directory recovery artifacts instead of dropping them', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-artifact-'));
  try {
    writeFileSync(join(root, 'unexpected'), 'not a transaction', 'utf8');
    const records = readProviderLayerMigrationTransactions(root);
    assert.equal(records.length, 1);
    assert.equal(records[0].unresolved, true);
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

test('migration lock recovery is explicit and repairs malformed shared ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-recover-'));
  try {
    const backupDir = join(root, 'backups');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(root, 'provider-store.lock'), 'null', 'utf8');
    writeFileSync(join(backupDir, '.migration.lock'), 'null', 'utf8');
    const hooks = createProviderLayerMigrationFileHooks({ profileFile: join(root, 'profile.yml'), settingsFile: join(root, 'settings.yaml'), backupDir });
    assert.deepEqual(await hooks.recoverLock(), { ok: false, code: 'PROVIDER_STORE_LOCK_CONFIRM_REQUIRED' });
    const recovered = await hooks.recoverLock({ confirm: true });
    assert.equal(recovered.ok, true);
    assert.equal(existsSync(join(root, 'provider-store.lock')), false);
    assert.equal(existsSync(join(backupDir, '.migration.lock')), false);
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

test('rollback refuses an externally recreated settings file that matches content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-migration-ownership-'));
  try {
    const profileFile = join(root, 'profile.yml');
    const settingsFile = join(root, 'settings.yaml');
    const backupDir = join(root, 'backups');
    const profile = `- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        displayName: Custom\n- insert:\n    - id: dsh-crew-hub\n`;
    writeFileSync(profileFile, profile, 'utf8');
    const material = readProviderMaterialization(profile, { providerId: 'custom' });
    const plan = { ...PLAN, expected_revisions: { profile: createHash('sha256').update(profile, 'utf8').digest('hex'), settings: null }, materialization: { provider: material.provider } };
    const hooks = createProviderLayerMigrationFileHooks({ profileFile, settingsFile, backupDir });
    await hooks.acquireLock();
    await executeProviderLayerMigration(plan, hooks, { confirm: true, deferRestart: true });
    await hooks.release();
    const sameContent = readFileSync(settingsFile, 'utf8');
    rmSync(settingsFile, { force: true });
    writeFileSync(settingsFile, sameContent, 'utf8');
    utimesSync(settingsFile, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const rollbackHooks = createProviderLayerMigrationFileHooks({ profileFile, settingsFile, backupDir, existingMigrationId: plan.plan_id });
    await rollbackHooks.acquireLock();
    await rollbackHooks.backup({});
    await assert.rejects(() => rollbackHooks.rollback(), (error) => error.code === 'PROVIDER_MIGRATION_STATE_CHANGED');
    await rollbackHooks.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('provider materialization rejects credential-bearing base URLs', () => {
  const source = `- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        displayName: Custom\n        baseURL: https://user:sk-live-secret@example.test/v1\n`;
  const result = readProviderMaterialization(source, { providerId: 'custom' });
  assert.deepEqual(result, { ok: false, code: 'PROVIDER_BASE_URL_UNSAFE' });
  assert.equal(JSON.stringify(result).includes('sk-live-secret'), false);
});

test('provider materialization rejects unknown provider fields instead of losing them on rollback', () => {
  const source = `- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        displayName: Custom\n        timeoutMs: 30\n`;
  assert.deepEqual(readProviderMaterialization(source, { providerId: 'custom' }), { ok: false, code: 'PROVIDER_MATERIALIZATION_UNSUPPORTED_FIELDS' });
});

test('provider materialization rejects secret-shaped API adapter values', () => {
  const source = `- id: llm-pi-ai\n  config:\n    providers:\n      custom:\n        displayName: Custom\n        api: sk-live-secret\n`;
  assert.deepEqual(readProviderMaterialization(source, { providerId: 'custom' }), { ok: false, code: 'PROVIDER_API_SCHEMA_UNSUPPORTED' });
});
