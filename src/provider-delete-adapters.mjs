// Filesystem-backed adapters for the provider deletion transaction.
//
// The transaction state machine remains side-effect free. This module owns
// only the Crew-managed files that can be changed by a provider delete: the
// Harness provider patch, Harness settings provider map, canonical Crew
// config, and lifecycle tombstone file. Credentials are deliberately never
// read or copied.

import {
  copyFileSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
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

function safeRecoveryEntryName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && value !== '.' && value !== '..' && !/[\\/\u0000]/u.test(value) ? value : null;
}

function atomicWrite(file, content, managedRoot = null, { replace = true } = {}) {
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
    if (replace) renameSync(temp, file);
    else {
      linkSync(temp, file);
      rmSync(temp, { force: true });
    }
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

function atomicCreateWithWitness(file, content, managedRoot, witness) {
  if (!managedRoot || typeof witness !== 'string' || !witness.trim()) {
    throw Object.assign(new Error('exclusive provider create witness is unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
  }
  assertManagedPath(file, managedRoot);
  assertManagedPath(witness, managedRoot);
  const parent = dirname(file);
  assertManagedPath(parent, managedRoot);
  if (!existsSync(parent)) throw Object.assign(new Error('managed provider directory is missing'), { code: 'PROVIDER_DELETE_UNSAFE_PATH' });
  const witnessExisted = existsSync(witness);
  try {
    if (witnessExisted) {
      if (sha256(readFileSync(witness)) !== sha256(content)) throw Object.assign(new Error('provider create witness content changed'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
    } else writeFileSync(witness, content, { flag: 'wx' });
    assertManagedPath(witness, managedRoot);
    linkSync(witness, file);
    assertManagedPath(file, managedRoot);
    return witness;
  } catch (error) {
    if (!witnessExisted) { try { rmSync(witness, { force: true }); } catch {} }
    throw error;
  }
}

function atomicReplaceWithWitness(file, content, managedRoot, witness) {
  if (!managedRoot || typeof witness !== 'string' || !witness.trim()) {
    throw Object.assign(new Error('provider replace witness is unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
  }
  assertManagedPath(file, managedRoot);
  assertManagedPath(witness, managedRoot);
  const stage = join(dirname(witness), `.${basename(file)}.${randomUUID()}.replace-stage`);
  assertManagedPath(stage, managedRoot);
  let published = false;
  const witnessExisted = existsSync(witness);
  try {
    if (witnessExisted) {
      if (sha256(readFileSync(witness)) !== sha256(content)) throw Object.assign(new Error('provider replace witness content changed'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
    } else writeFileSync(witness, content, { flag: 'wx' });
    linkSync(witness, stage);
    assertManagedPath(file, managedRoot);
    renameSync(stage, file);
    published = true;
    assertManagedPath(file, managedRoot);
    return witness;
  } catch (error) {
    try { rmSync(stage, { force: true }); } catch {}
    if (!published && !witnessExisted) { try { rmSync(witness, { force: true }); } catch {} }
    throw error;
  }
}

function defaultWriteConfig(configFile, config, managedRoot = null, replace = true) {
  atomicWrite(configFile, JSON.stringify(config, null, 2) + '\n', managedRoot, { replace });
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
  const projection = { schema_version: 1, fields: {}, present_fields: [] };
  for (const key of ['flash_model_priority', 'pro_model_priority', 'harness_default', 'agent_default_model', 'agentDefaultModel']) {
    if (hasOwn(config, key)) {
      projection.present_fields.push(key);
      projection.fields[key] = key.endsWith('_priority') ? safeModelRefList(config[key]) : safeModelRef(config[key]);
    }
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
    else if (Array.isArray(projection?.present_fields) && !projection.present_fields.includes(key)) delete next[key];
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
    const resolvedRelative = relative(root, target);
    const outside = /^(?:\.\.(?:[\\/]|$))/.test(resolvedRelative) || isAbsolute(resolvedRelative);
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
      if (/^(?:\.\.(?:[\\/]|$))/.test(resolvedRelative) || isAbsolute(resolvedRelative)) throw Object.assign(new Error('managed provider path resolves outside Crew root'), { code: 'PROVIDER_DELETE_UNSAFE_PATH' });
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

function readManagedJsonSnapshot(file, managedRoot, fsLike = { readFileSync }) {
  assertManagedPath(file, managedRoot);
  let stat;
  try { stat = lstatSync(file, { bigint: true }); }
  catch { throw Object.assign(new Error('managed provider manifest is unavailable'), { code: 'PROVIDER_DELETE_BACKUP_INVALID' }); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw Object.assign(new Error('managed provider manifest path is unsafe'), { code: 'PROVIDER_DELETE_UNSAFE_PATH' });
  }
  let fd;
  try {
    fd = openSync(file, 'r');
    const pinned = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity({ dev: String(stat.dev), ino: String(stat.ino) }, { dev: String(pinned.dev), ino: String(pinned.ino) })) {
      throw Object.assign(new Error('managed provider manifest changed during open'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
    }
    return parseManagedJson(readFileSync(fd));
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

function assertManagedEntryPath(file, managedRoot) {
  const root = resolvePath(managedRoot);
  const target = resolvePath(file);
  const resolvedRelative = relative(root, target);
  if (/^(?:\.\.(?:[\\/]|$))/.test(resolvedRelative) || isAbsolute(resolvedRelative)) {
    throw Object.assign(new Error('managed provider entry escapes Crew root'), { code: 'PROVIDER_DELETE_UNSAFE_PATH' });
  }
  // Validate every ancestor but intentionally do not follow or reject the
  // leaf: quarantine must be able to move a symlink/junction entry itself.
  assertManagedPath(dirname(target), managedRoot);
}

export function readProviderDeleteManifestFile(file, managedRoot) {
  return readManagedJsonSnapshot(file, managedRoot);
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

function fileIdentity(file) {
  const stat = lstatSync(file, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameFileIdentity(left, right) {
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
}

function recoveryDescriptor(manifest) {
  return {
    plan: {
      plan_id: manifest?.plan?.plan_id ?? null,
      provider_id: manifest?.plan?.provider_id ?? null,
      declaration_authorities: manifest?.plan?.declaration_authorities ?? null,
      was_harness_default: manifest?.plan?.was_harness_default ?? null,
      harness_default_authority: manifest?.plan?.harness_default_authority ?? null,
      replacement_default: manifest?.plan?.replacement_default ?? null,
      replacement_default_model: manifest?.plan?.replacement_default_model ?? null,
      harness_default_before: manifest?.plan?.harness_default_before ?? null,
      runtime_id_before: manifest?.plan?.runtime_id_before ?? null,
      delete_runtime_id_before_restart: manifest?.plan?.delete_runtime_id_before_restart ?? null,
      rollback_runtime_id_before_restart: manifest?.plan?.rollback_runtime_id_before_restart ?? null,
      expected_revision: manifest?.plan?.expected_revision ?? null,
      expected_revisions: manifest?.plan?.expected_revisions ?? null,
      credential_refs: manifest?.plan?.credential_refs ?? null,
    },
    files: manifest?.files ?? null,
    backup_digests: manifest?.backup_digests ?? null,
    profile_revision: manifest?.profile_revision ?? null,
    settings_revision: manifest?.settings_revision ?? null,
    config_revision: manifest?.config_revision ?? null,
    lifecycle_revision: manifest?.lifecycle_revision ?? null,
    routing_projection_digest: manifest?.routing_projection_digest ?? null,
    lifecycle_projection_digest: manifest?.lifecycle_projection_digest ?? null,
    applied_revisions: {
      profile: manifest?.applied_profile_revision ?? null,
      settings: manifest?.applied_settings_revision ?? null,
      config: manifest?.applied_config_revision ?? null,
      lifecycle: manifest?.applied_lifecycle_revision ?? null,
    },
    created: {
      profile: manifest?.created_profile ?? false,
      settings: manifest?.created_settings ?? false,
      config: manifest?.created_config ?? false,
      lifecycle: manifest?.created_lifecycle ?? false,
    },
    created_identities: {
      profile: manifest?.created_profile_identity ?? null,
      settings: manifest?.created_settings_identity ?? null,
      config: manifest?.created_config_identity ?? null,
      lifecycle: manifest?.created_lifecycle_identity ?? null,
    },
    ownership_witnesses: manifest?.ownership_witnesses ?? null,
    mutation_journal: manifest?.mutation_journal ?? null,
    phase_journal: manifest?.phase_journal ?? null,
  };
}

function validateBackupManifest(manifest, { root, fs, paths, managedRoot, expectedProviderId }) {
  const backupId = basename(root);
  if (!manifest || manifest.schema_version !== 1 || !validProviderId(manifest.provider_id)
    || (expectedProviderId && manifest.provider_id !== expectedProviderId)
    || !manifest.plan || manifest.plan.plan_id !== backupId
    || !safePlanId(manifest.plan.plan_id) || manifest.plan.provider_id !== manifest.provider_id
    || !Array.isArray(manifest.plan.declaration_authorities)
    || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
    || !manifest.backup_digests || typeof manifest.backup_digests !== 'object' || Array.isArray(manifest.backup_digests)
    || typeof manifest.recovery_descriptor_digest !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.recovery_descriptor_digest)
    || sha256(JSON.stringify(recoveryDescriptor(manifest))) !== manifest.recovery_descriptor_digest) {
    throw backupInvalid();
  }
  try {
    validatePlanAuthorities(manifest.plan);
  } catch {
    throw backupInvalid();
  }
  if (manifest.plan.expected_revision !== null && !/^[a-f0-9]{64}$/i.test(manifest.plan.expected_revision)) throw backupInvalid();
  if (manifest.plan.expected_revisions !== undefined) {
    if (!manifest.plan.expected_revisions || typeof manifest.plan.expected_revisions !== 'object' || Array.isArray(manifest.plan.expected_revisions)
      || !validRevision(manifest.plan.expected_revisions.profile) || !validRevision(manifest.plan.expected_revisions.settings)) throw backupInvalid();
  }
  if (!Array.isArray(manifest.plan.credential_refs) || manifest.plan.credential_refs.some((ref) => !ref || typeof ref !== 'object'
    || typeof ref.kind !== 'string' || typeof ref.name_or_handle !== 'string' || typeof ref.ownership !== 'string')) throw backupInvalid();
  const authorityKinds = new Set(manifest.plan.declaration_authorities.map((authority) => authority?.kind));
  for (const key of FILE_KEYS) {
    const entry = manifest.files[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.existed !== 'boolean' || typeof entry.managed !== 'boolean') {
      throw backupInvalid();
    }
    const expectedManaged = key === 'profile' ? authorityKinds.has('crew-profile') : true;
    if (entry.managed !== expectedManaged || (!entry.existed && manifest.backup_digests[key] !== undefined)) throw backupInvalid();
    if (key === 'config' && (!manifest.config_projection || typeof manifest.config_projection !== 'object'
      || Array.isArray(manifest.config_projection) || typeof manifest.config_revision !== 'string'
      || !Array.isArray(manifest.config_projection.present_fields)
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
    const expectedManaged = authorityKinds.has('harness-settings') || manifest.plan.was_harness_default === true;
    if (entry.managed !== expectedManaged || (!entry.existed && manifest.backup_digests.settings !== undefined)) throw backupInvalid();
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
  for (const key of ['profile', 'settings', 'config', 'lifecycle']) {
    const applied = manifest[`applied_${key}_revision`];
    const created = manifest[`created_${key}`];
    if (applied !== undefined && !/^[a-f0-9]{64}$/i.test(applied)) throw backupInvalid();
    if (created !== undefined && typeof created !== 'boolean') throw backupInvalid();
    const identity = manifest[`created_${key}_identity`];
    if (identity !== undefined && (!identity || typeof identity !== 'object' || typeof identity.dev !== 'string' || typeof identity.ino !== 'string')) throw backupInvalid();
    if (created === true && !identity) throw backupInvalid();
  }
  if (manifest.mutation_journal !== undefined && (typeof manifest.mutation_journal !== 'object' || Array.isArray(manifest.mutation_journal))) throw backupInvalid();
  if (manifest.phase_journal !== undefined && (typeof manifest.phase_journal !== 'object' || Array.isArray(manifest.phase_journal))) throw backupInvalid();
  if (manifest.ownership_witnesses !== undefined && (typeof manifest.ownership_witnesses !== 'object' || Array.isArray(manifest.ownership_witnesses))) throw backupInvalid();
  for (const key of ['profile', 'settings', 'config', 'lifecycle']) {
    const witnessName = manifest.ownership_witnesses?.[key];
    if (witnessName !== undefined) {
      if (!new RegExp(`^${key}\\.[0-9a-f-]{36}\\.ownership\\.witness$`, 'iu').test(witnessName)) throw backupInvalid();
      const witnessFile = join(root, witnessName);
      assertManagedPath(witnessFile, managedRoot);
      if (!fs.existsSync(witnessFile) || lstatSync(witnessFile).isSymbolicLink()) throw backupInvalid();
      const identity = manifest[`created_${key}_identity`];
      if (manifest[`created_${key}`] !== true || !identity) throw backupInvalid();
      try {
        const witnessIdentity = fileIdentity(witnessFile);
        if (!sameFileIdentity(witnessIdentity, identity)) throw backupInvalid();
      } catch (error) {
        if (error?.code === 'PROVIDER_DELETE_BACKUP_INVALID') throw error;
        throw backupInvalid();
      }
    } else if (manifest[`created_${key}`] === true) {
      throw backupInvalid();
    }
  }
  for (const [key, mutation] of Object.entries(manifest.mutation_journal ?? {})) {
    if (!['profile', 'settings', 'config', 'lifecycle'].includes(key) || !mutation || typeof mutation !== 'object'
      || !/^[a-f0-9]{64}$/i.test(mutation.next_revision) || typeof mutation.created !== 'boolean') throw backupInvalid();
    if (mutation.witness !== undefined) {
      if (typeof mutation.witness !== 'string') throw backupInvalid();
      assertManagedPath(mutation.witness, managedRoot);
      if (mutation.created === true && (!fs.existsSync(mutation.witness) || lstatSync(mutation.witness).isSymbolicLink())) throw backupInvalid();
    } else if (mutation.created === true) {
      throw backupInvalid();
    }
  }
  return true;
}

// Recovery discovery uses the same strict validator as an explicit reopen.
// A manifest that cannot be reopened safely is reported for manual repair and
// is never treated as an executable rollback transaction.
export function isRecoverableProviderDeleteBackup(manifest, options = {}) {
  try {
    validateBackupManifest(manifest, {
      root: options.root,
      fs: { existsSync, readFileSync, lstatSync },
      paths: options.paths ?? {},
      managedRoot: options.managedRoot,
      expectedProviderId: options.expectedProviderId ?? null,
    });
    return true;
  } catch {
    return false;
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
  settingsFile = null,
  configFile,
  lifecycleFile,
  backupDir,
  readConfig = null,
  writeConfig = (config, { managedRoot: writeRoot, replace = true } = {}) => defaultWriteConfig(configFile, config, writeRoot, replace),
  writeSettings = null,
  restart,
  runtimeIdProvider = null,
  existingBackupId = null,
  expectedProviderId = null,
  afterLockAcquired = null,
  afterOwnedReplacePublished = null,
  afterMutationJournaled = null,
  fs = { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync },
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
  const createWitnessPath = (key) => {
    if (!activeBackup) throw backupInvalid();
    const witness = join(activeBackup.root, `.${key}.${randomUUID()}.pending.witness`);
    assertManagedPath(witness, managedRoot);
    return witness;
  };
  const publishExclusiveFile = (file, content, token = randomUUID()) => {
    const stage = join(managedRoot, `.${basename(file)}.${token}.stage`);
    assertManagedPath(file, managedRoot);
    assertManagedPath(stage, managedRoot);
    try {
      fs.writeFileSync(stage, content, { flag: 'wx' });
      assertManagedPath(stage, managedRoot);
      linkSync(stage, file);
      assertManagedPath(file, managedRoot);
    } finally {
      try { fs.rmSync(stage, { force: true }); } catch {}
    }
  };

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
    try {
      assertManagedPath(lockPath, managedRoot);
      const ownerPath = lstatSync(lockPath).isDirectory() ? join(lockPath, 'owner.json') : lockPath;
      const owner = readJson(ownerPath, null);
      if (owner?.token !== lockOwnerToken) throw new Error('provider deletion lock ownership changed');
    } catch {
      lockOwned = false;
      lockPath = null;
      lockOwnerToken = null;
      throw Object.assign(new Error('provider deletion write lock is unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
    }
  };

  const recoverLock = async ({ force = false } = {}) => {
    const guardPath = join(backupDir, '.delete.reclaim.lock');
    const canonicalPath = join(backupDir, '.delete.lock');
    const recoveryPath = join(backupDir, '.delete.recovery.lock');
    const recoveryClaimPath = `${recoveryPath}.claim`;
    const alive = (owner) => {
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
      try { process.kill(owner.pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
    };
    const lockUnavailable = () => Object.assign(new Error('provider deletion lock metadata is unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
    const fsLstatSync = typeof fs.lstatSync === 'function' ? fs.lstatSync : lstatSync;
    const fsReadFileSync = typeof fs.readFileSync === 'function' ? fs.readFileSync : readFileSync;
    const fsReaddirSync = typeof fs.readdirSync === 'function' ? fs.readdirSync : readdirSync;
    const cleanup = (path) => { try { fs.rmSync(path, { recursive: true, force: true }); } catch {} };
    const inspectPath = (path) => {
      try { return { exists: true, stat: fsLstatSync(path) }; }
      catch (error) {
        if (error?.code === 'ENOENT') return { exists: false, stat: null };
        throw lockUnavailable();
      }
    };
    const readOwner = (path, knownStat = null) => {
      let stat = knownStat;
      if (!stat) {
        const inspected = inspectPath(path);
        if (!inspected.exists) return null;
        stat = inspected.stat;
      }
      if (stat.isSymbolicLink?.()) throw lockUnavailable();
      const ownerPath = stat.isDirectory() ? join(path, 'owner.json') : path;
      let raw;
      try { raw = fsReadFileSync(ownerPath, 'utf8'); }
      catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw lockUnavailable();
      }
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : { invalid: true };
      } catch {
        // Explicit offline recovery may reclaim recognized malformed owner
        // metadata, but it must never guess through an unreadable file.
        return { invalid: true };
      }
    };
    assertManagedPath(backupDir, managedRoot);
    for (const path of [guardPath, canonicalPath, recoveryPath, recoveryClaimPath]) assertManagedPath(path, managedRoot);
    const recoveryToken = randomUUID();
    let recoveryOwned = false;
    const recoveryOwner = () => ({ pid: process.pid, token: recoveryToken, created_at: new Date().toISOString() });
    const recoveryAcquire = () => {
      // A crashed reclaimer leaves a claim marker. Do not automatically steal
      // it: only an explicit operator force can clear a dead claim, which
      // keeps concurrent reclaimers from ABA-renaming a fresh recovery lock.
      if (inspectPath(recoveryClaimPath).exists) {
        const claim = readOwner(recoveryClaimPath);
        if (!force || alive(claim) === true) return false;
        const claimToken = claim?.token ?? null;
        const rereadClaim = readOwner(recoveryClaimPath);
        if (claimToken !== (rereadClaim?.token ?? null)) return false;
        cleanup(recoveryClaimPath);
        if (inspectPath(recoveryClaimPath).exists) return false;
      }
      try {
        publishExclusiveFile(recoveryPath, JSON.stringify(recoveryOwner()) + '\n', recoveryToken);
        recoveryOwned = true;
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') return false;
        const existing = readOwner(recoveryPath);
        if (existing && alive(existing) === true) return false;
        if (inspectPath(recoveryClaimPath).exists) return false;
        const claim = { pid: process.pid, token: recoveryToken, observed_token: existing?.token ?? null, created_at: new Date().toISOString() };
        try {
          publishExclusiveFile(recoveryClaimPath, JSON.stringify(claim) + '\n', recoveryToken);
        } catch (claimError) {
          if (claimError?.code === 'EEXIST') return false;
          throw claimError;
        }
        const reread = readOwner(recoveryPath);
        if ((existing?.token ?? null) !== (reread?.token ?? null)) {
          cleanup(recoveryClaimPath);
          return false;
        }
        const stalePath = `${recoveryPath}.${recoveryToken}.stale`;
        try { renameSync(recoveryPath, stalePath); }
        catch (renameError) {
          cleanup(recoveryClaimPath);
          if (renameError?.code === 'ENOENT' || renameError?.code === 'EEXIST') return false;
          throw lockUnavailable();
        }
        try {
          publishExclusiveFile(recoveryPath, JSON.stringify(recoveryOwner()) + '\n', recoveryToken);
          recoveryOwned = true;
          return true;
        } finally {
          cleanup(stalePath);
          cleanup(recoveryClaimPath);
        }
      }
    };
    if (!recoveryAcquire()) return { ok: false, code: 'PROVIDER_DELETE_BUSY' };
    try {
      const guardExists = inspectPath(guardPath).exists;
      let guardOwner = null;
      if (guardExists) {
        guardOwner = readOwner(guardPath);
        if (alive(guardOwner) === true) return { ok: false, code: 'PROVIDER_DELETE_BUSY' };
      }
      const candidates = [canonicalPath];
      try {
        for (const entry of fsReaddirSync(backupDir, { withFileTypes: true })) {
          if (/^\.delete\.lock\.[0-9a-f-]+\.(?:active|staging)$/iu.test(entry.name)) candidates.push(join(backupDir, entry.name));
        }
      } catch { return { ok: false, code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' }; }
      const uniqueCandidates = [...new Set(candidates)];
      const presentCandidates = [];
      for (const candidate of uniqueCandidates) {
        const inspected = inspectPath(candidate);
        if (!inspected.exists) continue;
        presentCandidates.push({ candidate, stat: inspected.stat, owner: readOwner(candidate, inspected.stat) });
      }
      if (presentCandidates.length === 0) {
        if (guardExists) cleanup(guardPath);
        return { ok: true, recovered: guardExists };
      }
      for (const { owner } of presentCandidates) if (alive(owner) === true) return { ok: false, code: 'PROVIDER_DELETE_BUSY' };
      for (const { candidate } of presentCandidates) cleanup(candidate);
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
    const recoveryPath = join(backupDir, '.delete.recovery.lock');
    const recoveryClaimPath = `${recoveryPath}.claim`;
    let guardOwned = false;
    let coordinationOwned = false;
    for (const path of [canonicalPath, activePath, stagingPath, retiredPath, reclaimGuardPath, recoveryPath, recoveryClaimPath]) assertManagedPath(path, managedRoot);
    try {
      if (existsSync(recoveryClaimPath)) throw Object.assign(new Error('provider delete recovery reclaim is active'), { code: 'PROVIDER_DELETE_BUSY' });
      publishExclusiveFile(recoveryPath, JSON.stringify({ pid: process.pid, token: ownerToken, created_at: new Date().toISOString() }) + '\n', ownerToken);
      coordinationOwned = true;
    } catch (error) {
      if (error?.code === 'EEXIST') throw Object.assign(new Error('provider delete recovery is active'), { code: 'PROVIDER_DELETE_BUSY' });
      throw Object.assign(new Error('provider delete recovery lock unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
    }
    try {
      publishExclusiveFile(reclaimGuardPath, JSON.stringify({ pid: process.pid, token: ownerToken, created_at: new Date().toISOString() }) + '\n', ownerToken);
      guardOwned = true;
    } catch (error) {
      if (coordinationOwned) {
        try { fs.rmSync(recoveryPath, { force: true }); } catch {}
        coordinationOwned = false;
      }
      if (error?.code === 'EEXIST') throw Object.assign(new Error('another provider deletion is reclaiming the lock'), { code: 'PROVIDER_DELETE_BUSY' });
      throw Object.assign(new Error('provider delete lock reclaim unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
    }
    const ownerIsAlive = (owner) => {
      if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return null;
      try { process.kill(owner.pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
    };
    const lockUnavailable = () => Object.assign(new Error('provider deletion lock metadata is unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
    const fsReaddirSync = typeof fs.readdirSync === 'function' ? fs.readdirSync : readdirSync;
    const fsLstatSync = typeof fs.lstatSync === 'function' ? fs.lstatSync : lstatSync;
    const fsReadFileSync = typeof fs.readFileSync === 'function' ? fs.readFileSync : readFileSync;
    const lockCandidates = () => {
      try {
        return fsReaddirSync(backupDir, { withFileTypes: true })
          .filter((entry) => entry.name === '.delete.lock' || /^\.delete\.lock\.[0-9a-f-]+\.(?:active|staging)$/iu.test(entry.name))
          .map((entry) => join(backupDir, entry.name));
      } catch { throw lockUnavailable(); }
    };
    const ownerRecord = () => JSON.stringify({
        pid: process.pid,
        token: ownerToken,
        ...(typeof runtimeIdProvider === 'function' ? { runtime_id: runtimeIdProvider() } : {}),
        created_at: new Date().toISOString(),
      }) + '\n';
    const readOwner = (path, knownStat = null) => {
      let stat = knownStat;
      if (!stat) {
        try { stat = fsLstatSync(path); }
        catch (error) {
          if (error?.code === 'ENOENT') return null;
          throw lockUnavailable();
        }
      }
      if (stat.isSymbolicLink?.()) throw lockUnavailable();
      const ownerPath = stat.isDirectory() ? join(path, 'owner.json') : path;
      let raw;
      try { raw = fsReadFileSync(ownerPath, 'utf8'); }
      catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw lockUnavailable();
      }
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : { invalid: true };
      }
      catch {
        // A present but malformed owner record is not an orphan. Normal
        // acquisition must fail closed; only explicit offline recovery may
        // reclaim malformed metadata.
        return { invalid: true };
      }
    };
    const inspectCandidate = (path) => {
      let stat;
      try { stat = fsLstatSync(path); }
      catch (error) {
        if (error?.code === 'ENOENT') return { exists: false, owner: null };
        throw lockUnavailable();
      }
      return { exists: true, owner: readOwner(path, stat) };
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
      try {
        // Reopen transactions are inspected before lock acquisition so
        // malformed input can fail fast. Refresh once ownership is acquired
        // so a stale in-memory manifest cannot overwrite newer recovery state.
        refreshActiveBackup();
        if (typeof afterLockAcquired === 'function') afterLockAcquired(activeBackup?.manifest ?? null);
      } catch (error) {
        cleanup(path);
        lockOwned = false;
        lockPath = null;
        lockOwnerToken = null;
        throw error;
      }
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
            if (error?.code === 'PROVIDER_DELETE_RECOVERY_PENDING') throw error;
            throw Object.assign(new Error('provider deletion lock unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
          }
        }
        const uniqueCandidates = [...new Set(candidates)];
        // Inspect every residue before reclaiming any one of them. A stale
        // candidate may appear before a live token-specific owner in
        // directory order; reclaiming it first would otherwise admit a second
        // owner while the live candidate remains untouched.
        for (const candidate of uniqueCandidates) {
          const inspected = inspectCandidate(candidate);
          if (!inspected.exists) continue;
          const owner = inspected.owner;
          if (owner && ownerIsAlive(owner) !== false) {
            throw Object.assign(new Error('another provider deletion is active'), { code: 'PROVIDER_DELETE_BUSY' });
          }
        }
        let raced = false;
        for (const candidate of uniqueCandidates) {
          const inspected = inspectCandidate(candidate);
          if (!inspected.exists) continue;
          const owner = inspected.owner;
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
            if (error?.code === 'PROVIDER_DELETE_RECOVERY_PENDING') throw error;
            throw Object.assign(new Error('provider deletion lock reclaim unavailable'), { code: 'PROVIDER_DELETE_LOCK_UNAVAILABLE' });
          }
        }
        if (!raced) continue;
      }
    } catch (error) {
      cleanup(stagingPath);
      throw error;
    } finally {
      if (guardOwned) {
        let owner = null;
        try { owner = readJson(reclaimGuardPath, null); } catch {}
        if (owner?.token === ownerToken) cleanup(reclaimGuardPath);
      }
      if (coordinationOwned) {
        let owner = null;
        try { owner = readJson(recoveryPath, null); } catch {}
        if (owner?.token === ownerToken) cleanup(recoveryPath);
      }
    }
  };

  if (existingBackupId !== null) {
    const backupId = safePlanId(existingBackupId);
    if (!backupId) throw Object.assign(new Error('provider backup id is invalid'), { code: 'PROVIDER_DELETE_PLAN_INVALID' });
    const root = join(backupDir, backupId);
    assertManagedPath(root, managedRoot);
    const manifest = readManagedJsonSnapshot(join(root, 'manifest.json'), managedRoot, fs);
    try {
      validateBackupManifest(manifest, { root, fs, paths, managedRoot, expectedProviderId });
    } catch (error) {
      if (error?.code === 'PROVIDER_DELETE_BACKUP_INVALID') throw error;
      throw backupInvalid();
    }
    activeBackup = { root, manifest };
  }

  const refreshActiveBackup = () => {
    if (!activeBackup) return;
    const manifestFile = join(activeBackup.root, 'manifest.json');
    const latest = readManagedJsonSnapshot(manifestFile, managedRoot, fs);
    validateBackupManifest(latest, { root: activeBackup.root, fs, paths, managedRoot, expectedProviderId });
    activeBackup = { root: activeBackup.root, manifest: latest };
  };

  const persistManifest = () => {
    if (!activeBackup) return;
    ensureMutationLock();
    activeBackup.manifest.recovery_descriptor_digest = sha256(JSON.stringify(recoveryDescriptor(activeBackup.manifest)));
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

  const assertRecoveryDescriptor = () => {
    const digest = activeBackup?.manifest?.recovery_descriptor_digest;
    if (!/^[a-f0-9]{64}$/i.test(digest) || sha256(JSON.stringify(recoveryDescriptor(activeBackup.manifest))) !== digest) throw backupInvalid();
  };

  const prepareMutation = (key, nextRevision, details = {}) => {
    if (!activeBackup || typeof nextRevision !== 'string') return;
    const created = typeof details.created === 'boolean'
      ? details.created
      : activeBackup.manifest.files?.[key]?.existed === false;
    let prepublished = false;
    if (created && typeof details.witness === 'string' && details.witness_content !== undefined && !existsSync(details.witness)) {
      writeFileSync(details.witness, details.witness_content, { flag: 'wx' });
      prepublished = true;
    }
    activeBackup.manifest.mutation_journal ??= {};
    activeBackup.manifest.mutation_journal[key] = {
      next_revision: nextRevision,
      created,
      ...(typeof details.witness === 'string' ? { witness: details.witness } : {}),
      prepared_at: new Date().toISOString(),
    };
    try { persistManifest(); }
    catch (error) {
      if (prepublished) { try { rmSync(details.witness, { force: true }); } catch {} }
      throw error;
    }
    const journalCallback = typeof details.after_journaled === 'function' ? details.after_journaled : afterMutationJournaled;
    if (typeof journalCallback === 'function') journalCallback(key);
  };

  const durableWitnessPath = (key) => {
    if (!activeBackup) throw backupInvalid();
    const witness = join(activeBackup.root, `${key}.${randomUUID()}.ownership.witness`);
    assertManagedPath(witness, managedRoot);
    return witness;
  };

  const retainOwnershipWitness = (key, source) => {
    const witness = durableWitnessPath(key);
    const previous = activeBackup.manifest.ownership_witnesses?.[key];
    try {
      linkSync(source, witness);
      const sourceIdentity = fileIdentity(source);
      const witnessIdentity = fileIdentity(witness);
      if (!sameFileIdentity(sourceIdentity, witnessIdentity)) {
        throw Object.assign(new Error('transaction-created file ownership witness changed'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
      }
      activeBackup.manifest.ownership_witnesses ??= {};
      activeBackup.manifest.ownership_witnesses[key] = basename(witness);
      return { identity: witnessIdentity, previous };
    } catch (error) {
      try { rmSync(witness, { force: true }); } catch {}
      throw error;
    }
  };

  const commitMutation = (key, nextRevision) => {
    if (!activeBackup || typeof nextRevision !== 'string') return;
    const pending = activeBackup.manifest.mutation_journal?.[key];
    let previousWitness = null;
    if (pending?.created === true) {
      const target = key === 'settings' ? settingsFile : paths[key];
      const witness = pending.witness;
      if (typeof target !== 'string' || typeof witness !== 'string' || !existsSync(target) || !existsSync(witness)) {
        throw Object.assign(new Error('transaction-created file ownership witness is missing'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
      }
      let targetIdentity;
      let witnessIdentity;
      try {
        targetIdentity = fileIdentity(target);
        witnessIdentity = fileIdentity(witness);
      } catch {
        throw Object.assign(new Error('transaction-created file identity is unavailable'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
      }
      if (!sameFileIdentity(targetIdentity, witnessIdentity)) {
        throw Object.assign(new Error('transaction-created file ownership changed'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
      }
      activeBackup.manifest[`created_${key}`] = true;
      const retained = retainOwnershipWitness(key, witness);
      activeBackup.manifest[`created_${key}_identity`] = retained.identity;
      previousWitness = retained.previous;
    } else if (activeBackup.manifest[`created_${key}`] === true) {
      throw Object.assign(new Error('transaction-created file replacement lacks a durable witness'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
    }
    activeBackup.manifest[`applied_${key}_revision`] = nextRevision;
    const witness = pending?.witness;
    if (activeBackup.manifest.mutation_journal) delete activeBackup.manifest.mutation_journal[key];
    persistManifest();
    if (typeof previousWitness === 'string') {
      try { rmSync(join(activeBackup.root, previousWitness), { force: true }); } catch {}
    }
    if (typeof witness === 'string') {
      try { rmSync(witness, { force: true }); } catch {}
    }
  };

  const setPhase = (phase, details = {}) => {
    if (!activeBackup) return;
    activeBackup.manifest.phase_journal = { phase, ...details, updated_at: new Date().toISOString() };
    persistManifest();
  };

  // Every managed writer runs while the transaction lock is held and verifies
  // both the target boundary and the resulting revision. Custom writers are
  // accepted for the Hub's in-memory adapters, but cannot bypass these checks.
  const writeManagedConfig = async (config, expectedRevision, witness = null) => {
    ensureMutationLock();
    assertManagedPath(configFile, managedRoot);
    if (activeBackup?.manifest?.files?.config?.existed === false && fs.existsSync(configFile)) {
      throw Object.assign(new Error('provider config was created before the transaction write'), { code: 'PROVIDER_CONFIG_CHANGED' });
    }
    if (typeof expectedRevision === 'string') {
      const current = await readConfigFn();
      if (sha256(JSON.stringify(current)) !== expectedRevision) {
        throw Object.assign(new Error('provider config changed during commit'), { code: 'PROVIDER_CONFIG_CHANGED' });
      }
    }
    const createOnly = activeBackup?.manifest?.files?.config?.existed === false;
    try {
      if (createOnly) atomicCreateWithWitness(configFile, JSON.stringify(config, null, 2) + '\n', managedRoot, witness ?? createWitnessPath('config'));
      else await writeConfig(config, { expectedRevision, managedRoot, replace: true });
    } catch (error) {
      if (createOnly && error?.code === 'EEXIST') throw Object.assign(new Error('provider config was created before the transaction write'), { code: 'PROVIDER_CONFIG_CHANGED' });
      throw error;
    }
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
      ownership_witnesses: {},
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
      if (key === 'profile' && authorityKinds.has('crew-profile') && !existed) throw Object.assign(new Error('provider profile authority is missing'), { code: 'PROVIDER_DELETE_SOURCE_UNRESOLVED' });
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
      if ((authorityKinds.has('harness-settings') || managesHarnessDefault) && !existed) throw Object.assign(new Error('provider settings authority is missing'), { code: 'PROVIDER_DELETE_SOURCE_UNRESOLVED' });
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
    manifest.recovery_descriptor_digest = sha256(JSON.stringify(recoveryDescriptor(manifest)));
    activeBackup = { root, manifest };
    persistManifest();
    return { ok: true, backup_id: planId };
  };

  const markTombstone = async (providerId) => {
    if (!validProviderId(providerId)) throw Object.assign(new Error('provider id is invalid'), { code: 'PROVIDER_NOT_FOUND' });
    assertManagedPath(lifecycleFile, managedRoot);
    if (activeBackup?.manifest?.files?.lifecycle?.existed === false && fs.existsSync(lifecycleFile)) {
      throw Object.assign(new Error('provider lifecycle was created before the transaction write'), { code: 'PROVIDER_LIFECYCLE_CHANGED' });
    }
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
    const createOnly = activeBackup?.manifest?.files?.lifecycle?.existed === false;
    const lifecycleWitness = createOnly ? createWitnessPath('lifecycle') : null;
    const lifecycleContent = JSON.stringify(marked, null, 2) + '\n';
    prepareMutation('lifecycle', nextRevision, lifecycleWitness ? {
      witness: lifecycleWitness,
      witness_content: lifecycleContent,
    } : {});
    try {
      if (createOnly) atomicCreateWithWitness(lifecycleFile, lifecycleContent, managedRoot, lifecycleWitness);
      else atomicWrite(lifecycleFile, JSON.stringify(marked, null, 2) + '\n', managedRoot, { replace: true });
    } catch (error) {
      if (createOnly && error?.code === 'EEXIST') throw Object.assign(new Error('provider lifecycle was created before the transaction write'), { code: 'PROVIDER_LIFECYCLE_CHANGED' });
      throw error;
    }
    commitMutation('lifecycle', nextRevision);
    setPhase('TOMBSTONE_APPLIED');
  };

  const scrubReferences = async (plan) => {
    assertManagedPath(configFile, managedRoot);
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
    const configCreateOnly = activeBackup?.manifest?.files?.config?.existed === false;
    const configWitness = configCreateOnly ? createWitnessPath('config') : null;
    const configContent = JSON.stringify(scrubbed.config, null, 2) + '\n';
    prepareMutation('config', configRevision, configWitness ? {
      witness: configWitness,
      witness_content: configContent,
    } : {});
    await writeManagedConfig(scrubbed.config, activeBackup?.manifest?.config_revision, configWitness);
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
    assertManagedPath(configFile, managedRoot);
    assertManagedPath(lifecycleFile, managedRoot);
    assertManagedPath(profileFile, managedRoot);
    if (settingsFile) assertManagedPath(settingsFile, managedRoot);
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
    assertManagedPath(configFile, managedRoot);
    assertManagedPath(profileFile, managedRoot);
    assertManagedPath(lifecycleFile, managedRoot);
    if (settingsFile) assertManagedPath(settingsFile, managedRoot);
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
    assertRecoveryDescriptor();
    assertManagedPath(configFile, managedRoot);
    assertManagedPath(profileFile, managedRoot);
    assertManagedPath(lifecycleFile, managedRoot);
    if (settingsFile) assertManagedPath(settingsFile, managedRoot);
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
      if (!fs.existsSync(target)) {
        const orphanWitness = activeBackup.manifest.mutation_journal?.[key]?.witness;
        if (typeof orphanWitness === 'string') { try { rmSync(orphanWitness, { force: true }); } catch {} }
        return;
      }
      // A pending journal proves intent, not ownership: a crash can happen
      // before the exclusive-create rename. Only the durable commit marker
      // authorizes deleting an originally absent file during compensation.
      let created = activeBackup.manifest[`created_${key}`] === true;
      if (created) {
        const identity = activeBackup.manifest[`created_${key}_identity`];
        const witnessName = activeBackup.manifest.ownership_witnesses?.[key];
        const witnessFile = typeof witnessName === 'string' ? join(activeBackup.root, witnessName) : null;
        if (!identity || !fs.existsSync(target) || !witnessFile || !fs.existsSync(witnessFile)) created = false;
        else {
          try {
            const currentIdentity = fileIdentity(target);
            const witnessIdentity = fileIdentity(witnessFile);
            created = sameFileIdentity(currentIdentity, witnessIdentity) && sameFileIdentity(witnessIdentity, identity);
          } catch { created = false; }
        }
      }
      const pending = activeBackup.manifest.mutation_journal?.[key];
      let pendingOwned = false;
      if (!created && pending?.created === true && typeof pending.witness === 'string' && fs.existsSync(pending.witness) && fs.existsSync(target)) {
        try {
          created = sameFileIdentity(fileIdentity(pending.witness), fileIdentity(target));
          pendingOwned = created;
        } catch { created = false; }
      }
      const expected = pendingOwned
        ? pending.next_revision
        : activeBackup.manifest[`applied_${key}_revision`] ?? pending?.next_revision;
      if (typeof expected !== 'string' || !created) throw Object.assign(new Error('managed provider state changed during rollback'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
      let current;
      if (key === 'config') current = sha256(JSON.stringify(await readConfigFn()));
      else if (key === 'lifecycle') current = sha256(JSON.stringify(normalizeProviderLifecycleState(readJson(lifecycleFile, {}))));
      else current = sha256(fs.readFileSync(target));
      if (current !== expected) throw Object.assign(new Error('managed provider state changed during rollback'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
      assertManagedPath(target, managedRoot);
      fs.rmSync(target, { force: true });
      if (pending?.witness) { try { fs.rmSync(pending.witness, { force: true }); } catch {} }
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

  const quarantine = async (entryName) => {
    const safeName = safeRecoveryEntryName(entryName);
    if (!safeName) throw Object.assign(new Error('provider recovery entry name is invalid'), { code: 'PROVIDER_DELETE_PLAN_INVALID' });
    await acquireLock();
    try {
      const source = join(backupDir, safeName);
      const quarantineRoot = join(backupDir, '.quarantine');
      assertManagedEntryPath(source, managedRoot);
      assertManagedPath(quarantineRoot, managedRoot);
      try { lstatSync(source); }
      catch {
        throw Object.assign(new Error('provider recovery transaction was not found'), { code: 'PROVIDER_DELETE_RECOVERY_NOT_FOUND' });
      }
      if (existsSync(quarantineRoot) && !lstatSync(quarantineRoot).isDirectory()) {
        throw Object.assign(new Error('provider recovery quarantine path is unsafe'), { code: 'PROVIDER_DELETE_UNSAFE_PATH' });
      }
      mkdirSync(quarantineRoot, { recursive: true });
      assertManagedPath(quarantineRoot, managedRoot);
      const target = join(quarantineRoot, `${sha256(safeName).slice(0, 32)}.${Date.now()}.${randomUUID().slice(0, 8)}`);
      assertManagedPath(target, managedRoot);
      renameSync(source, target);
      return { ok: true, storage_id: safeName, state: 'QUARANTINED' };
    } finally {
      await release();
    }
  };

  const verifyRollback = async (plan) => {
    const authorityKinds = authorityKindsFor(plan);
    assertManagedPath(configFile, managedRoot);
    assertManagedPath(profileFile, managedRoot);
    assertManagedPath(lifecycleFile, managedRoot);
    if (settingsFile) assertManagedPath(settingsFile, managedRoot);
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
    assertManagedPath(configFile, managedRoot);
    assertManagedPath(profileFile, managedRoot);
    assertManagedPath(lifecycleFile, managedRoot);
    if (settingsFile) assertManagedPath(settingsFile, managedRoot);
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
    const lifecycleOriginallyAbsent = activeBackup?.manifest?.files?.lifecycle?.existed === false;
    let lifecycleOwned = false;
    if (activeBackup?.manifest?.created_lifecycle === true && fs.existsSync(lifecycleFile)) {
      const recordedIdentity = activeBackup.manifest.created_lifecycle_identity;
      try {
        const currentIdentity = fileIdentity(lifecycleFile);
          lifecycleOwned = sameFileIdentity(currentIdentity, recordedIdentity);
      } catch { lifecycleOwned = false; }
      if (!lifecycleOwned) {
        throw Object.assign(new Error('provider lifecycle ownership changed during audit'), { code: 'PROVIDER_LIFECYCLE_CHANGED' });
      }
    }
    if (lifecycleOriginallyAbsent && fs.existsSync(lifecycleFile) && !lifecycleOwned) {
      throw Object.assign(new Error('provider lifecycle was created outside the transaction'), { code: 'PROVIDER_LIFECYCLE_CHANGED' });
    }
    const lifecycleCreateOnly = lifecycleOriginallyAbsent && !lifecycleOwned;
    const lifecycleOwnershipHandoff = lifecycleOriginallyAbsent && lifecycleOwned;
    const lifecycleWitness = lifecycleCreateOnly || lifecycleOwnershipHandoff ? createWitnessPath('lifecycle') : null;
    const lifecycleContent = JSON.stringify(next, null, 2) + '\n';
    prepareMutation('lifecycle', nextRevision, {
      created: lifecycleCreateOnly || lifecycleOwnershipHandoff,
      ...(lifecycleWitness ? { witness: lifecycleWitness } : {}),
      ...(lifecycleWitness ? { witness_content: lifecycleContent } : {}),
      ...(typeof afterMutationJournaled === 'function' ? { after_journaled: afterMutationJournaled } : {}),
    });
    if (lifecycleCreateOnly) atomicCreateWithWitness(lifecycleFile, lifecycleContent, managedRoot, lifecycleWitness);
    else if (lifecycleOwnershipHandoff) {
      atomicReplaceWithWitness(lifecycleFile, lifecycleContent, managedRoot, lifecycleWitness);
      if (typeof afterOwnedReplacePublished === 'function') afterOwnedReplacePublished('lifecycle', lifecycleFile, lifecycleWitness);
    }
    else atomicWrite(lifecycleFile, JSON.stringify(next, null, 2) + '\n', managedRoot);
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
    quarantine,
    rollback,
    release,
  };
}
