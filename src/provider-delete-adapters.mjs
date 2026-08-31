// Filesystem-backed adapters for the provider deletion transaction.
//
// The transaction state machine remains side-effect free. This module owns
// only the three Crew-managed files that can be changed by a provider delete:
// the Harness provider patch, the canonical Crew config, and the lifecycle
// tombstone file. Credentials are deliberately never read or copied.

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
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
  recordProviderTransaction,
} from './provider-lifecycle-state.mjs';

const FILE_KEYS = Object.freeze(['profile', 'config', 'lifecycle']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validProviderId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
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
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw Object.assign(new Error('managed provider file is invalid'), { code: 'PROVIDER_DELETE_FILE_INVALID' });
  }
}

function defaultReadConfig(configFile) {
  assertManagedPath(configFile);
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

function hasOwn(value, key) {
  return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

function safeModelRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ?? null;
  const result = {};
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    if (typeof value[key] === 'string' && value[key].trim()) result[key] = value[key].trim();
  }
  return result;
}

function safeModelRefList(value) {
  return Array.isArray(value) ? value.map((entry) => safeModelRef(entry)) : value;
}

function configProjection(config) {
  const projection = { schema_version: 1, fields: {} };
  for (const key of ['flash_model_priority', 'pro_model_priority', 'harness_default', 'agent_default_model', 'agentDefaultModel']) {
    if (hasOwn(config, key)) projection.fields[key] = key.endsWith('_priority') ? safeModelRefList(config[key]) : safeModelRef(config[key]);
  }
  for (const [scope, value] of [['worker', config?.worker?.model_policy], ['review', config?.review?.model_policy]]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const fields = {};
    for (const key of ['priority', 'escalation_priority']) if (hasOwn(value, key)) fields[key] = safeModelRefList(value[key]);
    if (Object.keys(fields).length > 0) projection.fields[scope] = { model_policy: fields };
  }
  return projection;
}

function lifecycleProjection(state) {
  return { tombstones: { ...(state?.tombstones ?? {}) } };
}

function restoreConfigProjection(config, projection) {
  const next = typeof structuredClone === 'function' ? structuredClone(config) : JSON.parse(JSON.stringify(config));
  for (const key of ['flash_model_priority', 'pro_model_priority', 'harness_default', 'agent_default_model', 'agentDefaultModel']) {
    if (hasOwn(projection?.fields, key)) next[key] = projection.fields[key];
  }
  for (const scope of ['worker', 'review']) {
    const saved = projection?.fields?.[scope]?.model_policy;
    if (!saved) continue;
    next[scope] = { ...(next[scope] ?? {}), model_policy: { ...(next[scope]?.model_policy ?? {}) } };
    for (const key of ['priority', 'escalation_priority']) if (hasOwn(saved, key)) next[scope].model_policy[key] = saved[key];
  }
  return next;
}

