import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectProviderProfile } from '../src/provider-profile-store.mjs';
import { inspectProviderSettings } from '../src/provider-settings-store.mjs';
import { planProviderDelete, executeProviderDelete } from '../src/provider-lifecycle.mjs';
import { createProviderDeleteFileHooks } from '../src/provider-delete-adapters.mjs';

const PROFILE = `- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        displayName: OpenCode Go\n        apiKeyEnv: OPENCODE_GO_API_KEY\n      openrouter:\n        displayName: openrouter\n        apiKeyEnv: OPENROUTER_API_KEY\n- insert:\n    - id: dsh-crew-hub\n`;

const CONFIG = {
  flash_model_priority: [{ provider: 'opencode-go', model: 'mimo-v2.5' }],
  flash_model_priority_configured: true,
  worker: { model_policy: { priority: [{ provider: 'opencode-go', model: 'mimo-v2.5' }], priorityConfigured: true } },
  harness_default: { provider: 'openrouter', model: 'free' },
};

const SETTINGS = `llm-pi-ai:\n  providers:\n    opencode-go:\n      models:\n        - id: mimo-v2.5\n      apiKeyEnv: OPENCODE_GO_API_KEY\n    openrouter:\n      models:\n        - id: minimax/minimax-m3:free\n      apiKeyEnv: OPENROUTER_API_KEY\nagent-default-model:\n  provider: opencode-go\n  model: mimo-v2.5\n`;
const ADAPTER_SOURCE = readFileSync(new URL('../src/provider-delete-adapters.mjs', import.meta.url), 'utf8');

