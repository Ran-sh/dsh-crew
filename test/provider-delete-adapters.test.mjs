import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectProviderProfile } from '../src/provider-profile-store.mjs';
import { planProviderDelete, executeProviderDelete } from '../src/provider-lifecycle.mjs';
import { createProviderDeleteFileHooks } from '../src/provider-delete-adapters.mjs';

const PROFILE = `- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        displayName: OpenCode Go\n        apiKeyEnv: OPENCODE_GO_API_KEY\n      openrouter:\n        displayName: openrouter\n        apiKeyEnv: OPENROUTER_API_KEY\n- insert:\n    - id: dsh-crew-hub\n`;

const CONFIG = {
  flash_model_priority: [{ provider: 'opencode-go', model: 'mimo-v2.5' }],
  flash_model_priority_configured: true,
  worker: { model_policy: { priority: [{ provider: 'opencode-go', model: 'mimo-v2.5' }], priorityConfigured: true } },
  harness_default: { provider: 'openrouter', model: 'free' },
};

const INVENTORY = {
  records: [
    {
      id: 'opencode-go', display_name: 'OpenCode Go', ownership: 'crew-managed-profile', origin: 'profile-managed',
      declaration: { present: true, file: 'profile.yml' }, desired_state: 'present',
      credential_refs: [{ kind: 'env', name_or_handle: 'OPENCODE_GO_API_KEY', ownership: 'crew' }],
      models: ['mimo-v2.5'],
      references: { harness_default: false, active_jobs: 0 },
    },
    {
      id: 'openrouter', display_name: 'openrouter', ownership: 'crew-managed-profile', origin: 'profile-managed',
      declaration: { present: true, file: 'profile.yml' }, desired_state: 'present',
      credential_refs: [{ kind: 'env', name_or_handle: 'OPENROUTER_API_KEY', ownership: 'user' }],
      models: ['minimax/minimax-m3:free'],
      references: { harness_default: true, active_jobs: 0 },
    },
  ],
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-provider-delete-'));
  const profileFile = join(dir, 'cordis.patch.yml');
  const configFile = join(dir, 'config.json');
  const lifecycleFile = join(dir, 'provider-lifecycle.json');
  writeFileSync(profileFile, PROFILE);
  writeFileSync(configFile, JSON.stringify(CONFIG, null, 2) + '\n');
  writeFileSync(lifecycleFile, JSON.stringify({ schema_version: 1, tombstones: {}, transactions: {}, last_verified_revision: {} }) + '\n');
  return { dir, profileFile, configFile, lifecycleFile };
}

function planFor(profileFile) {
  const expectedRevision = inspectProviderProfile(readFileSync(profileFile, 'utf8')).revision;
  return planProviderDelete({
    providerId: 'opencode-go', inventory: INVENTORY, replacementDefault: 'openrouter', expectedRevision,
  }).plan;
}

test('file adapters apply a deletion and verify absence without touching credentials', async () => {
  const paths = fixture();
  let config = { ...JSON.parse(readFileSync(paths.configFile, 'utf8')), custom_providers: [{ id: 'vision', api_key: 'SECRET_VALUE' }] };
  writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + '\n');
  const plan = planFor(paths.profileFile);
  const hooks = createProviderDeleteFileHooks({
    ...paths,
    backupDir: join(paths.dir, 'backups'),
    readConfig: () => config,
    writeConfig: (next) => { config = next; writeFileSync(paths.configFile, JSON.stringify(next, null, 2) + '\n'); },
    restart: async () => ({ ok: true }),
  });
  const result = await executeProviderDelete(plan, hooks);
  assert.equal(result.state, 'VERIFIED');
  assert.equal(result.error_code, null);
  assert.equal(readFileSync(paths.profileFile, 'utf8').includes('opencode-go:'), false);
  assert.deepEqual(config.worker.model_policy.priority, []);
  assert.equal(JSON.stringify(config).includes('SECRET_VALUE'), true, 'live config remains intact');
  const backupRoot = readdirSync(join(paths.dir, 'backups'), { withFileTypes: true })
    .find((entry) => entry.isDirectory());
  const backupText = readdirSync(join(paths.dir, 'backups', backupRoot.name))
    .map((file) => readFileSync(join(paths.dir, 'backups', backupRoot.name, file), 'utf8'))
    .join('\n');
  assert.equal(backupText.includes('SECRET_VALUE'), false);
  assert.equal(backupText.includes('OPENCODE_GO_API_KEY'), true, 'credential references are metadata, not values');
  const lifecycle = JSON.parse(readFileSync(paths.lifecycleFile, 'utf8'));
  assert.equal(lifecycle.tombstones['opencode-go'], 'absent');
  assert.equal(lifecycle.transactions[plan.plan_id]?.state, 'VERIFIED');
});

test('file adapters fail closed on malformed managed JSON', async () => {
  const paths = fixture();
  writeFileSync(paths.configFile, '{ malformed');
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir: join(paths.dir, 'backups'), restart: async () => ({ ok: true }) });
  const result = await executeProviderDelete(planFor(paths.profileFile), hooks);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error_code, 'PROVIDER_DELETE_FILE_INVALID');
  assert.equal(readFileSync(paths.profileFile, 'utf8').includes('opencode-go:'), true);
});

