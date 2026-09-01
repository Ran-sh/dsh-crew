// Filesystem-backed adapters for the provider deletion transaction.
//
// The transaction state machine remains side-effect free. This module owns
// only the Crew-managed files that can be changed by a provider delete: the
// Harness provider patch, Harness settings provider map, canonical Crew
// config, and lifecycle tombstone file. Credentials are deliberately never
// read or copied.

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { hasInlineProviderCredentials as hasInlineProfileCredentials, readProviderDeclarations, removeProviderDeclarations } from './provider-profile-store.mjs';
import {
  readProviderSettingsDeclarations,
  removeProviderSettings,
  readHarnessDefault,
  mutateProviderSettings,
  hasInlineProviderCredentials as hasInlineSettingsCredentials,
} from './provider-settings-store.mjs';
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
  const input = Buffer.isBuffer(value) || value instanceof Uint8Array ? value : String(value);
  return createHash('sha256').update(input).digest('hex');
}

function decodeUtf8(value) {
  if (typeof value === 'string') return value;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch { throw Object.assign(new Error('managed provider file is not valid UTF-8'), { code: 'PROVIDER_DELETE_FILE_INVALID' }); }
}

function parseManagedJson(value) {
  try { return JSON.parse(decodeUtf8(value)); }
  catch { throw Object.assign(new Error('managed provider file is invalid'), { code: 'PROVIDER_DELETE_FILE_INVALID' }); }
}

