import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
      references: { harness_default: false, active_jobs: 0 },
    },
    {
      id: 'openrouter', display_name: 'openrouter', ownership: 'crew-managed-profile', origin: 'profile-managed',
      declaration: { present: true, file: 'profile.yml' }, desired_state: 'present',
      credential_refs: [{ kind: 'env', name_or_handle: 'OPENROUTER_API_KEY', ownership: 'user' }],
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
  let config = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  const hooks = createProviderDeleteFileHooks({
    ...paths,
    backupDir: join(paths.dir, 'backups'),
    readConfig: () => config,
    writeConfig: (next) => { config = next; writeFileSync(paths.configFile, JSON.stringify(next, null, 2) + '\n'); },
    restart: async () => ({ ok: true }),
  });
  const result = await executeProviderDelete(planFor(paths.profileFile), hooks);
  assert.equal(result.state, 'VERIFIED');
  assert.equal(result.error_code, null);
  assert.equal(readFileSync(paths.profileFile, 'utf8').includes('opencode-go:'), false);
  assert.deepEqual(config.worker.model_policy.priority, []);
  assert.equal(JSON.stringify(config).includes('OPENCODE_GO_API_KEY'), false);
  assert.match(readFileSync(paths.lifecycleFile, 'utf8'), /opencode-go/);
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
  assert.equal(readFileSync(paths.lifecycleFile, 'utf8'), originalLifecycle);
  assert.equal(existsSync(join(paths.dir, 'backups')), true);
});