const INVENTORY = {
  records: [
    {
      id: 'opencode-go', display_name: 'OpenCode Go', ownership: 'crew-managed-profile', origin: 'profile-managed',
      declaration: { present: true, file: 'profile.yml' }, desired_state: 'present',
      delete_capability: 'supported', declaration_authorities: [{ kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.opencode-go' }],
      credential_refs: [{ kind: 'env', name_or_handle: 'OPENCODE_GO_API_KEY', ownership: 'crew' }],
      models: ['mimo-v2.5'],
      lifecycle: { installed: true, configured: true, enabled: true, catalogued: true },
      references: { harness_default: false, active_jobs: 0, harness_default_authority: { kind: 'harness-settings', locator: 'agent-default-model' } },
    },
    {
      id: 'openrouter', display_name: 'openrouter', ownership: 'crew-managed-profile', origin: 'profile-managed',
      declaration: { present: true, file: 'profile.yml' }, desired_state: 'present',
      delete_capability: 'supported', declaration_authorities: [{ kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.openrouter' }],
      credential_refs: [{ kind: 'env', name_or_handle: 'OPENROUTER_API_KEY', ownership: 'user' }],
      models: ['minimax/minimax-m3:free'],
      lifecycle: { installed: true, configured: true, enabled: true, catalogued: true },
      references: { harness_default: true, active_jobs: 0, harness_default_authority: { kind: 'harness-settings', locator: 'agent-default-model' } },
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

function settingsPlanFor(paths) {
  const expectedProfile = inspectProviderProfile(readFileSync(paths.profileFile, 'utf8')).revision;
  const expectedSettings = inspectProviderSettings(readFileSync(paths.settingsFile, 'utf8')).revision;
  return planProviderDelete({
    providerId: 'opencode-go', inventory: {
      records: [{
        ...INVENTORY.records[0], references: { harness_default: false, active_jobs: 0 },
        declaration_authorities: [
          { kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.opencode-go' },
          { kind: 'harness-settings', locator: 'llm-pi-ai.providers.opencode-go' },
        ],
      }],
    },
    expectedRevision: expectedProfile,
    expectedRevisions: { profile: expectedProfile, settings: expectedSettings },
  }).plan;
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

test('file adapters remove a provider from both profile and Harness settings authorities', async () => {
  const paths = fixture();
  paths.settingsFile = join(paths.dir, 'settings.yaml');
  writeFileSync(paths.settingsFile, SETTINGS);
  const plan = settingsPlanFor(paths);
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir: join(paths.dir, 'backups'), restart: async () => ({ ok: true }) });
  const result = await executeProviderDelete(plan, hooks);
  assert.equal(result.state, 'VERIFIED');
  assert.equal(readFileSync(paths.profileFile, 'utf8').includes('opencode-go:'), false);
  assert.equal(readFileSync(paths.settingsFile, 'utf8').includes('    opencode-go:'), false);
  assert.equal((await hooks.verify(plan)).providerAbsent, true);
});

test('settings-only authority remains deletable when the Crew profile file is absent', async () => {
  const paths = fixture();
  rmSync(paths.profileFile);
  paths.settingsFile = join(paths.dir, 'settings.yaml');
  writeFileSync(paths.settingsFile, SETTINGS);
  const expectedSettings = inspectProviderSettings(SETTINGS).revision;
  const plan = planProviderDelete({
    providerId: 'opencode-go', inventory: {
      records: [{ ...INVENTORY.records[0], declaration_authorities: [{ kind: 'harness-settings', locator: 'llm-pi-ai.providers.opencode-go' }] }],
    }, expectedRevisions: { profile: null, settings: expectedSettings }, expectedRevision: expectedSettings,
  }).plan;
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir: join(paths.dir, 'backups'), restart: async () => ({ ok: true }) });
  const result = await executeProviderDelete(plan, hooks);
  assert.equal(result.state, 'VERIFIED');
  assert.equal(readFileSync(paths.settingsFile, 'utf8').includes('    opencode-go:'), false);
});

test('settings-only active Harness Default is replaced and removed in one transaction', async () => {
  const paths = fixture();
  rmSync(paths.profileFile);
  paths.settingsFile = join(paths.dir, 'settings.yaml');
  writeFileSync(paths.settingsFile, SETTINGS);
  const expectedSettings = inspectProviderSettings(SETTINGS).revision;
  const inventory = {
    harness_default: { provider: 'opencode-go', model: 'mimo-v2.5' },
    records: [
      { ...INVENTORY.records[0], references: { harness_default: true, active_jobs: 0, harness_default_authority: { kind: 'harness-settings', locator: 'agent-default-model' } }, declaration_authorities: [{ kind: 'harness-settings', locator: 'llm-pi-ai.providers.opencode-go' }] },
      { ...INVENTORY.records[1], references: { harness_default: false, active_jobs: 0 } },
    ],
  };
  const plan = planProviderDelete({ providerId: 'opencode-go', inventory, replacementDefault: 'openrouter', expectedRevision: expectedSettings, expectedRevisions: { profile: null, settings: expectedSettings } }).plan;
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir: join(paths.dir, 'backups'), restart: async () => ({ ok: true }) });
  const result = await executeProviderDelete(plan, hooks);
  assert.equal(result.state, 'VERIFIED');
  assert.match(readFileSync(paths.settingsFile, 'utf8'), /agent-default-model:\n  provider: openrouter\n  model: minimax\/minimax-m3:free/);
  assert.doesNotMatch(readFileSync(paths.settingsFile, 'utf8'), /    opencode-go:/);
});

test('deferred delete audit remains rollbackable after reopening the transaction', async () => {
  const paths = fixture();
  const backupDir = join(paths.dir, 'backups');
  const plan = planFor(paths.profileFile);
  const first = createProviderDeleteFileHooks({ ...paths, backupDir, runtimeIdProvider: () => 'runtime-delete-after-mutation', restart: async () => ({ ok: true }) });
  const applied = await executeProviderDelete(plan, first, { deferRestart: true });
  assert.equal(applied.state, 'RESTART_PENDING');
  assert.equal(first.backupPlan().delete_runtime_id_before_restart, 'runtime-delete-after-mutation');
  const reopened = createProviderDeleteFileHooks({ ...paths, backupDir, existingBackupId: plan.plan_id, expectedProviderId: plan.provider_id, restart: async () => ({ ok: true }) });
  await reopened.acquireLock();
  const reopenedPlan = reopened.backupPlan();
  await reopened.rollback(reopenedPlan);
  const verified = await reopened.verifyRollback(reopenedPlan);
  await reopened.release();
  assert.equal(verified.ok, true);
});

test('provider source backups fail closed on inline credential values', async () => {
  const paths = fixture();
  const unsafeProfile = PROFILE.replace('apiKeyEnv: OPENCODE_GO_API_KEY', 'apiKey: PROFILE_SECRET');
  writeFileSync(paths.profileFile, unsafeProfile);
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir: join(paths.dir, 'backups'), restart: async () => ({ ok: true }) });
  const result = await executeProviderDelete(planFor(paths.profileFile), hooks);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error_code, 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED');
  assert.equal(readFileSync(paths.profileFile, 'utf8').includes('PROFILE_SECRET'), true);
});

test('provider source backups reject inline credentials belonging to a retained sibling', async () => {
  const paths = fixture();
  const unsafeProfile = PROFILE.replace('apiKeyEnv: OPENROUTER_API_KEY', 'apiKey: RETAINED_SIBLING_SECRET');
  writeFileSync(paths.profileFile, unsafeProfile);
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir: join(paths.dir, 'backups'), restart: async () => ({ ok: true }) });
  const result = await executeProviderDelete(planFor(paths.profileFile), hooks);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error_code, 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED');
  assert.equal(readFileSync(paths.profileFile, 'utf8').includes('RETAINED_SIBLING_SECRET'), true);
});