function safePlanId(value) {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function atomicWrite(file, content, managedRoot = null) {
  if (managedRoot) assertManagedPath(file, managedRoot);
  const dir = dirname(file);
  if (managedRoot) {
    assertManagedPath(dir, managedRoot);
    if (!existsSync(dir)) throw Object.assign(new Error('managed provider directory is missing'), { code: 'PROVIDER_DELETE_UNSAFE_PATH' });
  } else {
    mkdirSync(dir, { recursive: true });
  }
  const tempRoot = managedRoot ? resolvePath(managedRoot) : dir;
  const temp = join(tempRoot, `.${basename(file)}.${process.pid}.${Date.now()}.dsh-crew.tmp`);
  if (managedRoot) assertManagedPath(temp, managedRoot);
  try {
    writeFileSync(temp, content);
    if (managedRoot) assertManagedPath(file, managedRoot);
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

function defaultReadConfig(configFile, managedRoot = null) {
  assertManagedPath(configFile, managedRoot);
  return readJson(configFile, {});
}

function defaultWriteConfig(configFile, config, managedRoot = null) {
  atomicWrite(configFile, JSON.stringify(config, null, 2) + '\n', managedRoot);
}

function fileMap({ profileFile, settingsFile, configFile, lifecycleFile }) {
  return { profile: profileFile, settings: settingsFile, config: configFile, lifecycle: lifecycleFile };
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

function safeRestoreFile(source, target, managedRoot = null, verifiedContent = null) {
  if (managedRoot) {
    assertManagedPath(source, managedRoot);
    assertManagedPath(target, managedRoot);
  }
  if (lstatSync(source).isSymbolicLink()) throw Object.assign(new Error('backup file is a symlink'), { code: 'PROVIDER_DELETE_ROLLBACK_UNSAFE_PATH' });
  try {
    if (lstatSync(target).isSymbolicLink()) rmSync(target, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  atomicWrite(target, verifiedContent ?? readFileSync(source), managedRoot);
}

function assertManagedPath(file, managedRoot = null) {
  if (managedRoot) {
    const root = resolvePath(managedRoot);
    const target = resolvePath(file);
    const outside = relative(root, target).startsWith('..') || isAbsolute(relative(root, target));
    if (outside) throw Object.assign(new Error('managed provider path escapes Crew root'), { code: 'PROVIDER_DELETE_UNSAFE_PATH' });
    let current = target;
    while (current && current !== dirname(current)) {
      try {
        if (lstatSync(current).isSymbolicLink()) throw Object.assign(new Error('managed provider path is a symlink'), { code: 'PROVIDER_DELETE_UNSAFE_PATH' });
        current = dirname(current);
      } catch (error) {
        if (error?.code === 'ENOENT') { current = dirname(current); continue; }
        throw error;
      }
    }
    try {
      const existing = realpathSync(target);
      const resolvedRoot = realpathSync(root);
      const resolvedRelative = relative(resolvedRoot, existing);
      if (resolvedRelative.startsWith('..') || isAbsolute(resolvedRelative)) throw Object.assign(new Error('managed provider path resolves outside Crew root'), { code: 'PROVIDER_DELETE_UNSAFE_PATH' });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
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
  if (paths.settings != null && (typeof paths.settings !== 'string' || !paths.settings.trim())) {
    throw new TypeError('provider delete settings path is required');
  }
}

function validatePlanAuthorities(plan) {
  const providerId = typeof plan?.provider_id === 'string' ? plan.provider_id : '';
  const authorities = Array.isArray(plan?.declaration_authorities) ? plan.declaration_authorities : [];
  if (!providerId || authorities.length === 0) throw Object.assign(new Error('provider declaration authority is unavailable'), { code: 'PROVIDER_DELETE_SOURCE_UNRESOLVED' });
  const expected = {
    'crew-profile': `llm-pi-ai.config.providers.${providerId}`,
    'harness-settings': `llm-pi-ai.providers.${providerId}`,
  };
  for (const authority of authorities) {
    if (typeof expected[authority?.kind] !== 'string' || authority.locator !== expected[authority.kind]) {
      throw Object.assign(new Error('provider declaration authority locator is invalid'), { code: 'PROVIDER_DELETE_SOURCE_UNRESOLVED' });
    }
  }
  if (plan.was_harness_default === true && (plan.harness_default_authority?.kind !== 'harness-settings' || plan.harness_default_authority.locator !== 'agent-default-model')) {
    throw Object.assign(new Error('Harness Default authority is unavailable'), { code: 'PROVIDER_DEFAULT_AUTHORITY_UNAVAILABLE' });
  }
}

function backupInvalid(message = 'provider backup is invalid') {
  return Object.assign(new Error(message), { code: 'PROVIDER_DELETE_BACKUP_INVALID' });
}

function validRevision(value) {
  return value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value));
}

function validateBackupManifest(manifest, { root, fs, paths, managedRoot, expectedProviderId }) {
  const backupId = basename(root);
  if (!manifest || manifest.schema_version !== 1 || !validProviderId(manifest.provider_id)
    || (expectedProviderId && manifest.provider_id !== expectedProviderId)
    || !manifest.plan || manifest.plan.plan_id !== backupId
    || !safePlanId(manifest.plan.plan_id) || manifest.plan.provider_id !== manifest.provider_id
    || !Array.isArray(manifest.plan.declaration_authorities)
    || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
    || !manifest.backup_digests || typeof manifest.backup_digests !== 'object' || Array.isArray(manifest.backup_digests)) {
    throw backupInvalid();
  }
  try {
    validatePlanAuthorities(manifest.plan);
  } catch {
    throw backupInvalid();
  }
  for (const key of FILE_KEYS) {
    const entry = manifest.files[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.existed !== 'boolean' || typeof entry.managed !== 'boolean') {
      throw backupInvalid();
    }
    if (key === 'config' && (!manifest.config_projection || typeof manifest.config_projection !== 'object'
      || Array.isArray(manifest.config_projection) || typeof manifest.config_revision !== 'string'
      || !/^[a-f0-9]{64}$/i.test(manifest.config_revision)
      || typeof manifest.routing_projection_digest !== 'string'
      || !/^[a-f0-9]{64}$/i.test(manifest.routing_projection_digest)
      || sha256(JSON.stringify(manifest.config_projection)) !== manifest.routing_projection_digest)) {
      throw backupInvalid();
    }
    if (key === 'lifecycle' && (!validRevision(manifest.lifecycle_revision) || typeof manifest.lifecycle_revision !== 'string')) {
      throw backupInvalid();
    }
    if (entry.existed && entry.managed && key !== 'config') {
      const backupFile = join(root, `${key}.backup`);
      assertManagedPath(backupFile, managedRoot);
      const digest = manifest.backup_digests[key];
      if (!fs.existsSync(backupFile) || lstatSync(backupFile).isSymbolicLink() || !/^[a-f0-9]{64}$/i.test(digest)) throw backupInvalid();
      const backupBytes = fs.readFileSync(backupFile);
      if (sha256(backupBytes) !== digest) throw backupInvalid();
      if (key === 'profile' && manifest.profile_revision !== digest) throw backupInvalid();
      if (key === 'lifecycle') {
        const lifecycle = normalizeProviderLifecycleState(parseManagedJson(backupBytes));
        if (sha256(JSON.stringify(lifecycle)) !== manifest.lifecycle_revision
          || typeof manifest.lifecycle_projection_digest !== 'string'
          || !/^[a-f0-9]{64}$/i.test(manifest.lifecycle_projection_digest)
          || sha256(JSON.stringify(lifecycleProjection(lifecycle))) !== manifest.lifecycle_projection_digest) throw backupInvalid();
      }
      if (key === 'settings' && manifest.settings_revision !== digest) throw backupInvalid();
    }
  }
  if (paths.settings) {
    const entry = manifest.files.settings;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.existed !== 'boolean' || typeof entry.managed !== 'boolean') throw backupInvalid();
    if (entry.existed && entry.managed) {
      const backupFile = join(root, 'settings.backup');
      assertManagedPath(backupFile, managedRoot);
      const digest = manifest.backup_digests.settings;
      if (!fs.existsSync(backupFile) || lstatSync(backupFile).isSymbolicLink() || !/^[a-f0-9]{64}$/i.test(digest)) throw backupInvalid();
      const settingsBytes = fs.readFileSync(backupFile);
      if (sha256(settingsBytes) !== digest || manifest.settings_revision !== digest) throw backupInvalid();
    }
  }
  if (manifest.profile_revision !== undefined && !/^[a-f0-9]{64}$/i.test(manifest.profile_revision)) throw backupInvalid();
  if (manifest.settings_revision !== undefined && !/^[a-f0-9]{64}$/i.test(manifest.settings_revision)) throw backupInvalid();
  if (manifest.mutation_journal !== undefined && (typeof manifest.mutation_journal !== 'object' || Array.isArray(manifest.mutation_journal))) throw backupInvalid();
  if (manifest.phase_journal !== undefined && (typeof manifest.phase_journal !== 'object' || Array.isArray(manifest.phase_journal))) throw backupInvalid();
  return true;
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
  settingsFile = null,
  configFile,
  lifecycleFile,
  backupDir,
  readConfig = null,
  writeConfig = (config, { managedRoot: writeRoot } = {}) => defaultWriteConfig(configFile, config, writeRoot),
  writeSettings = null,
  restart,
  runtimeIdProvider = null,
  existingBackupId = null,
  expectedProviderId = null,
  fs = { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync },
} = {}) {
  if (typeof backupDir !== 'string' || !backupDir.trim()) throw new TypeError('provider delete backup directory is required');
  const paths = fileMap({ profileFile, settingsFile, configFile, lifecycleFile });
  validatePaths(paths);
  const managedRoot = dirname(resolvePath(backupDir));
  for (const key of [...FILE_KEYS, ...(settingsFile ? ['settings'] : [])]) {
    if (paths[key]) assertManagedPath(paths[key], managedRoot);
  }
  assertManagedPath(backupDir, managedRoot);
  let activeBackup = null;
  let lockPath = null;
  let lockOwned = false;
  let lockOwnerToken = null;

  const readConfigFn = typeof readConfig === 'function'
    ? readConfig
    : () => defaultReadConfig(configFile, managedRoot);

  const writeSettingsFn = typeof writeSettings === 'function' ? writeSettings : (content, { expectedRevision } = {}) => {
    if (typeof settingsFile !== 'string' || !settingsFile.trim()) throw Object.assign(new Error('provider settings path is unavailable'), { code: 'PROVIDER_DELETE_SOURCE_UNRESOLVED' });
    const current = readFileSync(settingsFile, 'utf8');
    if (expectedRevision !== undefined && sha256(current) !== expectedRevision) throw Object.assign(new Error('provider settings changed during commit'), { code: 'PROVIDER_SETTINGS_CHANGED' });
    atomicWrite(settingsFile, content, managedRoot);
  };

  const ensureMutationLock = () => {
    if (!lockOwned || !lockPath || !lockOwnerToken) {
      throw Object.assign(new Error('provider deletion write lock is unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
    }
  };

  const recoverLock = async () => {
    const guardPath = join(backupDir, '.delete.reclaim.lock');
    const canonicalPath = join(backupDir, '.delete.lock');
    const recoveryPath = join(backupDir, '.delete.recovery.lock');
    const alive = (owner) => {
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
      try { process.kill(owner.pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
    };
    const cleanup = (path) => { try { fs.rmSync(path, { recursive: true, force: true }); } catch {} };
    assertManagedPath(backupDir, managedRoot);
    const recoveryToken = randomUUID();
    let recoveryOwned = false;
    const recoveryOwner = () => ({ pid: process.pid, token: recoveryToken, created_at: new Date().toISOString() });
    const recoveryAcquire = () => {
      try {
        fs.writeFileSync(recoveryPath, JSON.stringify(recoveryOwner()) + '\n', { flag: 'wx' });
        recoveryOwned = true;
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') return false;
        let existing = null;
        try { existing = readJson(recoveryPath, null); } catch {}
        if (existing && alive(existing) === true) return false;
        let reread = null;
        try { reread = readJson(recoveryPath, null); } catch {}
        if ((existing?.token ?? null) !== (reread?.token ?? null)) return false;
        const stalePath = `${recoveryPath}.${recoveryToken}.stale`;
        try { renameSync(recoveryPath, stalePath); } catch { return false; }
        try {
          fs.writeFileSync(recoveryPath, JSON.stringify(recoveryOwner()) + '\n', { flag: 'wx' });
          recoveryOwned = true;
          return true;
        } finally { cleanup(stalePath); }
      }
    };
    if (!recoveryAcquire()) return { ok: false, code: 'PROVIDER_DELETE_BUSY' };
    try {
      if (!existsSync(guardPath)) return { ok: true, recovered: false };
      let guardOwner = null;
      try { guardOwner = readJson(guardPath, null); } catch { guardOwner = null; }
      if (alive(guardOwner) === true) return { ok: false, code: 'PROVIDER_DELETE_BUSY' };
      const candidates = [canonicalPath];
      try {
        for (const entry of readdirSync(backupDir, { withFileTypes: true })) {
          if (/^\.delete\.lock\.[0-9a-f-]+\.(?:active|staging)$/iu.test(entry.name)) candidates.push(join(backupDir, entry.name));
        }
      } catch { return { ok: false, code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' }; }
      for (const candidate of [...new Set(candidates)]) {
        if (!existsSync(candidate)) continue;
        let mainOwner = null;
        try {
          mainOwner = lstatSync(candidate).isDirectory()
            ? readJson(join(candidate, 'owner.json'), null) : readJson(candidate, null);
        } catch { mainOwner = null; }
        if (alive(mainOwner) === true) return { ok: false, code: 'PROVIDER_DELETE_BUSY' };
      }
      for (const candidate of [...new Set(candidates)]) if (existsSync(candidate)) cleanup(candidate);
      cleanup(guardPath);
      return { ok: true, recovered: true };
    } finally {
      if (recoveryOwned) {
        let owner = null;
        try { owner = readJson(recoveryPath, null); } catch {}
        if (owner?.token === recoveryToken) cleanup(recoveryPath);
      }
    }
  };

  const acquireLock = async () => {
    if (lockOwned) return;
    assertManagedPath(backupDir, managedRoot);
    const backupParent = dirname(backupDir);
    assertManagedPath(backupParent, managedRoot);
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    assertManagedPath(backupDir, managedRoot);
    const ownerToken = randomUUID();
    const canonicalPath = join(backupDir, '.delete.lock');
    const activePath = join(backupDir, `.delete.lock.${ownerToken}.active`);
    const stagingPath = join(backupDir, `.delete.lock.${ownerToken}.staging`);
    const retiredPath = join(backupDir, `.delete.lock.${ownerToken}.retired`);
    const reclaimGuardPath = join(backupDir, '.delete.reclaim.lock');
    let guardOwned = false;
    try {
      fs.writeFileSync(reclaimGuardPath, JSON.stringify({ pid: process.pid, token: ownerToken, created_at: new Date().toISOString() }) + '\n', { flag: 'wx' });
      guardOwned = true;
    } catch (error) {
      if (error?.code === 'EEXIST') throw Object.assign(new Error('another provider deletion is reclaiming the lock'), { code: 'PROVIDER_DELETE_BUSY' });
      throw Object.assign(new Error('provider delete lock reclaim unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
    }
    const ownerIsAlive = (owner) => {
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
      try { process.kill(owner.pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
    };
    const lockCandidates = () => {
      try {
        return readdirSync(backupDir, { withFileTypes: true })
          .filter((entry) => entry.name === '.delete.lock' || /^\.delete\.lock\.[0-9a-f-]+\.(?:active|staging)$/iu.test(entry.name))
          .map((entry) => join(backupDir, entry.name));
      } catch { return []; }
    };
    const ownerPathFor = (path) => {
      try { return lstatSync(path).isDirectory() ? join(path, 'owner.json') : path; } catch { return path; }
    };
    const ownerRecord = () => JSON.stringify({
        pid: process.pid,
        token: ownerToken,
        ...(typeof runtimeIdProvider === 'function' ? { runtime_id: runtimeIdProvider() } : {}),
        created_at: new Date().toISOString(),
      }) + '\n';
    const readOwner = (path) => {
      try { return readJson(ownerPathFor(path), null); } catch { return null; }
    };
    const writeStagingOwner = () => {
      fs.writeFileSync(stagingPath, ownerRecord(), { flag: 'wx' });
      const owner = readOwner(stagingPath);
      if (owner?.token !== ownerToken) throw Object.assign(new Error('provider delete owner metadata was not persisted'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
    };
    const adoptPrepared = (path) => {
      assertManagedPath(path, managedRoot);
      const owner = readOwner(path);
      if (owner?.token !== ownerToken) throw Object.assign(new Error('provider delete owner metadata was not persisted'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
      lockPath = path;
      lockOwnerToken = ownerToken;
      lockOwned = true;
    };
    const cleanup = (path) => { try { fs.rmSync(path, { recursive: true, force: true }); } catch {} };
    try {
      while (true) {
        const candidates = lockCandidates();
        if (candidates.length === 0) {
          try {
            writeStagingOwner();
            renameSync(stagingPath, canonicalPath);
            adoptPrepared(canonicalPath);
            return;
          } catch (error) {
            cleanup(stagingPath);
            if (error?.code === 'EEXIST' || error?.code === 'ENOENT') continue;
            throw Object.assign(new Error('provider deletion lock unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
          }
        }
        let raced = false;
        for (const candidate of candidates) {
          const owner = readOwner(candidate);
          if (owner && ownerIsAlive(owner) !== false) throw Object.assign(new Error('another provider deletion is active'), { code: 'PROVIDER_DELETE_BUSY' });
          try {
            writeStagingOwner();
            renameSync(candidate, retiredPath);
            renameSync(stagingPath, activePath);
            cleanup(retiredPath);
            adoptPrepared(activePath);
            return;
          } catch (error) {
            cleanup(stagingPath);
            if (error?.code === 'ENOENT' || error?.code === 'EEXIST') { raced = true; break; }
            throw Object.assign(new Error('provider deletion lock reclaim unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
          }
        }
        if (!raced) continue;
      }
    } catch (error) {
      cleanup(stagingPath);
      throw error;
    } finally {
      if (guardOwned) cleanup(reclaimGuardPath);
    }
  };

  if (existingBackupId !== null) {
    const backupId = safePlanId(existingBackupId);
    if (!backupId) throw Object.assign(new Error('provider backup id is invalid'), { code: 'PROVIDER_DELETE_PLAN_INVALID' });
    const root = join(backupDir, backupId);
    assertManagedPath(root, managedRoot);
    const manifest = readJson(join(root, 'manifest.json'), null);
    try {
      validateBackupManifest(manifest, { root, fs, paths, managedRoot, expectedProviderId });
    } catch (error) {
      if (error?.code === 'PROVIDER_DELETE_BACKUP_INVALID') throw error;
      throw backupInvalid();
    }
    activeBackup = { root, manifest };
  }

  const persistManifest = () => {
    if (!activeBackup) return;
    const manifestFile = join(activeBackup.root, 'manifest.json');
    assertManagedPath(manifestFile, managedRoot);
    atomicWrite(manifestFile, JSON.stringify(activeBackup.manifest, null, 2) + '\n', managedRoot);
  };

  const readVerifiedBackup = (key) => {
    const entry = activeBackup?.manifest?.files?.[key];
    if (!entry?.existed || !entry?.managed || key === 'config') return null;
    const backupFile = join(activeBackup.root, key === 'settings' ? 'settings.backup' : `${key}.backup`);
    const digest = activeBackup.manifest.backup_digests?.[key];
    assertManagedPath(backupFile, managedRoot);
    if (!/^[a-f0-9]{64}$/i.test(digest) || !fs.existsSync(backupFile) || lstatSync(backupFile).isSymbolicLink()) throw backupInvalid();
    const content = fs.readFileSync(backupFile);
    if (sha256(content) !== digest) throw backupInvalid();
    return content;
  };

  const prepareMutation = (key, nextRevision) => {
    if (!activeBackup || typeof nextRevision !== 'string') return;
    activeBackup.manifest.mutation_journal ??= {};
    activeBackup.manifest.mutation_journal[key] = {
      next_revision: nextRevision,
      prepared_at: new Date().toISOString(),
    };
    persistManifest();
  };

  const commitMutation = (key, nextRevision) => {
    if (!activeBackup || typeof nextRevision !== 'string') return;
    activeBackup.manifest[`applied_${key}_revision`] = nextRevision;
    if (activeBackup.manifest.mutation_journal) delete activeBackup.manifest.mutation_journal[key];
    persistManifest();
  };

  const setPhase = (phase, details = {}) => {
    if (!activeBackup) return;
    activeBackup.manifest.phase_journal = { phase, ...details, updated_at: new Date().toISOString() };
    persistManifest();
  };

  // Every managed writer runs while the transaction lock is held and verifies
  // both the target boundary and the resulting revision. Custom writers are
  // accepted for the Hub's in-memory adapters, but cannot bypass these checks.
  const writeManagedConfig = async (config, expectedRevision) => {
    ensureMutationLock();
    assertManagedPath(configFile, managedRoot);
    if (typeof expectedRevision === 'string') {
      const current = await readConfigFn();
      if (sha256(JSON.stringify(current)) !== expectedRevision) {
        throw Object.assign(new Error('provider config changed during commit'), { code: 'PROVIDER_CONFIG_CHANGED' });
      }
    }
    await writeConfig(config, { expectedRevision, managedRoot });
    assertManagedPath(configFile, managedRoot);
    const written = await readConfigFn();
    if (sha256(JSON.stringify(written)) !== sha256(JSON.stringify(config))) {
      throw Object.assign(new Error('provider config write could not be verified'), { code: 'PROVIDER_CONFIG_WRITE_UNVERIFIED' });
    }
  };

  const writeManagedSettings = async (content, options = {}) => {
    ensureMutationLock();
    if (typeof settingsFile !== 'string' || !settingsFile.trim()) {
      throw Object.assign(new Error('provider settings path is unavailable'), { code: 'PROVIDER_DELETE_SOURCE_UNRESOLVED' });
    }
    assertManagedPath(settingsFile, managedRoot);
    const current = fs.readFileSync(settingsFile, 'utf8');
    if (typeof options.expectedRevision === 'string' && sha256(current) !== options.expectedRevision) {
      throw Object.assign(new Error('provider settings changed during commit'), { code: 'PROVIDER_SETTINGS_CHANGED' });
    }
    await writeSettingsFn(content, { ...options, managedRoot });
    assertManagedPath(settingsFile, managedRoot);
    if (!fs.existsSync(settingsFile) || sha256(fs.readFileSync(settingsFile, 'utf8')) !== sha256(content)) {
      throw Object.assign(new Error('provider settings write could not be verified'), { code: 'PROVIDER_SETTINGS_WRITE_UNVERIFIED' });
    }
  };

  const backup = async (plan) => {
    const planId = safePlanId(plan?.plan_id);
    if (!planId) throw Object.assign(new Error('provider delete plan id is invalid'), { code: 'PROVIDER_DELETE_PLAN_INVALID' });
    validatePlanAuthorities(plan);
    await acquireLock();
    const root = join(backupDir, planId);
    assertManagedPath(root, managedRoot);
    if (fs.existsSync(root)) throw backupInvalid('provider backup id already exists');
    fs.mkdirSync(root);
    assertManagedPath(root, managedRoot);
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
        ...(plan.harness_default_before && typeof plan.harness_default_before === 'object' ? { harness_default_before: {
          provider: typeof plan.harness_default_before.provider === 'string' ? plan.harness_default_before.provider.trim() : null,
          model: typeof plan.harness_default_before.model === 'string' ? plan.harness_default_before.model.trim() : null,
        } } : {}),
        ...(plan.harness_default_authority && typeof plan.harness_default_authority === 'object' ? { harness_default_authority: {
          kind: typeof plan.harness_default_authority.kind === 'string' ? plan.harness_default_authority.kind.trim() : 'unknown',
          locator: typeof plan.harness_default_authority.locator === 'string' ? plan.harness_default_authority.locator.trim() : 'unknown',
        } } : {}),
        ...(typeof plan.runtime_id_before === 'string' && plan.runtime_id_before.trim() ? { runtime_id_before: plan.runtime_id_before.trim().slice(0, 128) } : {}),
        ...(typeof plan.delete_runtime_id_before_restart === 'string' && plan.delete_runtime_id_before_restart.trim() ? { delete_runtime_id_before_restart: plan.delete_runtime_id_before_restart.trim().slice(0, 128) } : {}),
        declaration_authorities: (Array.isArray(plan.declaration_authorities) ? plan.declaration_authorities : []).map((authority) => ({
          kind: typeof authority?.kind === 'string' ? authority.kind.trim() : 'unknown',
          locator: typeof authority?.locator === 'string' ? authority.locator.trim() : 'unknown',
        })).filter((authority) => authority.kind && authority.locator).slice(0, 16),
        ...(plan.expected_revisions && typeof plan.expected_revisions === 'object' ? { expected_revisions: {
          profile: typeof plan.expected_revisions.profile === 'string' ? plan.expected_revisions.profile : null,
          settings: typeof plan.expected_revisions.settings === 'string' ? plan.expected_revisions.settings : null,
        } } : {}),
        credential_refs: (Array.isArray(plan.credential_refs) ? plan.credential_refs : []).map((ref) => ({
          kind: typeof ref?.kind === 'string' ? ref.kind.trim() : 'unknown',
          name_or_handle: typeof ref?.name_or_handle === 'string' ? ref.name_or_handle.trim() : 'unknown',
          ownership: typeof ref?.ownership === 'string' ? ref.ownership.trim() : 'unknown',
        })).filter((ref) => ref.kind && ref.name_or_handle && ref.ownership).slice(0, 32),
      },
      files: {},
      backup_digests: {},
      mutation_journal: {},
      phase_journal: { phase: 'PLANNED', updated_at: new Date().toISOString() },
    };
    const authorityKinds = new Set((Array.isArray(plan?.declaration_authorities) ? plan.declaration_authorities : []).map((authority) => authority?.kind));
    const managesHarnessDefault = plan?.was_harness_default === true && plan?.harness_default_authority?.kind === 'harness-settings';
    const sourceRevisions = {};
    let configBytes = null;
    try { configBytes = fs.readFileSync(configFile); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const configExisted = configBytes !== null;
    const configSnapshot = configExisted ? parseManagedJson(configBytes) : {};
    let lifecycleBytes = null;
    try { lifecycleBytes = fs.readFileSync(lifecycleFile); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const lifecycleExisted = lifecycleBytes !== null;
    const lifecycleSnapshot = lifecycleExisted
      ? normalizeProviderLifecycleState(parseManagedJson(lifecycleBytes))
      : normalizeProviderLifecycleState({});
    assertManagedPath(lifecycleFile, managedRoot);
    for (const key of FILE_KEYS) {
      const source = paths[key];
      assertManagedPath(source, managedRoot);
      const existed = key === 'config' ? configExisted : key === 'lifecycle' ? lifecycleExisted : fs.existsSync(source);
      const managed = key !== 'profile' || authorityKinds.has('crew-profile');
      manifest.files[key] = { existed, managed };
      if (existed && key !== 'config' && managed) {
        const sourceBytes = key === 'lifecycle' ? lifecycleBytes : fs.readFileSync(source);
        const sourceText = decodeUtf8(sourceBytes);
        // The backup contains this exact snapshot, never a second pathname
        // read after a possible ancestor/junction swap.
        assertManagedPath(source, managedRoot);
        const expectedSourceRevision = key === 'profile'
          ? (plan.expected_revisions?.profile ?? plan.expected_revision)
          : plan.expected_revisions?.lifecycle;
        if (typeof expectedSourceRevision === 'string' && sha256(sourceText) !== expectedSourceRevision) {
          throw Object.assign(new Error(`${key} changed before backup`), { code: key === 'profile' ? 'PROVIDER_PROFILE_CHANGED' : 'PROVIDER_DELETE_STATE_CHANGED' });
        }
        if (key === 'profile') {
          const credentials = hasInlineProfileCredentials(sourceText);
          if (credentials.ok !== true) throw Object.assign(new Error('provider profile credential shape is unsupported'), { code: 'PROVIDER_DELETE_FILE_INVALID' });
          if (credentials.inline === true) throw Object.assign(new Error('inline provider credential is not supported'), { code: 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED' });
        }
        const target = join(root, `${key}.backup`);
        assertManagedPath(target, managedRoot);
        atomicWrite(target, sourceBytes, managedRoot);
        manifest.backup_digests[key] = sha256(sourceBytes);
        sourceRevisions[key] = sha256(sourceBytes);
      }
    }
    if (typeof settingsFile === 'string' && settingsFile.trim()) {
      assertManagedPath(settingsFile, managedRoot);
      const existed = fs.existsSync(settingsFile);
      const managed = authorityKinds.has('harness-settings') || managesHarnessDefault;
      manifest.files.settings = { existed, managed };
      if (existed && managed) {
        const sourceBytes = fs.readFileSync(settingsFile);
        const sourceText = decodeUtf8(sourceBytes);
        assertManagedPath(settingsFile, managedRoot);
        const expectedSettingsRevision = plan.expected_revisions?.settings ?? (!authorityKinds.has('crew-profile') ? plan.expected_revision : null);
        if (typeof expectedSettingsRevision === 'string' && sha256(sourceText) !== expectedSettingsRevision) {
          throw Object.assign(new Error('provider settings changed before backup'), { code: 'PROVIDER_SETTINGS_CHANGED' });
        }
        const credentials = hasInlineSettingsCredentials(sourceText);
        if (credentials.ok !== true) throw Object.assign(new Error('provider settings credential shape is unsupported'), { code: 'PROVIDER_DELETE_FILE_INVALID' });
        if (credentials.inline === true) throw Object.assign(new Error('inline provider credential is not supported'), { code: 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED' });
        const target = join(root, 'settings.backup');
        assertManagedPath(target, managedRoot);
        atomicWrite(target, sourceBytes, managedRoot);
        manifest.backup_digests.settings = sha256(sourceBytes);
        sourceRevisions.settings = sha256(sourceBytes);
      }
    }
    manifest.config_projection = configProjection(configSnapshot);
    manifest.config_revision = sha256(JSON.stringify(configSnapshot));
    manifest.lifecycle_revision = sha256(JSON.stringify(lifecycleSnapshot));
    manifest.routing_projection_digest = sha256(JSON.stringify(manifest.config_projection));
    manifest.lifecycle_projection_digest = sha256(JSON.stringify(lifecycleProjection(lifecycleSnapshot)));
    if (authorityKinds.has('crew-profile') && sourceRevisions.profile) manifest.profile_revision = sourceRevisions.profile;
    if ((authorityKinds.has('harness-settings') || managesHarnessDefault) && sourceRevisions.settings) manifest.settings_revision = sourceRevisions.settings;
    activeBackup = { root, manifest };
    persistManifest();
    return { ok: true, backup_id: planId };
  };

  const markTombstone = async (providerId) => {
    if (!validProviderId(providerId)) throw Object.assign(new Error('provider id is invalid'), { code: 'PROVIDER_NOT_FOUND' });
    assertManagedPath(lifecycleFile, managedRoot);
    const state = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    if (activeBackup?.manifest?.lifecycle_revision && sha256(JSON.stringify(state)) !== activeBackup.manifest.lifecycle_revision) {
      throw Object.assign(new Error('provider lifecycle changed'), { code: 'PROVIDER_LIFECYCLE_CHANGED' });
    }
    const marked = markProviderTombstone(state, providerId);
    ensureMutationLock();
    const latestState = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    if (sha256(JSON.stringify(latestState)) !== sha256(JSON.stringify(state))) {
      throw Object.assign(new Error('provider lifecycle changed during commit'), { code: 'PROVIDER_LIFECYCLE_CHANGED' });
    }
    setPhase('TOMBSTONE_APPLYING');
    const nextRevision = sha256(JSON.stringify(marked));
    prepareMutation('lifecycle', nextRevision);
    atomicWrite(lifecycleFile, JSON.stringify(marked, null, 2) + '\n', managedRoot);
    commitMutation('lifecycle', nextRevision);
    setPhase('TOMBSTONE_APPLIED');
  };

  const scrubReferences = async (plan) => {
    const config = await readConfigFn();
    if (sha256(JSON.stringify(config)) !== activeBackup?.manifest?.config_revision) {
      throw Object.assign(new Error('provider config changed'), { code: 'PROVIDER_CONFIG_CHANGED' });
    }
    const scrubbed = scrubProviderReferences(config, [plan.provider_id]);
    setPhase('REFERENCES_APPLYING');
    let settingsMutation = null;
    const authorityKinds = authorityKindsFor(plan);
    if (plan.was_harness_default === true) {
      if (!validProviderId(plan.replacement_default) || typeof plan.replacement_default_model !== 'string' || !plan.replacement_default_model.trim()) {
        throw Object.assign(new Error('replacement Harness Default model is required'), { code: 'PROVIDER_DEFAULT_REPLACEMENT_MODEL_REQUIRED' });
      }
      if (plan.harness_default_authority?.kind !== 'harness-settings' || plan.harness_default_authority.locator !== 'agent-default-model' || typeof settingsFile !== 'string' || !settingsFile.trim() || !fs.existsSync(settingsFile)) {
        throw Object.assign(new Error('Harness Default authority is unavailable'), { code: 'PROVIDER_DEFAULT_AUTHORITY_UNAVAILABLE' });
      }
      const source = fs.readFileSync(settingsFile, 'utf8');
      settingsMutation = mutateProviderSettings(source, {
        providerId: authorityKinds.has('harness-settings') ? plan.provider_id : null,
        removeProvider: authorityKinds.has('harness-settings'),
        replacementDefault: plan.replacement_default,
        replacementModel: plan.replacement_default_model.trim(),
        expectedRevision: plan.expected_revisions?.settings ?? activeBackup?.manifest?.settings_revision,
      });
      if (!settingsMutation.ok) throw Object.assign(new Error('Harness Default settings changed'), { code: settingsMutation.code });
      scrubbed.config.harness_default = {
        provider: plan.replacement_default,
        model: plan.replacement_default_model.trim(),
      };
    }
    const configRevision = sha256(JSON.stringify(scrubbed.config));
    prepareMutation('config', configRevision);
    await writeManagedConfig(scrubbed.config, activeBackup?.manifest?.config_revision);
    commitMutation('config', configRevision);
    if (settingsMutation) {
      prepareMutation('settings', settingsMutation.revision);
      await writeManagedSettings(settingsMutation.text, { expectedRevision: plan.expected_revisions?.settings ?? activeBackup?.manifest?.settings_revision });
      commitMutation('settings', settingsMutation.revision);
    }
    setPhase('REFERENCES_APPLIED');
  };

  const authorityKindsFor = (plan) => new Set((Array.isArray(plan?.declaration_authorities) ? plan.declaration_authorities : []).map((authority) => authority?.kind));

  const removeDeclarations = async (plan) => {
    const authorityKinds = authorityKindsFor(plan);
    setPhase('DECLARATIONS_APPLYING');
    let removed = plan.was_harness_default === true && authorityKinds.has('harness-settings') ? 1 : 0;
    if (authorityKinds.has('crew-profile')) {
      assertManagedPath(profileFile, managedRoot);
      const source = fs.readFileSync(profileFile, 'utf8');
      const result = removeProviderDeclarations(source, {
        providerIds: [plan.provider_id],
        expectedRevision: plan.expected_revisions?.profile ?? plan.expected_revision,
      });
      if (!result.ok) throw Object.assign(new Error('provider profile changed'), { code: result.code });
      ensureMutationLock();
      const latestProfile = fs.readFileSync(profileFile, 'utf8');
      if (sha256(latestProfile) !== (plan.expected_revisions?.profile ?? plan.expected_revision)) {
        throw Object.assign(new Error('provider profile changed during commit'), { code: 'PROVIDER_PROFILE_CHANGED' });
      }
      prepareMutation('profile', result.revision);
      atomicWrite(profileFile, result.text, managedRoot);
      removed += result.removed.length;
      commitMutation('profile', result.revision);
    }
    if (authorityKinds.has('harness-settings') && !(plan.was_harness_default === true)) {
      if (typeof settingsFile !== 'string' || !settingsFile.trim()) throw Object.assign(new Error('provider settings path is unavailable'), { code: 'PROVIDER_DELETE_SOURCE_UNRESOLVED' });
      assertManagedPath(settingsFile, managedRoot);
      const source = fs.readFileSync(settingsFile, 'utf8');
      const result = removeProviderSettings(source, {
        providerIds: [plan.provider_id],
        expectedRevision: plan.expected_revisions?.settings,
      });
      if (!result.ok) throw Object.assign(new Error('provider settings changed'), { code: result.code });
      prepareMutation('settings', result.revision);
        await writeManagedSettings(result.text, { expectedRevision: plan.expected_revisions?.settings });
      removed += result.removed.length;
      commitMutation('settings', result.revision);
    }
    if (removed === 0) throw Object.assign(new Error('provider declaration source is unavailable'), { code: 'PROVIDER_DELETE_SOURCE_UNRESOLVED' });
    setPhase('DECLARATIONS_APPLIED');
  };

  const checkpointApplied = async () => {
    if (!activeBackup) throw Object.assign(new Error('provider delete backup is unavailable'), { code: 'PROVIDER_DELETE_BACKUP_INVALID' });
    const config = await readConfigFn();
    const lifecycle = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    activeBackup.manifest.applied_config_revision = sha256(JSON.stringify(config));
    activeBackup.manifest.applied_lifecycle_revision = sha256(JSON.stringify(lifecycle));
    if (activeBackup.manifest.files.profile?.managed !== false && fs.existsSync(profileFile)) activeBackup.manifest.applied_profile_revision = sha256(fs.readFileSync(profileFile, 'utf8'));
    if (activeBackup.manifest.files.settings?.managed === true && typeof settingsFile === 'string' && settingsFile.trim() && fs.existsSync(settingsFile)) activeBackup.manifest.applied_settings_revision = sha256(fs.readFileSync(settingsFile, 'utf8'));
    activeBackup.manifest.mutation_journal = {};
    persistManifest();
  };

  const backupPlan = () => (activeBackup?.manifest?.plan ? { ...activeBackup.manifest.plan } : null);

  const setRuntimeBaseline = async (runtimeId, phase) => {
    if (!activeBackup) throw Object.assign(new Error('provider delete backup is unavailable'), { code: 'PROVIDER_DELETE_BACKUP_INVALID' });
    if (typeof runtimeId !== 'string' || runtimeId.trim() === '') throw Object.assign(new Error('runtime identity is required'), { code: 'PROVIDER_RUNTIME_ID_MISSING' });
    const key = phase === 'rollback' ? 'rollback_runtime_id_before_restart' : phase === 'delete' ? 'delete_runtime_id_before_restart' : null;
    if (!key) throw Object.assign(new Error('runtime baseline phase is invalid'), { code: 'PROVIDER_DELETE_PLAN_INVALID' });
    activeBackup.manifest.plan[key] = runtimeId.trim().slice(0, 128);
    setPhase(phase === 'rollback' ? 'ROLLBACK_RESTART_PENDING' : 'DELETE_RESTART_PENDING');
    persistManifest();
    return { ok: true, phase, runtime_id: activeBackup.manifest.plan[key] };
  };

  const captureRuntimeBaseline = async (_plan, phase) => {
    if (typeof runtimeIdProvider !== 'function') return { ok: false, code: 'PROVIDER_RUNTIME_ID_PROVIDER_UNAVAILABLE' };
    return setRuntimeBaseline(runtimeIdProvider(), phase);
  };

  const verify = async (plan) => {
    const authorityKinds = authorityKindsFor(plan);
    assertManagedPath(profileFile, managedRoot);
    assertManagedPath(lifecycleFile, managedRoot);
    let providerAbsent = true;
    if (authorityKinds.has('crew-profile')) {
      const source = fs.readFileSync(profileFile, 'utf8');
      const parsed = readProviderDeclarations(source, { file: 'harness/profiles/dsh-crew/cordis.patch.yml' });
      providerAbsent = parsed.ok && !parsed.declarations.some((declaration) => declaration.id === plan.provider_id);
    }
    if (authorityKinds.has('harness-settings')) {
      if (typeof settingsFile !== 'string' || !settingsFile.trim() || !fs.existsSync(settingsFile)) providerAbsent = false;
      else {
        const parsed = readProviderSettingsDeclarations(fs.readFileSync(settingsFile, 'utf8'), { file: 'harness/settings.yaml' });
        providerAbsent = providerAbsent && parsed.ok && !parsed.declarations.some((declaration) => declaration.id === plan.provider_id);
      }
    }
    const config = await readConfigFn();
    const routingClear = scrubProviderReferences(config, [plan.provider_id]).removed.length === 0;
    const replacementApplied = plan.was_harness_default !== true || (
      config?.harness_default?.provider === plan.replacement_default
      && config?.harness_default?.model === plan.replacement_default_model
    );
    const persistedDefault = typeof settingsFile === 'string' && settingsFile.trim() && fs.existsSync(settingsFile)
      ? readHarnessDefault(fs.readFileSync(settingsFile, 'utf8')) : { ok: false };
    const harnessDefaultApplied = plan.was_harness_default === true
      ? persistedDefault.ok && persistedDefault.provider === plan.replacement_default && persistedDefault.model === plan.replacement_default_model
      : !persistedDefault.ok || persistedDefault.provider !== plan.provider_id;
    const state = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    return {
      providerAbsent,
      routingClear: routingClear && replacementApplied && harnessDefaultApplied,
      tombstonePresent: state.tombstones[plan.provider_id] === 'absent',
    };
  };

  const rollback = async () => {
    if (!activeBackup) throw Object.assign(new Error('provider delete backup is unavailable'), { code: 'PROVIDER_DELETE_ROLLBACK_UNAVAILABLE' });
    ensureMutationLock();
    const allowedRevision = (current, original, applied, key) => current === original
      || (typeof applied === 'string' && current === applied)
      || (typeof activeBackup.manifest.mutation_journal?.[key]?.next_revision === 'string' && current === activeBackup.manifest.mutation_journal[key].next_revision);
    const currentConfig = await readConfigFn();
    const currentLifecycle = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    const currentProfile = fs.existsSync(profileFile) ? fs.readFileSync(profileFile, 'utf8') : null;
    const currentSettings = typeof settingsFile === 'string' && settingsFile.trim() && fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
    if (!allowedRevision(sha256(JSON.stringify(currentConfig)), activeBackup.manifest.config_revision, activeBackup.manifest.applied_config_revision, 'config')
      || !allowedRevision(sha256(JSON.stringify(currentLifecycle)), activeBackup.manifest.lifecycle_revision, activeBackup.manifest.applied_lifecycle_revision, 'lifecycle')
      || (activeBackup.manifest.profile_revision && (!currentProfile || !allowedRevision(sha256(currentProfile), activeBackup.manifest.profile_revision, activeBackup.manifest.applied_profile_revision, 'profile')))
      || (activeBackup.manifest.settings_revision && (!currentSettings || !allowedRevision(sha256(currentSettings), activeBackup.manifest.settings_revision, activeBackup.manifest.applied_settings_revision, 'settings')))) {
      throw Object.assign(new Error('managed provider state changed after the transaction'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
    }
    const removeIfTransactionCreated = async (key, target) => {
      ensureMutationLock();
      assertManagedPath(target, managedRoot);
      if (!fs.existsSync(target)) return;
      const expected = activeBackup.manifest[`applied_${key}_revision`]
        ?? activeBackup.manifest.mutation_journal?.[key]?.next_revision;
      if (typeof expected !== 'string') throw Object.assign(new Error('managed provider state changed during rollback'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
      let current;
      if (key === 'config') current = sha256(JSON.stringify(await readConfigFn()));
      else if (key === 'lifecycle') current = sha256(JSON.stringify(normalizeProviderLifecycleState(readJson(lifecycleFile, {}))));
      else current = sha256(fs.readFileSync(target));
      if (current !== expected) throw Object.assign(new Error('managed provider state changed during rollback'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
      assertManagedPath(target, managedRoot);
      fs.rmSync(target, { force: true });
      assertManagedPath(target, managedRoot);
    };
    setPhase('ROLLBACK_APPLYING');
    for (const key of FILE_KEYS) {
      const target = paths[key];
      const entry = activeBackup.manifest.files[key];
      if (key === 'profile' && entry?.managed === false) continue;
      const backupFile = join(activeBackup.root, `${key}.backup`);
      assertManagedPath(backupFile, managedRoot);
      assertManagedPath(target, managedRoot);
      if (key === 'config') {
        if (entry?.existed === true) {
          const restored = restoreConfigProjection(await readConfigFn(), activeBackup.manifest.config_projection);
          await writeManagedConfig(restored, sha256(JSON.stringify(currentConfig)));
        } else {
          await removeIfTransactionCreated('config', target);
        }
      } else if (key === 'lifecycle' && entry?.existed === true) {
        ensureMutationLock();
        const verifiedLifecycle = readVerifiedBackup('lifecycle');
        const latestLifecycle = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
        if (!allowedRevision(sha256(JSON.stringify(latestLifecycle)), activeBackup.manifest.lifecycle_revision, activeBackup.manifest.applied_lifecycle_revision, 'lifecycle')) {
          throw Object.assign(new Error('managed provider state changed during rollback'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
        }
        const savedLifecycle = normalizeProviderLifecycleState(parseManagedJson(verifiedLifecycle));
        const restoredLifecycle = { ...currentLifecycle, tombstones: { ...savedLifecycle.tombstones } };
        const restoredRevision = sha256(JSON.stringify(restoredLifecycle));
        prepareMutation('lifecycle', restoredRevision);
        atomicWrite(target, JSON.stringify(restoredLifecycle, null, 2) + '\n', managedRoot);
        commitMutation('lifecycle', restoredRevision);
      } else if (entry?.existed === true) {
        ensureMutationLock();
        const verifiedContent = readVerifiedBackup(key);
        const latest = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
        if (latest === null || !allowedRevision(sha256(latest), activeBackup.manifest[`${key}_revision`], activeBackup.manifest[`applied_${key}_revision`], key)) {
          throw Object.assign(new Error('managed provider state changed during rollback'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
        }
        safeRestoreFile(backupFile, target, managedRoot, verifiedContent);
      } else {
        await removeIfTransactionCreated(key, target);
      }
    }
    const settingsEntry = activeBackup.manifest.files.settings;
    if (settingsEntry?.managed === true && typeof settingsFile === 'string' && settingsFile.trim()) {
      ensureMutationLock();
      assertManagedPath(settingsFile, managedRoot);
      const backupFile = join(activeBackup.root, 'settings.backup');
      assertManagedPath(backupFile, managedRoot);
      if (settingsEntry?.existed === true) {
        const verifiedSettings = readVerifiedBackup('settings');
        const latestSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
        if (latestSettings === null || !allowedRevision(sha256(latestSettings), activeBackup.manifest.settings_revision, activeBackup.manifest.applied_settings_revision, 'settings')) {
          throw Object.assign(new Error('managed provider state changed during rollback'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
        }
        safeRestoreFile(backupFile, settingsFile, managedRoot, verifiedSettings);
      }
      else await removeIfTransactionCreated('settings', settingsFile);
    }
    activeBackup.manifest.mutation_journal = {};
    setPhase('ROLLBACK_RESTORED');
  };

  const release = async () => {
    if (!lockOwned || !lockPath) return;
    try {
      let owner = null;
      let ownerPath = lockPath;
      try { if (lstatSync(lockPath).isDirectory()) ownerPath = join(lockPath, 'owner.json'); } catch {}
      try { owner = readJson(ownerPath, null); } catch {}
      if (owner?.token === lockOwnerToken) fs.rmSync(lockPath, { recursive: true, force: true });
    } finally { lockOwned = false; lockPath = null; lockOwnerToken = null; }
  };

  const verifyRollback = async (plan) => {
    const authorityKinds = authorityKindsFor(plan);
    assertManagedPath(profileFile, managedRoot);
    assertManagedPath(lifecycleFile, managedRoot);
    const source = fs.existsSync(profileFile) ? fs.readFileSync(profileFile, 'utf8') : null;
    const parsed = source === null ? { ok: false } : readProviderDeclarations(source, { file: 'harness/profiles/dsh-crew/cordis.patch.yml' });
    const legacyPlan = authorityKinds.size === 0;
    let providerPresent = (authorityKinds.has('crew-profile') || legacyPlan) && parsed.ok && parsed.declarations.some((declaration) => declaration.id === plan.provider_id);
    if ((authorityKinds.has('harness-settings') || legacyPlan) && activeBackup?.manifest?.files?.settings?.existed === true && typeof settingsFile === 'string' && settingsFile.trim()) {
      const settings = readProviderSettingsDeclarations(fs.readFileSync(settingsFile, 'utf8'), { file: 'harness/settings.yaml' });
      providerPresent = providerPresent || (settings.ok && settings.declarations.some((declaration) => declaration.id === plan.provider_id));
    }
    const config = await readConfigFn();
    const state = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    const routingRestored = typeof activeBackup?.manifest?.routing_projection_digest === 'string'
      && sha256(JSON.stringify(configProjection(config))) === activeBackup.manifest.routing_projection_digest;
    const lifecycleRestored = typeof activeBackup?.manifest?.lifecycle_projection_digest === 'string'
      && sha256(JSON.stringify(lifecycleProjection(state))) === activeBackup.manifest.lifecycle_projection_digest;
    const declarationRestored = !activeBackup?.manifest?.profile_revision
      || (source !== null && sha256(source) === activeBackup.manifest.profile_revision);
    const settingsRestored = !activeBackup?.manifest?.settings_revision || (typeof settingsFile === 'string' && settingsFile.trim() && fs.existsSync(settingsFile) && sha256(fs.readFileSync(settingsFile, 'utf8')) === activeBackup.manifest.settings_revision);
    return {
      ok: providerPresent && state.tombstones[plan.provider_id] !== 'absent'
        && routingRestored && lifecycleRestored && declarationRestored && settingsRestored,
      providerPresent,
      tombstoneCleared: state.tombstones[plan.provider_id] !== 'absent',
      routingRestored,
      lifecycleRestored,
      declarationRestored,
      settingsRestored,
    };
  };

  const recordTransaction = async (result, plan) => {
    ensureMutationLock();
    assertManagedPath(lifecycleFile, managedRoot);
    const state = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    const initialRevision = sha256(JSON.stringify(state));
    const next = recordProviderTransaction(state, {
      transaction_id: result?.transaction_id ?? plan?.plan_id,
      provider_id: result?.provider_id ?? plan?.provider_id,
      state: result?.state,
      updated_at: new Date().toISOString(),
      expected_revision: plan?.expected_revision,
      credential_refs: plan?.credential_refs,
    });
    if (result?.state === 'VERIFIED') {
      const profileRevision = fs.existsSync(profileFile) ? sha256(fs.readFileSync(profileFile, 'utf8')) : '';
      const settingsRevision = activeBackup?.manifest?.files?.settings?.managed === true
        && typeof settingsFile === 'string' && settingsFile.trim() && fs.existsSync(settingsFile)
        ? sha256(fs.readFileSync(settingsFile, 'utf8')) : '';
      next.last_verified_revision[plan.provider_id] = sha256(`${profileRevision}:${settingsRevision}`);
    }
    const nextRevision = sha256(JSON.stringify(next));
    const latestState = normalizeProviderLifecycleState(readJson(lifecycleFile, {}));
    if (sha256(JSON.stringify(latestState)) !== initialRevision) {
      throw Object.assign(new Error('provider lifecycle changed during audit'), { code: 'PROVIDER_LIFECYCLE_CHANGED' });
    }
    prepareMutation('lifecycle', nextRevision);
    atomicWrite(lifecycleFile, JSON.stringify(next, null, 2) + '\n', managedRoot);
    commitMutation('lifecycle', nextRevision);
    setPhase(result?.state === 'RESTART_PENDING' ? 'RESTART_PENDING' : result?.state === 'ROLLBACK_PENDING' ? 'ROLLBACK_PENDING' : result?.state ?? 'AUDIT_APPLYING');
  };

  return {
    backup,
    acquireLock,
    recoverLock,
    checkpointApplied,
    setRuntimeBaseline,
    ...(typeof runtimeIdProvider === 'function' ? { captureRuntimeBaseline } : {}),
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