function safeRestoreFile(source, target) {
  if (lstatSync(source).isSymbolicLink()) throw Object.assign(new Error('backup file is a symlink'), { code: 'PROVIDER_DELETE_ROLLBACK_UNSAFE_PATH' });
  try {
    if (lstatSync(target).isSymbolicLink()) rmSync(target, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  atomicWrite(target, readFileSync(source));
}

function assertManagedPath(file) {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw Object.assign(new Error('managed provider path is a symlink'), { code: 'PROVIDER_DELETE_UNSAFE_PATH' });
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
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
  existingBackupId = null,
  expectedProviderId = null,
  fs = { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync },
} = {}) {
  validatePaths({ profile: profileFile, config: configFile, lifecycle: lifecycleFile });
  if (typeof backupDir !== 'string' || !backupDir.trim()) throw new TypeError('provider delete backup directory is required');
  const paths = fileMap({ profileFile, configFile, lifecycleFile });
  let activeBackup = null;
  let lockPath = null;
  let lockOwned = false;

  const acquireLock = async () => {
    if (lockOwned) return;
    fs.mkdirSync(backupDir, { recursive: true });
    lockPath = join(backupDir, '.delete.lock');
    try {
      fs.mkdirSync(lockPath);
      lockOwned = true;
    } catch (error) {
      throw Object.assign(new Error('another provider deletion is active'), { code: error?.code === 'EEXIST' ? 'PROVIDER_DELETE_BUSY' : 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
    }
  };

  if (existingBackupId !== null) {
    const backupId = safePlanId(existingBackupId);
    if (!backupId) throw Object.assign(new Error('provider backup id is invalid'), { code: 'PROVIDER_DELETE_PLAN_INVALID' });
    const root = join(backupDir, backupId);
    const manifest = readJson(join(root, 'manifest.json'), null);
    if (!manifest || manifest.schema_version !== 1 || !manifest.files || !manifest.plan || (expectedProviderId && manifest.provider_id !== expectedProviderId)) {
      throw Object.assign(new Error('provider backup is invalid'), { code: 'PROVIDER_DELETE_BACKUP_INVALID' });
    }
    activeBackup = { root, manifest };
  }

  const persistManifest = () => {
    if (!activeBackup) return;
    atomicWrite(join(activeBackup.root, 'manifest.json'), JSON.stringify(activeBackup.manifest, null, 2) + '\n');
  };

  const backup = async (plan) => {
    const planId = safePlanId(plan?.plan_id);
    if (!planId) throw Object.assign(new Error('provider delete plan id is invalid'), { code: 'PROVIDER_DELETE_PLAN_INVALID' });
    await acquireLock();
    const root = join(backupDir, planId);
    fs.mkdirSync(root, { recursive: true });
    const manifest = {
      schema_version: 1,
      provider_id: plan.provider_id,
      plan: {
        plan_id: plan.plan_id,
        provider_id: plan.provider_id,
        expected_revision: plan.expected_revision ?? null,
        replacement_default: plan.replacement_default ?? null,
        was_harness_default: plan.was_harness_default === true,
        replacement_default_model: plan.replacement_default_model ?? null,
      },
      files: {},
    };
    for (const key of FILE_KEYS) {
      const source = paths[key];
      assertManagedPath(source);
      const existed = fs.existsSync(source);
      manifest.files[key] = { existed };
      if (existed && key !== 'config') {
        const target = join(root, `${key}.backup`);
        fs.copyFileSync(source, target);
      }
    }
    const config = defaultReadConfig(configFile);
    const lifecycle = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    manifest.config_projection = configProjection(config);
    manifest.config_revision = sha256(JSON.stringify(config));
    manifest.lifecycle_revision = sha256(JSON.stringify(lifecycle));
    manifest.routing_projection_digest = sha256(JSON.stringify(manifest.config_projection));
    manifest.lifecycle_projection_digest = sha256(JSON.stringify(lifecycleProjection(lifecycle)));
    manifest.profile_revision = sha256(fs.readFileSync(profileFile, 'utf8'));
    activeBackup = { root, manifest };
    persistManifest();
    return { ok: true, backup_id: planId };
  };

  const markTombstone = async (providerId) => {
    if (!validProviderId(providerId)) throw Object.assign(new Error('provider id is invalid'), { code: 'PROVIDER_NOT_FOUND' });
    assertManagedPath(lifecycleFile);
    const state = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    if (activeBackup?.manifest?.lifecycle_revision && sha256(JSON.stringify(state)) !== activeBackup.manifest.lifecycle_revision) {
      throw Object.assign(new Error('provider lifecycle changed'), { code: 'PROVIDER_LIFECYCLE_CHANGED' });
    }
    const marked = markProviderTombstone(state, providerId);
    atomicWrite(lifecycleFile, JSON.stringify(marked, null, 2) + '\n');
    if (activeBackup) {
      activeBackup.manifest.applied_lifecycle_revision = sha256(JSON.stringify(marked));
      persistManifest();
    }
  };

  const scrubReferences = async (plan) => {
    const config = await readConfig();
    if (sha256(JSON.stringify(config)) !== activeBackup?.manifest?.config_revision) {
      throw Object.assign(new Error('provider config changed'), { code: 'PROVIDER_CONFIG_CHANGED' });
    }
    const scrubbed = scrubProviderReferences(config, [plan.provider_id]);
    if (plan.was_harness_default === true) {
      if (!validProviderId(plan.replacement_default) || typeof plan.replacement_default_model !== 'string' || !plan.replacement_default_model.trim()) {
        throw Object.assign(new Error('replacement Harness Default model is required'), { code: 'PROVIDER_DEFAULT_REPLACEMENT_MODEL_REQUIRED' });
      }
      scrubbed.config.harness_default = {
        provider: plan.replacement_default,
        model: plan.replacement_default_model.trim(),
      };
    }
    await writeConfig(scrubbed.config);
    if (activeBackup) {
      activeBackup.manifest.applied_config_revision = sha256(JSON.stringify(scrubbed.config));
      persistManifest();
    }
  };

  const removeDeclarations = async (plan) => {
    assertManagedPath(profileFile);
    const source = fs.readFileSync(profileFile, 'utf8');
    const result = removeProviderDeclarations(source, {
      providerIds: [plan.provider_id],
      expectedRevision: plan.expected_revision,
    });
    if (!result.ok) throw Object.assign(new Error('provider profile changed'), { code: result.code });
    atomicWrite(profileFile, result.text);
    if (activeBackup) {
      activeBackup.manifest.applied_profile_revision = result.revision;
      persistManifest();
    }
  };

  const checkpointApplied = async () => {
    if (!activeBackup) throw Object.assign(new Error('provider delete backup is unavailable'), { code: 'PROVIDER_DELETE_BACKUP_INVALID' });
    const config = await readConfig();
    const lifecycle = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    activeBackup.manifest.applied_config_revision = sha256(JSON.stringify(config));
    activeBackup.manifest.applied_lifecycle_revision = sha256(JSON.stringify(lifecycle));
    activeBackup.manifest.applied_profile_revision = sha256(fs.readFileSync(profileFile, 'utf8'));
    persistManifest();
  };

  const backupPlan = () => (activeBackup?.manifest?.plan ? { ...activeBackup.manifest.plan } : null);

  const verify = async (plan) => {
    assertManagedPath(profileFile);
    assertManagedPath(lifecycleFile);
    const source = fs.readFileSync(profileFile, 'utf8');
    const parsed = readProviderDeclarations(source, { file: 'harness/profiles/dsh-crew/cordis.patch.yml' });
    const providerAbsent = parsed.ok
      ? !parsed.declarations.some((declaration) => declaration.id === plan.provider_id)
      : !profileContainsProvider(source, plan.provider_id);
    const config = await readConfig();
    const routingClear = scrubProviderReferences(config, [plan.provider_id]).removed.length === 0;
    const replacementApplied = plan.was_harness_default !== true || (
      config?.harness_default?.provider === plan.replacement_default
      && config?.harness_default?.model === plan.replacement_default_model
    );
    const state = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    return {
      providerAbsent,
      routingClear: routingClear && replacementApplied,
      tombstonePresent: state.tombstones[plan.provider_id] === 'absent',
    };
  };

  const rollback = async () => {
    if (!activeBackup) throw Object.assign(new Error('provider delete backup is unavailable'), { code: 'PROVIDER_DELETE_ROLLBACK_UNAVAILABLE' });
    const allowedRevision = (current, original, applied) => current === original || (typeof applied === 'string' && current === applied);
    const currentConfig = await readConfig();
    const currentLifecycle = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    const currentProfile = fs.readFileSync(profileFile, 'utf8');
    if (!allowedRevision(sha256(JSON.stringify(currentConfig)), activeBackup.manifest.config_revision, activeBackup.manifest.applied_config_revision)
      || !allowedRevision(sha256(JSON.stringify(currentLifecycle)), activeBackup.manifest.lifecycle_revision, activeBackup.manifest.applied_lifecycle_revision)
      || !allowedRevision(sha256(currentProfile), activeBackup.manifest.profile_revision, activeBackup.manifest.applied_profile_revision)) {
      throw Object.assign(new Error('managed provider state changed after the transaction'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
    }
    for (const key of FILE_KEYS) {
      const target = paths[key];
      const entry = activeBackup.manifest.files[key];
      const backupFile = join(activeBackup.root, `${key}.backup`);
      assertManagedPath(target);
      if (key === 'config') {
        if (entry?.existed === true) {
          const restored = restoreConfigProjection(await readConfig(), activeBackup.manifest.config_projection);
          await writeConfig(restored);
        } else {
          fs.rmSync(target, { force: true });
        }
      } else if (entry?.existed === true) {
        safeRestoreFile(backupFile, target);
      } else {
        fs.rmSync(target, { force: true });
      }
    }
  };

  const release = async () => {
    if (!lockOwned || !lockPath) return;
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } finally { lockOwned = false; lockPath = null; }
  };

  const verifyRollback = async (plan) => {
    assertManagedPath(profileFile);
    assertManagedPath(lifecycleFile);
    const source = fs.readFileSync(profileFile, 'utf8');
    const parsed = readProviderDeclarations(source, { file: 'harness/profiles/dsh-crew/cordis.patch.yml' });
    const providerPresent = parsed.ok && parsed.declarations.some((declaration) => declaration.id === plan.provider_id);
    const config = await readConfig();
    const state = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    const routingRestored = typeof activeBackup?.manifest?.routing_projection_digest === 'string'
      && sha256(JSON.stringify(configProjection(config))) === activeBackup.manifest.routing_projection_digest;
    const lifecycleRestored = typeof activeBackup?.manifest?.lifecycle_projection_digest === 'string'
      && sha256(JSON.stringify(lifecycleProjection(state))) === activeBackup.manifest.lifecycle_projection_digest;
    const declarationRestored = typeof activeBackup?.manifest?.profile_revision === 'string'
      && sha256(source) === activeBackup.manifest.profile_revision;
    return {
      ok: providerPresent && state.tombstones[plan.provider_id] !== 'absent'
        && routingRestored && lifecycleRestored && declarationRestored,
      providerPresent,
      tombstoneCleared: state.tombstones[plan.provider_id] !== 'absent',
      routingRestored,
      lifecycleRestored,
      declarationRestored,
    };
  };

  const recordTransaction = async (result, plan) => {
    assertManagedPath(lifecycleFile);
    const state = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    const next = recordProviderTransaction(state, {
      transaction_id: result?.transaction_id ?? plan?.plan_id,
      provider_id: result?.provider_id ?? plan?.provider_id,
      state: result?.state,
      expected_revision: plan?.expected_revision,
    });
    if (result?.state === 'VERIFIED') {
      assertManagedPath(profileFile);
      next.last_verified_revision[plan.provider_id] = sha256(fs.readFileSync(profileFile, 'utf8'));
    }
    atomicWrite(lifecycleFile, JSON.stringify(next, null, 2) + '\n');
  };

  return {
    backup,
    acquireLock,
    checkpointApplied,
    backupPlan,
    markTombstone,
    scrubReferences,
    removeDeclarations,
    restart: typeof restart === 'function'
      ? async (plan) => restart(plan)
      : async () => ({ ok: false, code: 'PROVIDER_DELETE_RESTART_SUPERVISOR_UNAVAILABLE' }),
    restartRollback: typeof restart === 'function'
      ? async (plan) => restart(plan)
      : async () => ({ ok: false, code: 'PROVIDER_DELETE_RESTART_SUPERVISOR_UNAVAILABLE' }),
    verify,
    verifyRollback,
    recordTransaction,
    rollback,
    release,
  };
}
