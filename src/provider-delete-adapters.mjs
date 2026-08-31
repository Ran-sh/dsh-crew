// Filesystem-backed adapters for the provider deletion transaction.
//
// The transaction state machine remains side-effect free. This module owns
// only the three Crew-managed files that can be changed by a provider delete:
// the Harness provider patch, the canonical Crew config, and the lifecycle
// tombstone file. Credentials are deliberately never read or copied.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  inspectProviderProfile,
  readProviderDeclarations,
  removeProviderDeclarations,
} from './provider-profile-store.mjs';
import { scrubProviderReferences } from './provider-config-scrub.mjs';
import {
  markProviderTombstone,
  normalizeProviderLifecycleState,
} from './provider-lifecycle-state.mjs';

const FILE_KEYS = Object.freeze(['profile', 'config', 'lifecycle']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validProviderId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function safePlanId(value) {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function atomicWrite(file, content) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(file)}.${process.pid}.${Date.now()}.dsh-crew.tmp`);
  try {
    writeFileSync(temp, content);
    renameSync(temp, file);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function defaultReadConfig(configFile) {
  return readJson(configFile, {});
}

function defaultWriteConfig(configFile, config) {
  atomicWrite(configFile, JSON.stringify(config, null, 2) + '\n');
}

function profileContainsProvider(source, providerId) {
  const escaped = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s+${escaped}:\\s*$`, 'm').test(source);
}

function fileMap({ profileFile, configFile, lifecycleFile }) {
  return { profile: profileFile, config: configFile, lifecycle: lifecycleFile };
}

function validatePaths(paths) {
  for (const key of FILE_KEYS) {
    if (typeof paths[key] !== 'string' || !paths[key].trim()) {
      throw new TypeError(`provider delete ${key} path is required`);
    }
  }
}

/**
 * Build explicit adapters for executeProviderDelete.
 *
 * `restart` is intentionally required from the caller. The Hub process must
 * not guess how its supervisor works or restart the official 3080 process.
 * Without a supplied supervisor the transaction fails closed and compensates
 * any writes using the managed-file backup.
 */
export function createProviderDeleteFileHooks({
  profileFile,
  configFile,
  lifecycleFile,
  backupDir,
  readConfig = () => defaultReadConfig(configFile),
  writeConfig = (config) => defaultWriteConfig(configFile, config),
  restart,
  fs = { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync },
} = {}) {
  validatePaths({ profile: profileFile, config: configFile, lifecycle: lifecycleFile });
  if (typeof backupDir !== 'string' || !backupDir.trim()) throw new TypeError('provider delete backup directory is required');
  const paths = fileMap({ profileFile, configFile, lifecycleFile });
  let activeBackup = null;

  const backup = async (plan) => {
    const planId = safePlanId(plan?.plan_id);
    if (!planId) throw Object.assign(new Error('provider delete plan id is invalid'), { code: 'PROVIDER_DELETE_PLAN_INVALID' });
    const root = join(backupDir, planId);
    fs.mkdirSync(root, { recursive: true });
    const manifest = { schema_version: 1, files: {} };
    for (const key of FILE_KEYS) {
      const source = paths[key];
      const existed = fs.existsSync(source);
      manifest.files[key] = { existed };
      if (existed) {
        const target = join(root, `${key}.backup`);
        fs.copyFileSync(source, target);
      }
    }
    const manifestFile = join(root, 'manifest.json');
    atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    activeBackup = { root, manifest };
    return { ok: true, backup_id: planId };
  };

  const markTombstone = async (providerId) => {
    if (!validProviderId(providerId)) throw Object.assign(new Error('provider id is invalid'), { code: 'PROVIDER_NOT_FOUND' });
    const state = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    atomicWrite(lifecycleFile, JSON.stringify(markProviderTombstone(state, providerId), null, 2) + '\n');
  };

  const scrubReferences = async (plan) => {
    const config = await readConfig();
    const scrubbed = scrubProviderReferences(config, [plan.provider_id]);
    await writeConfig(scrubbed.config);
  };

  const removeDeclarations = async (plan) => {
    const source = fs.readFileSync(profileFile, 'utf8');
    const result = removeProviderDeclarations(source, {
      providerIds: [plan.provider_id],
      expectedRevision: plan.expected_revision,
    });
    if (!result.ok) throw Object.assign(new Error('provider profile changed'), { code: result.code });
    atomicWrite(profileFile, result.text);
  };

  const verify = async (plan) => {
    const source = fs.readFileSync(profileFile, 'utf8');
    const parsed = readProviderDeclarations(source, { file: 'harness/profiles/dsh-crew/cordis.patch.yml' });
    const providerAbsent = parsed.ok
      ? !parsed.declarations.some((declaration) => declaration.id === plan.provider_id)
      : !profileContainsProvider(source, plan.provider_id);
    const config = await readConfig();
    const routingClear = scrubProviderReferences(config, [plan.provider_id]).removed.length === 0;
    const state = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    return {
      providerAbsent,
      routingClear,
      tombstonePresent: state.tombstones[plan.provider_id] === 'absent',
    };
  };

  const rollback = async () => {
    if (!activeBackup) throw Object.assign(new Error('provider delete backup is unavailable'), { code: 'PROVIDER_DELETE_ROLLBACK_UNAVAILABLE' });
    for (const key of FILE_KEYS) {
      const target = paths[key];
      const entry = activeBackup.manifest.files[key];
      const backupFile = join(activeBackup.root, `${key}.backup`);
      if (entry?.existed === true) {
        fs.copyFileSync(backupFile, target);
      } else {
        fs.rmSync(target, { force: true });
      }
    }
  };

  return {
    backup,
    markTombstone,
    scrubReferences,
    removeDeclarations,
    restart: typeof restart === 'function'
      ? async (plan) => restart(plan)
      : async () => ({ ok: false, code: 'PROVIDER_DELETE_RESTART_SUPERVISOR_UNAVAILABLE' }),
    verify,
    rollback,
  };
}