test('file adapters apply a valid replacement Harness Default', async () => {
  const paths = fixture();
  let config = { ...JSON.parse(readFileSync(paths.configFile, 'utf8')), harness_default: { provider: 'opencode-go', model: 'mimo-v2.5' } };
  writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + '\n');
  const hooks = createProviderDeleteFileHooks({
    ...paths,
    backupDir: join(paths.dir, 'backups'),
    readConfig: () => config,
    writeConfig: (next) => { config = next; writeFileSync(paths.configFile, JSON.stringify(next, null, 2) + '\n'); },
    restart: async () => ({ ok: true }),
  });
  const inventory = structuredClone(INVENTORY);
  inventory.records.find((record) => record.id === 'opencode-go').references.harness_default = true;
  inventory.records.find((record) => record.id === 'openrouter').references.harness_default = false;
  const expectedRevision = inspectProviderProfile(PROFILE).revision;
  const plan = planProviderDelete({
    providerId: 'opencode-go', inventory, replacementDefault: 'openrouter', expectedRevision,
  }).plan;
  const result = await executeProviderDelete(plan, hooks);
  assert.equal(result.state, 'VERIFIED');
  assert.deepEqual(config.harness_default, { provider: 'openrouter', model: 'minimax/minimax-m3:free' });
});

test('file adapters serialize concurrent transactions with a managed lock', async () => {
  const paths = fixture();
  const backupDir = join(paths.dir, 'backups');
  const first = createProviderDeleteFileHooks({ ...paths, backupDir, restart: async () => ({ ok: true }) });
  const second = createProviderDeleteFileHooks({ ...paths, backupDir, restart: async () => ({ ok: true }) });
  await first.backup(planFor(paths.profileFile));
  await assert.rejects(() => second.backup(planFor(paths.profileFile)), (error) => error.code === 'PROVIDER_DELETE_BUSY');
  await first.release();
  await second.release();
});

test('a persisted transaction backup can be reopened for an explicit rollback', async () => {
  const paths = fixture();
  const plan = planFor(paths.profileFile);
  const backupDir = join(paths.dir, 'backups');
  const first = createProviderDeleteFileHooks({ ...paths, backupDir, restart: async () => ({ ok: true }) });
  await first.backup(plan);
  await first.release();
  writeFileSync(paths.profileFile, PROFILE.replace(/      opencode-go:[\s\S]*?      openrouter:/, '      openrouter:'));
  const reopened = createProviderDeleteFileHooks({
    ...paths, backupDir, existingBackupId: plan.plan_id, expectedProviderId: plan.provider_id,
    restart: async () => ({ ok: true }),
  });
  await reopened.acquireLock();
  await reopened.checkpointApplied(plan);
  await reopened.rollback(plan);
  const verified = await reopened.verifyRollback(plan);
  await reopened.release();
  assert.equal(verified.ok, true);
  assert.equal(readFileSync(paths.profileFile, 'utf8').includes('opencode-go:'), true);
});

test('reopened rollback fails closed when an administrator changed managed state', async () => {
  const paths = fixture();
  const plan = planFor(paths.profileFile);
  const backupDir = join(paths.dir, 'backups');
  const first = createProviderDeleteFileHooks({ ...paths, backupDir, restart: async () => ({ ok: true }) });
  await first.backup(plan);
  await first.release();
  writeFileSync(paths.configFile, JSON.stringify({ ...CONFIG, flash_model_priority: [{ provider: 'openrouter', model: 'other' }] }));
  const reopened = createProviderDeleteFileHooks({ ...paths, backupDir, existingBackupId: plan.plan_id, expectedProviderId: plan.provider_id, restart: async () => ({ ok: true }) });
  await reopened.acquireLock();
  await assert.rejects(() => reopened.rollback(plan), (error) => error.code === 'PROVIDER_DELETE_STATE_CHANGED');
  await reopened.release();
});

test('file adapters fail before writes when the profile revision is stale', async () => {
  const paths = fixture();
  let config = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  const hooks = createProviderDeleteFileHooks({
    ...paths,
    backupDir: join(paths.dir, 'backups'),
    readConfig: () => config,
    writeConfig: (next) => { config = next; writeFileSync(paths.configFile, JSON.stringify(next, null, 2) + '\n'); },
    restart: async () => ({ ok: true }),
  });
  const plan = planFor(paths.profileFile);
  writeFileSync(paths.profileFile, PROFILE.replace('OpenCode Go', 'OpenCode Go changed'));
  const result = await executeProviderDelete(plan, hooks);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error_code, 'PROVIDER_PROFILE_CHANGED');
  assert.equal(readFileSync(paths.profileFile, 'utf8').includes('opencode-go:'), true);
  assert.equal(JSON.parse(readFileSync(paths.lifecycleFile, 'utf8')).tombstones['opencode-go'], undefined);
});

test('file adapter rollback restores every backed-up managed file', async () => {
  const paths = fixture();
  const originalProfile = readFileSync(paths.profileFile, 'utf8');
  const originalConfig = readFileSync(paths.configFile, 'utf8');
  const originalLifecycle = readFileSync(paths.lifecycleFile, 'utf8');
  let config = JSON.parse(originalConfig);
  const hooks = createProviderDeleteFileHooks({
    ...paths,
    backupDir: join(paths.dir, 'backups'),
    readConfig: () => config,
    writeConfig: (next) => { config = next; writeFileSync(paths.configFile, JSON.stringify(next, null, 2) + '\n'); },
    restart: async () => ({ ok: false, code: 'CREW_BACKEND_START_TIMEOUT' }),
  });
  const result = await executeProviderDelete(planFor(paths.profileFile), hooks);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.rollback_attempted, true);
  assert.equal(readFileSync(paths.profileFile, 'utf8'), originalProfile);
  assert.equal(readFileSync(paths.configFile, 'utf8'), originalConfig);
  const restoredLifecycle = JSON.parse(readFileSync(paths.lifecycleFile, 'utf8'));
  assert.deepEqual(restoredLifecycle.tombstones, {});
  assert.equal(restoredLifecycle.transactions[result.transaction_id].state, 'FAILED');
  assert.equal(originalLifecycle.includes('SECRET'), false);
  assert.equal(existsSync(join(paths.dir, 'backups')), true);
});