test('Harness settings backups reject inline credentials belonging to a retained sibling', async () => {
  const paths = fixture();
  paths.settingsFile = join(paths.dir, 'settings.yaml');
  const unsafeSettings = SETTINGS.replace('apiKeyEnv: OPENROUTER_API_KEY', 'apiKey: RETAINED_SETTINGS_SECRET');
  writeFileSync(paths.settingsFile, unsafeSettings);
  const plan = settingsPlanFor(paths);
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir: join(paths.dir, 'backups'), restart: async () => ({ ok: true }) });
  const result = await executeProviderDelete(plan, hooks);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error_code, 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED');
  assert.equal(readFileSync(paths.settingsFile, 'utf8').includes('RETAINED_SETTINGS_SECRET'), true);
});

test('provider backups reject credential-shaped aliases and authorization values', async () => {
  const paths = fixture();
  const unsafeProfile = PROFILE.replace('apiKeyEnv: OPENROUTER_API_KEY', '"clientSecret": RETAINED_CLIENT_SECRET\n        authorization: Bearer RETAINED_AUTH_SECRET');
  writeFileSync(paths.profileFile, unsafeProfile);
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir: join(paths.dir, 'backups'), restart: async () => ({ ok: true }) });
  const result = await executeProviderDelete(planFor(paths.profileFile), hooks);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error_code, 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED');

  const settingsPaths = fixture();
  settingsPaths.settingsFile = join(settingsPaths.dir, 'settings.yaml');
  const unsafeSettings = SETTINGS.replace('apiKeyEnv: OPENROUTER_API_KEY', 'client-secret: RETAINED_SETTINGS_SECRET\n      authorization: Bearer RETAINED_SETTINGS_AUTH');
  writeFileSync(settingsPaths.settingsFile, unsafeSettings);
  const settingsHooks = createProviderDeleteFileHooks({ ...settingsPaths, backupDir: join(settingsPaths.dir, 'backups'), restart: async () => ({ ok: true }) });
  const settingsResult = await executeProviderDelete(settingsPlanFor(settingsPaths), settingsHooks);
  assert.equal(settingsResult.state, 'FAILED');
  assert.equal(settingsResult.error_code, 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED');
});

test('provider backups reject nested flow-map credential values', async () => {
  const paths = fixture();
  const unsafeProfile = PROFILE.replace('apiKeyEnv: OPENROUTER_API_KEY', 'headers: { bearer: RETAINED_BEARER_SECRET }\n        metadata: { token: RETAINED_TOKEN_SECRET }');
  writeFileSync(paths.profileFile, unsafeProfile);
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir: join(paths.dir, 'backups'), restart: async () => ({ ok: true }) });
  const result = await executeProviderDelete(planFor(paths.profileFile), hooks);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.error_code, 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED');

  const settingsPaths = fixture();
  settingsPaths.settingsFile = join(settingsPaths.dir, 'settings.yaml');
  const unsafeSettings = SETTINGS.replace('apiKeyEnv: OPENROUTER_API_KEY', 'headers: { bearer: RETAINED_SETTINGS_BEARER }\n      metadata: { token: RETAINED_SETTINGS_TOKEN }');
  writeFileSync(settingsPaths.settingsFile, unsafeSettings);
  const settingsHooks = createProviderDeleteFileHooks({ ...settingsPaths, backupDir: join(settingsPaths.dir, 'backups'), restart: async () => ({ ok: true }) });
  const settingsResult = await executeProviderDelete(settingsPlanFor(settingsPaths), settingsHooks);
  assert.equal(settingsResult.state, 'FAILED');
  assert.equal(settingsResult.error_code, 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED');
});

test('default settings writer carries managed-root containment through atomic rename', () => {
  assert.match(ADAPTER_SOURCE, /atomicWrite\(settingsFile, content, managedRoot\)/);
  assert.match(ADAPTER_SOURCE, /atomicWrite\(target, sourceText, managedRoot\)/);
});

test('provider delete adapters reject managed paths outside the backup Crew root', () => {
  const paths = fixture();
  assert.throws(() => createProviderDeleteFileHooks({
    ...paths,
    configFile: join(paths.dir, '..', 'outside-config.json'),
    backupDir: join(paths.dir, 'backups'),
  }), (error) => error.code === 'PROVIDER_DELETE_UNSAFE_PATH');
});

test('a crashed owner lock can be reclaimed when its recorded process is dead', async () => {
  const paths = fixture();
  const backupDir = join(paths.dir, 'backups');
  const lockPath = join(backupDir, '.delete.lock');
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999, created_at: new Date().toISOString() }));
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir, restart: async () => ({ ok: true }) });
  await hooks.backup(planFor(paths.profileFile));
  await hooks.release();
  assert.equal(existsSync(lockPath), false);
});

test('a half-created owner lock without metadata can be safely reclaimed', async () => {
  const paths = fixture();
  const backupDir = join(paths.dir, 'backups');
  const lockPath = join(backupDir, '.delete.lock');
  mkdirSync(lockPath, { recursive: true });
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir, restart: async () => ({ ok: true }) });
  await hooks.backup(planFor(paths.profileFile));
  await hooks.release();
  assert.equal(existsSync(lockPath), false);
});

test('two processes reclaiming the same stale lock yield exactly one owner', async () => {
  const paths = fixture();
  const backupDir = join(paths.dir, 'backups');
  const staleLock = join(backupDir, '.delete.lock');
  mkdirSync(staleLock, { recursive: true });
  writeFileSync(join(staleLock, 'owner.json'), JSON.stringify({ pid: 999999, token: 'stale-owner' }));
  const plan = planFor(paths.profileFile);
  const start = join(paths.dir, 'start.signal');
  const ready = [join(paths.dir, 'ready-a'), join(paths.dir, 'ready-b')];
  const childSource = (readyFile) => `
    import { existsSync, writeFileSync } from 'node:fs';
    import { createProviderDeleteFileHooks } from './src/provider-delete-adapters.mjs';
    const payload = ${JSON.stringify({ paths, backupDir, plan, start })};
    writeFileSync(${JSON.stringify(readyFile)}, 'ready');
    while (!existsSync(payload.start)) await new Promise((resolve) => setTimeout(resolve, 5));
    const hooks = createProviderDeleteFileHooks({ ...payload.paths, backupDir: payload.backupDir });
    try { await hooks.backup(payload.plan); console.log('WON'); await new Promise((resolve) => setTimeout(resolve, 500)); }
    catch (error) { console.log(error.code ?? 'UNKNOWN'); }
    finally { await hooks.release(); }
  `;
  const children = ready.map((readyFile) => spawn(process.execPath, ['--input-type=module', '-e', childSource(readyFile)], { cwd: process.cwd() }));
  const output = children.map((child) => new Promise((resolve) => {
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.on('close', () => resolve(text.trim()));
  }));
  const deadline = Date.now() + 5_000;
  while (ready.some((file) => !existsSync(file)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(ready.map((file) => existsSync(file)), [true, true]);
  writeFileSync(start, 'go');
  const results = await Promise.all(output);
  assert.equal(results.filter((value) => value === 'WON').length, 1);
  assert.equal(results.filter((value) => value === 'PROVIDER_DELETE_BUSY').length, 1);
});

test('provider verification fails closed when a managed profile is malformed', async () => {
  const paths = fixture();
  const plan = planFor(paths.profileFile);
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir: join(paths.dir, 'backups'), restart: async () => ({ ok: true }) });
  await hooks.backup(plan);
  writeFileSync(paths.profileFile, `- id: llm-pi-ai\n  config:\n    providers:\n      broken: [\n`);
  const verification = await hooks.verify(plan);
  await hooks.release();
  assert.equal(verification.providerAbsent, false);
});

test('rollback keeps the transaction record durable before ROLLBACK_PENDING audit', async () => {
  const paths = fixture();
  const plan = planFor(paths.profileFile);
  const backupDir = join(paths.dir, 'backups');
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir, restart: async () => ({ ok: true }) });
  await hooks.backup(plan);
  await hooks.markTombstone(plan.provider_id);
  await hooks.recordTransaction({ transaction_id: plan.plan_id, provider_id: plan.provider_id, state: 'VERIFIED' }, plan);
  await hooks.rollback(plan);
  const lifecycle = JSON.parse(readFileSync(paths.lifecycleFile, 'utf8'));
  await hooks.release();
  assert.equal(lifecycle.transactions[plan.plan_id]?.state, 'VERIFIED');
});

test('transaction stores an independent rollback runtime baseline', async () => {
  const paths = fixture();
  const backupDir = join(paths.dir, 'backups');
  const plan = { ...planFor(paths.profileFile), delete_runtime_id_before_restart: 'runtime-delete-before' };
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir, restart: async () => ({ ok: true }) });
  await hooks.backup(plan);
  await hooks.setRuntimeBaseline('runtime-rollback-before', 'rollback');
  assert.equal(hooks.backupPlan().rollback_runtime_id_before_restart, 'runtime-rollback-before');
  await hooks.release();
});

test('cross-file write failure checkpoints config before compensating rollback', async () => {
  const paths = fixture();
  paths.settingsFile = join(paths.dir, 'settings.yaml');
  writeFileSync(paths.settingsFile, SETTINGS);
  const originalConfig = readFileSync(paths.configFile, 'utf8');
  const originalSettings = readFileSync(paths.settingsFile, 'utf8');
  const inventory = structuredClone(INVENTORY);
  inventory.records[0].references.harness_default = true;
  inventory.records[0].declaration_authorities = [
    { kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.opencode-go' },
    { kind: 'harness-settings', locator: 'llm-pi-ai.providers.opencode-go' },
  ];
  inventory.records[1].references.harness_default = false;
  inventory.harness_default = { provider: 'opencode-go', model: 'mimo-v2.5' };
  const expectedProfile = inspectProviderProfile(PROFILE).revision;
  const expectedSettings = inspectProviderSettings(SETTINGS).revision;
  const plan = planProviderDelete({ providerId: 'opencode-go', inventory, replacementDefault: 'openrouter', expectedRevision: expectedProfile, expectedRevisions: { profile: expectedProfile, settings: expectedSettings } }).plan;
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir: join(paths.dir, 'backups'), writeSettings: () => { throw Object.assign(new Error('settings write failed'), { code: 'PROVIDER_SETTINGS_WRITE_FAILED' }); }, restart: async () => ({ ok: true }) });
  const result = await executeProviderDelete(plan, hooks);
  assert.equal(result.state, 'FAILED');
  assert.equal(result.rollback_attempted, true);
  assert.equal(readFileSync(paths.configFile, 'utf8'), originalConfig);
  assert.equal(readFileSync(paths.settingsFile, 'utf8'), originalSettings);
  assert.deepEqual(JSON.parse(readFileSync(paths.lifecycleFile, 'utf8')).tombstones, {});
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
  paths.settingsFile = join(paths.dir, 'settings.yaml');
  writeFileSync(paths.settingsFile, SETTINGS);
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
  inventory.records.find((record) => record.id === 'opencode-go').declaration_authorities = [
    { kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.opencode-go' },
    { kind: 'harness-settings', locator: 'llm-pi-ai.providers.opencode-go' },
  ];
  inventory.records.find((record) => record.id === 'openrouter').references.harness_default = false;
  inventory.harness_default = { provider: 'opencode-go', model: 'mimo-v2.5' };
  const expectedRevision = inspectProviderProfile(PROFILE).revision;
  const expectedSettings = inspectProviderSettings(SETTINGS).revision;
  const plan = planProviderDelete({
    providerId: 'opencode-go', inventory, replacementDefault: 'openrouter', expectedRevision,
    expectedRevisions: { profile: expectedRevision, settings: expectedSettings },
  }).plan;
  const result = await executeProviderDelete(plan, hooks);
  assert.equal(result.state, 'VERIFIED');
  assert.deepEqual(config.harness_default, { provider: 'openrouter', model: 'minimax/minimax-m3:free' });
  assert.match(readFileSync(paths.settingsFile, 'utf8'), /agent-default-model:\n  provider: openrouter\n  model: minimax\/minimax-m3:free/);
  assert.doesNotMatch(readFileSync(paths.settingsFile, 'utf8'), /    opencode-go:/);
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

test('reopening a backup fails closed when its manifest omits a managed file entry', async () => {
  const paths = fixture();
  const plan = planFor(paths.profileFile);
  const backupDir = join(paths.dir, 'backups');
  const first = createProviderDeleteFileHooks({ ...paths, backupDir, restart: async () => ({ ok: true }) });
  await first.backup(plan);
  await first.release();
  const manifestFile = join(backupDir, plan.plan_id, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  delete manifest.files.lifecycle;
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  assert.throws(() => createProviderDeleteFileHooks({
    ...paths,
    backupDir,
    existingBackupId: plan.plan_id,
    expectedProviderId: plan.provider_id,
  }), (error) => error.code === 'PROVIDER_DELETE_BACKUP_INVALID');
});

test('reopening a backup fails closed when a required backup file is missing', async () => {
  const paths = fixture();
  const plan = planFor(paths.profileFile);
  const backupDir = join(paths.dir, 'backups');
  const first = createProviderDeleteFileHooks({ ...paths, backupDir, restart: async () => ({ ok: true }) });
  await first.backup(plan);
  await first.release();
  rmSync(join(backupDir, plan.plan_id, 'profile.backup'));
  assert.throws(() => createProviderDeleteFileHooks({
    ...paths,
    backupDir,
    existingBackupId: plan.plan_id,
    expectedProviderId: plan.provider_id,
  }), (error) => error.code === 'PROVIDER_DELETE_BACKUP_INVALID');
});

test('owner metadata write failure cleans up the half-created lock', async () => {
  const paths = fixture();
  const backupDir = join(paths.dir, 'backups');
  const ownerWriteFs = {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync(file, content, options) {
      if (String(file).endsWith('owner.json')) {
        const error = new Error('owner metadata write denied');
        error.code = 'EACCES';
        throw error;
      }
      return writeFileSync(file, content, options);
    },
  };
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir, fs: ownerWriteFs });
  await assert.rejects(() => hooks.backup(planFor(paths.profileFile)), (error) => error.code === 'PROVIDER_DELETE_LOCK_UNAVAILABLE');
  assert.equal(existsSync(join(backupDir, '.delete.lock')), false);
});

test('persisted provider delete backup retains sanitized credential references for final audit', async () => {
  const paths = fixture();
  const plan = { ...planFor(paths.profileFile), credential_refs: [{ kind: 'env', name_or_handle: 'OPENCODE_GO_API_KEY', ownership: 'external' }] };
  const backupDir = join(paths.dir, 'backups');
  const hooks = createProviderDeleteFileHooks({ ...paths, backupDir, restart: async () => ({ ok: true }) });
  await hooks.backup(plan);
  const reopened = createProviderDeleteFileHooks({ ...paths, backupDir, existingBackupId: plan.plan_id, expectedProviderId: plan.provider_id });
  assert.deepEqual(reopened.backupPlan().credential_refs, plan.credential_refs);
  await hooks.release();
  await reopened.release();
});

test('rollback verification rejects a restored provider with drifted routing semantics', async () => {
  const paths = fixture();
  const plan = planFor(paths.profileFile);
  const backupDir = join(paths.dir, 'backups');
  const first = createProviderDeleteFileHooks({ ...paths, backupDir, restart: async () => ({ ok: true }) });
  await first.backup(plan);
  await first.release();
  writeFileSync(paths.profileFile, PROFILE.replace(/      opencode-go:[\s\S]*?      openrouter:/, '      openrouter:'));
  const reopened = createProviderDeleteFileHooks({ ...paths, backupDir, existingBackupId: plan.plan_id, expectedProviderId: plan.provider_id, restart: async () => ({ ok: true }) });
  await reopened.acquireLock();
  await reopened.checkpointApplied(plan);
  await reopened.rollback(plan);
  const restored = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  writeFileSync(paths.configFile, JSON.stringify({ ...restored, flash_model_priority: [{ provider: 'openrouter', model: 'drifted' }] }, null, 2) + '\n');
  const verified = await reopened.verifyRollback(plan);
  await reopened.release();
  assert.equal(verified.ok, false);
  assert.equal(verified.routingRestored, false);
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
