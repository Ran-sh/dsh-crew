// Filesystem adapter for the explicit provider-layer migration transaction.
// It stores only safe provider metadata and source revisions; credential values
// are never parsed, copied, or persisted in migration snapshots.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path';
import { addProviderDeclaration, hasInlineProviderCredentials as hasInlineProfileCredentials, readProviderDeclarations, readProviderMaterialization, removeProviderDeclarations } from './provider-profile-store.mjs';
import { addProviderSettings, hasInlineProviderCredentials as hasInlineSettingsCredentials, readProviderSettingsDeclarations, readProviderSettingsMaterialization, removeProviderSettings } from './provider-settings-store.mjs';
import { classifyCredentialReference } from './credential-reference.mjs';
import { acquireProviderStoreLock, recoverProviderStoreLock } from './provider-store-lock.mjs';

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function safeId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : null; }
function safeValue(value, max = 2048) { return typeof value === 'string' && value.trim() && value.length <= max && !/[\r\n]/u.test(value) ? value.trim() : null; }
function safeTimestamp(value) { return safeValue(value, 128) && Number.isFinite(Date.parse(value)); }
function safeMaterialization(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider) || !safeId(provider.id)) return null;
  const allowedProviderKeys = new Set(['id', 'display_name', 'credential_ref', 'api', 'base_url', 'models', 'source_file']);
  if (Object.keys(provider).some((key) => !allowedProviderKeys.has(key))) return null;
  const credential = provider.credential_ref ? classifyCredentialReference(provider.credential_ref, { kind: 'env' }).value : null;
  if (provider.credential_ref && !credential) return null;
  const api = safeValue(provider.api, 128);
  if (api && (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(api) || /^(?:sk|pk|rk|token|secret)[_-]/iu.test(api))) return null;
  let baseUrl = safeValue(provider.base_url);
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || /[?#]/u.test(baseUrl)) return null;
    } catch { return null; }
  }
  const models = (Array.isArray(provider.models) ? provider.models : []).map((model) => {
    if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
    const allowedModelKeys = new Set(['id', 'name', 'context_window', 'max_tokens', 'input', 'reasoning_efforts', 'compat']);
    if (Object.keys(model).some((key) => !allowedModelKeys.has(key))) return null;
    return {
      id: safeValue(model?.id, 256),
      ...(safeValue(model?.name, 256) ? { name: safeValue(model.name, 256) } : {}),
      ...(Number.isSafeInteger(model?.context_window) && model.context_window > 0 ? { context_window: model.context_window } : {}),
      ...(Number.isSafeInteger(model?.max_tokens) && model.max_tokens > 0 ? { max_tokens: model.max_tokens } : {}),
      ...(Array.isArray(model?.input) && model.input.every((value) => value === 'text' || value === 'image') ? { input: [...new Set(model.input)] } : {}),
      ...(model?.reasoning_efforts && typeof model.reasoning_efforts === 'object' && !Array.isArray(model.reasoning_efforts)
        ? { reasoning_efforts: Object.fromEntries(Object.entries(model.reasoning_efforts).filter(([key, value]) => /^[A-Za-z][A-Za-z0-9_-]*$/u.test(key) && (value === null || safeValue(value, 256)))) } : {}),
      ...(model?.compat && typeof model.compat === 'object' && !Array.isArray(model.compat) && Object.keys(model.compat).length === 0 ? { compat: {} } : {}),
    };
  });
  if (models.some((model) => !model?.id)) return null;
  return {
    id: provider.id,
    display_name: safeValue(provider.display_name, 256) ?? provider.id,
    ...(credential ? { credential_ref: credential } : {}),
    ...(api ? { api } : {}),
    ...(baseUrl ? { base_url: baseUrl } : {}),
    models: models.slice(0, 256),
  };
}

function onlyKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

function sameProviderSemantics(left, right) {
  return JSON.stringify(safeMaterialization(left)) === JSON.stringify(safeMaterialization(right));
}
function canonicalMaterialization(value) {
  const safe = safeMaterialization(value);
  return safe && JSON.stringify(safe) === JSON.stringify(value) ? safe : null;
}
function safePlan(plan) {
  if (!plan || !safeId(plan.provider_id) || !safeId(plan.plan_id) || !['promote-existing-user', 'materialize-user'].includes(plan.action)) throw Object.assign(new Error('provider migration plan is invalid'), { code: 'PROVIDER_MIGRATION_PLAN_INVALID' });
  const expected = plan.expected_revisions && typeof plan.expected_revisions === 'object' ? plan.expected_revisions : {};
  if (!/^[a-f0-9]{64}$/u.test(expected.profile ?? '')) throw Object.assign(new Error('provider migration profile revision is required'), { code: 'PROVIDER_MIGRATION_PLAN_INVALID' });
  if (expected.settings !== null && !/^[a-f0-9]{64}$/u.test(expected.settings ?? '')) throw Object.assign(new Error('provider migration settings revision is invalid'), { code: 'PROVIDER_MIGRATION_PLAN_INVALID' });
  if (plan.action === 'promote-existing-user' && !/^[a-f0-9]{64}$/u.test(expected.settings ?? '')) throw Object.assign(new Error('provider migration settings revision is required'), { code: 'PROVIDER_MIGRATION_PLAN_INVALID' });
  const revisions = {
    profile: expected.profile,
    settings: expected.settings ?? null,
  };
  const materialization = safeMaterialization(plan.materialization?.provider);
  if (!materialization) throw Object.assign(new Error('provider materialization is invalid'), { code: 'PROVIDER_MATERIALIZATION_INVALID' });
  const userMaterializationBefore = plan.user_materialization_before === undefined
    ? null
    : safeMaterialization(plan.user_materialization_before);
  if (plan.user_materialization_before !== undefined && !userMaterializationBefore) {
    throw Object.assign(new Error('provider user-layer baseline is invalid'), { code: 'PROVIDER_MIGRATION_PLAN_INVALID' });
  }
  if (plan.action === 'promote-existing-user' && !userMaterializationBefore) {
    throw Object.assign(new Error('provider user-layer baseline is required'), { code: 'PROVIDER_MIGRATION_PLAN_INVALID' });
  }
  const routingReferences = Array.isArray(plan.routing_references)
    ? plan.routing_references.map((entry) => ({ provider: plan.provider_id, model: safeValue(entry?.model, 256) })).filter((entry) => entry.model).slice(0, 256)
    : [];
  if (Array.isArray(plan.routing_references) && routingReferences.length !== plan.routing_references.length) {
    throw Object.assign(new Error('provider migration routing references are invalid'), { code: 'PROVIDER_MIGRATION_PLAN_INVALID' });
  }
  return {
    schema_version: 1,
    kind: 'provider-layer-migration',
    plan_id: plan.plan_id,
    provider_id: plan.provider_id,
    action: plan.action,
    expected_revisions: revisions,
    materialization: { provider: materialization },
    ...(userMaterializationBefore ? { user_materialization_before: userMaterializationBefore } : {}),
    ...(routingReferences.length > 0 ? { routing_references: routingReferences } : {}),
    ...(plan.harness_default_before && typeof plan.harness_default_before === 'object' && safeId(plan.harness_default_before.provider) && safeValue(plan.harness_default_before.model, 256)
      ? { harness_default_before: { provider: plan.harness_default_before.provider, model: safeValue(plan.harness_default_before.model, 256) } } : {}),
    ...(safeValue(plan.runtime_id_before, 128) ? { runtime_id_before: safeValue(plan.runtime_id_before, 128) } : {}),
  };
}

function assertManagedPath(file, root) {
  const resolvedRoot = resolvePath(root);
  const resolved = resolvePath(file);
  try {
    if (lstatSync(resolvedRoot).isSymbolicLink()) throw Object.assign(new Error('provider migration root uses a link'), { code: 'PROVIDER_MIGRATION_UNSAFE_PATH' });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || rel === '..' || /^[A-Za-z]:/u.test(rel)) {
    throw Object.assign(new Error('provider migration path escapes managed root'), { code: 'PROVIDER_MIGRATION_UNSAFE_PATH' });
  }
  let cursor = resolvedRoot;
  for (const segment of rel.split(/[\\/]/u).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw Object.assign(new Error('provider migration path uses a link'), { code: 'PROVIDER_MIGRATION_UNSAFE_PATH' });
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

function atomicReplace(file, content, root) {
  assertManagedPath(file, root);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  assertManagedPath(temp, root);
  writeFileSync(temp, content, 'utf8');
  try {
    renameSync(temp, file);
  } catch (error) {
    throw Object.assign(new Error('provider migration atomic replace failed'), { code: 'PROVIDER_MIGRATION_REPLACE_FAILED', cause: error });
  } finally { rmSync(temp, { force: true }); }
}

function readText(file) {
  try { return existsSync(file) ? readFileSync(file, 'utf8') : null; } catch (error) {
    throw Object.assign(new Error('provider migration source is unavailable'), { code: 'PROVIDER_MIGRATION_SOURCE_UNAVAILABLE', cause: error });
  }
}

function revision(source) { return source === null ? null : sha256(source); }
function fileIdentity(file) {
  const stat = lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error('provider migration file identity is unsafe'), { code: 'PROVIDER_MIGRATION_UNSAFE_PATH' });
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size) || 0, mtimeMs: Number(stat.mtimeMs) || 0 };
}
function sameFileIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
function validFileIdentity(value) {
  return value && typeof value === 'object' && typeof value.dev === 'string' && /^\d+$/u.test(value.dev)
    && typeof value.ino === 'string' && /^\d+$/u.test(value.ino)
    && Number.isFinite(value.size) && Number.isFinite(value.mtimeMs);
}
function validWitnessPath(root, value) {
  if (typeof value !== 'string') return false;
  const relativePath = relative(resolvePath(root), resolvePath(value));
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || /^[A-Za-z]:/u.test(relativePath)) return false;
  if (relativePath.includes('\\') || relativePath.includes('/') || !/^settings\.[0-9a-f-]{36}\.ownership\.witness$/iu.test(basename(value))) return false;
  return true;
}
function validWitness(root, value) {
  if (!validWitnessPath(root, value)) return false;
  try { const stat = lstatSync(value); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
}

function publishHardlink(source, target, managedRoot) {
  assertManagedPath(source, managedRoot);
  assertManagedPath(dirname(source), managedRoot);
  assertManagedPath(target, managedRoot);
  assertManagedPath(dirname(target), managedRoot);
  linkSync(source, target);
  assertManagedPath(target, managedRoot);
}

function manifestDigest(manifest) {
  const { checksum: _checksum, ...withoutChecksum } = manifest ?? {};
  return sha256(JSON.stringify(withoutChecksum));
}

function validMigrationManifest(root, manifest) {
  if (!manifest || manifest.schema_version !== 1 || manifest.kind !== 'provider-layer-migration' || !safeId(manifest.plan_id) || !safeId(manifest.provider_id)) return false;
  if (!onlyKeys(manifest, ['schema_version', 'kind', 'plan_id', 'provider_id', 'plan', 'phase', 'files', 'applied_revisions', 'rollback_revisions', 'mutation_journal', 'created_at', 'created_settings_identity', 'created_settings_witness', 'checksum'])) return false;
  if (!['PREPARED', 'USER_MATERIALIZED', 'BASE_REMOVED', 'RESTART_PENDING', 'ROLLBACK_APPLIED', 'ROLLBACK_RESTART_PENDING', 'ROLLBACK_APPLYING', 'VERIFIED', 'ROLLED_BACK'].includes(manifest.phase)) return false;
  try { if (!lstatSync(root).isDirectory()) return false; } catch { return false; }
  if (!manifest.plan || !onlyKeys(manifest.plan, ['schema_version', 'kind', 'plan_id', 'provider_id', 'action', 'expected_revisions', 'materialization', 'user_materialization_before', 'harness_default_before', 'runtime_id_before', 'runtime_id_before_restart', 'rollback_runtime_id_before', 'routing_references'])
    || manifest.plan.schema_version !== 1 || manifest.plan.kind !== 'provider-layer-migration'
    || manifest.plan.plan_id !== manifest.plan_id || manifest.plan.provider_id !== manifest.provider_id || !['promote-existing-user', 'materialize-user'].includes(manifest.plan.action)
    || !onlyKeys(manifest.plan.materialization, ['provider']) || !canonicalMaterialization(manifest.plan.materialization?.provider)
    || (manifest.plan.action === 'promote-existing-user' && !canonicalMaterialization(manifest.plan.user_materialization_before))
    || (manifest.plan.user_materialization_before !== undefined && !canonicalMaterialization(manifest.plan.user_materialization_before))) return false;
  const expected = manifest.plan.expected_revisions;
  if (!onlyKeys(expected, ['profile', 'settings']) || !/^[a-f0-9]{64}$/u.test(expected.profile ?? '') || (expected.settings !== null && !/^[a-f0-9]{64}$/u.test(expected.settings ?? ''))) return false;
  if (manifest.plan.harness_default_before !== undefined && (!onlyKeys(manifest.plan.harness_default_before, ['provider', 'model']) || !safeId(manifest.plan.harness_default_before.provider) || !safeValue(manifest.plan.harness_default_before.model, 256))) return false;
  if (manifest.plan.runtime_id_before !== undefined && !safeValue(manifest.plan.runtime_id_before, 128)) return false;
  if (manifest.plan.runtime_id_before_restart !== undefined && !safeValue(manifest.plan.runtime_id_before_restart, 128)) return false;
  if (manifest.plan.rollback_runtime_id_before !== undefined && !safeValue(manifest.plan.rollback_runtime_id_before, 128)) return false;
  if (manifest.plan.routing_references !== undefined && (!Array.isArray(manifest.plan.routing_references) || manifest.plan.routing_references.length > 256 || manifest.plan.routing_references.some((entry) => !onlyKeys(entry, ['provider', 'model']) || entry.provider !== manifest.provider_id || !safeValue(entry.model, 256)))) return false;
  if (!onlyKeys(manifest.mutation_journal, ['profile', 'settings'])) return false;
  if (['VERIFIED', 'ROLLED_BACK'].includes(manifest.phase) && Object.keys(manifest.mutation_journal).length > 0) return false;
  if (!manifest.applied_revisions || typeof manifest.applied_revisions !== 'object' || Array.isArray(manifest.applied_revisions)
    || Object.keys(manifest.applied_revisions).some((key) => !['profile', 'settings'].includes(key))
    || Object.values(manifest.applied_revisions).some((value) => !/^[a-f0-9]{64}$/u.test(value ?? ''))) return false;
  if (manifest.rollback_revisions !== undefined && (!manifest.rollback_revisions || typeof manifest.rollback_revisions !== 'object' || Array.isArray(manifest.rollback_revisions)
    || Object.keys(manifest.rollback_revisions).some((key) => !['profile', 'settings'].includes(key))
    || Object.values(manifest.rollback_revisions).some((value) => value !== null && !/^[a-f0-9]{64}$/u.test(value ?? '')))) return false;
  if (Object.entries(manifest.mutation_journal).some(([key, entry]) => !['profile', 'settings'].includes(key)
    || !onlyKeys(entry, ['next_revision', 'previous_revision', 'created', 'witness', 'phase', 'direction'])
    || !entry || typeof entry !== 'object' || entry.phase !== 'WRITE_PENDING'
    || (entry.next_revision !== null && !/^[a-f0-9]{64}$/u.test(entry.next_revision ?? ''))
    || (entry.previous_revision !== null && !/^[a-f0-9]{64}$/u.test(entry.previous_revision ?? ''))
    || typeof entry.created !== 'boolean'
    || (entry.direction !== undefined && !['forward', 'rollback'].includes(entry.direction))
    || (entry.witness !== undefined && !validWitnessPath(root, entry.witness))
    || (entry.witness !== undefined && !validWitness(root, entry.witness)
      && !(entry.direction === 'rollback' && entry.next_revision === null && ['ROLLBACK_APPLYING', 'ROLLBACK_APPLIED', 'ROLLBACK_RESTART_PENDING'].includes(manifest.phase))))) return false;
  if (!onlyKeys(manifest.files, ['profile', 'settings']) || manifest.files?.settings?.existed === false && ['USER_MATERIALIZED', 'BASE_REMOVED', 'RESTART_PENDING', 'VERIFIED'].includes(manifest.phase)
    && (!validFileIdentity(manifest.created_settings_identity) || !validWitness(root, manifest.created_settings_witness))) return false;
  if (manifest.created_settings_identity !== undefined && !onlyKeys(manifest.created_settings_identity, ['dev', 'ino', 'size', 'mtimeMs'])) return false;
  if (manifest.created_settings_witness !== undefined && !validWitnessPath(root, manifest.created_settings_witness)) return false;
  if (manifest.created_settings_witness !== undefined && !validWitness(root, manifest.created_settings_witness)
    && !['ROLLBACK_APPLYING', 'ROLLBACK_APPLIED', 'ROLLBACK_RESTART_PENDING'].includes(manifest.phase)) return false;
  if (!safeTimestamp(manifest.created_at)) return false;
  if (typeof manifest.checksum !== 'string' || manifest.checksum !== manifestDigest(manifest)) return false;
  for (const key of ['profile', 'settings']) {
    const entry = manifest.files?.[key];
    if (!onlyKeys(entry, ['existed', 'revision']) || !entry || typeof entry.existed !== 'boolean' || (key === 'profile' && entry.existed !== true) || (!entry.existed && entry.revision !== null) || entry.revision !== expected[key] || (entry.revision !== null && !/^[a-f0-9]{64}$/u.test(entry.revision))) return false;
    if (entry.backup_digest !== undefined || existsSync(join(root, `${key}.backup`))) return false;
  }
  return true;
}

function quarantineUnderRoot(root, actionId, managedRoot) {
  assertManagedPath(root, managedRoot);
  if (typeof actionId !== 'string' || !/^[a-f0-9]{32}$/u.test(actionId)) throw Object.assign(new Error('provider migration action id is invalid'), { code: 'PROVIDER_MIGRATION_PLAN_INVALID' });
  if (!existsSync(root)) throw Object.assign(new Error('provider migration transaction was not found'), { code: 'PROVIDER_MIGRATION_RECOVERY_NOT_FOUND' });
  const entry = readdirSync(root, { withFileTypes: true }).find((candidate) => candidate.name !== '.quarantine' && sha256(candidate.name).slice(0, 32) === actionId);
  if (!entry) throw Object.assign(new Error('provider migration transaction was not found'), { code: 'PROVIDER_MIGRATION_RECOVERY_NOT_FOUND' });
  const source = join(root, entry.name);
  const quarantineRoot = join(root, '.quarantine');
  const sourceStat = lstatSync(source);
  if (!sourceStat.isSymbolicLink()) assertManagedPath(source, managedRoot);
  assertManagedPath(quarantineRoot, managedRoot);
  mkdirSync(quarantineRoot, { recursive: true });
  assertManagedPath(quarantineRoot, managedRoot);
  const target = join(quarantineRoot, `${actionId}.${Date.now()}.${randomUUID().slice(0, 8)}`);
  assertManagedPath(target, managedRoot);
  renameSync(source, target);
  return { ok: true, storage_id: entry.name, action_id: actionId, state: 'QUARANTINED' };
}

export function createProviderLayerMigrationFileHooks({
  profileFile,
  settingsFile,
  backupDir,
  existingMigrationId = null,
  restart = null,
  sharedLockFile = null,
  afterRollbackDeleteJournaled = null,
  afterRollbackFileRemoved = null,
  afterRollbackWitnessRemoved = null,
} = {}) {
  if (![profileFile, settingsFile, backupDir].every((value) => typeof value === 'string' && value.trim())) throw new TypeError('provider migration paths are required');
  const managedRoot = dirname(resolvePath(backupDir));
  for (const file of [profileFile, settingsFile, backupDir]) assertManagedPath(file, managedRoot);
  mkdirSync(backupDir, { recursive: true });
  const lockFile = join(backupDir, '.migration.lock');
  let lockOwned = false;
  let lockToken = null;
  let sharedStoreLock = null;
  let active = null;
  const ensureLock = () => {
    if (!lockOwned || !lockToken) throw Object.assign(new Error('provider migration lock is unavailable'), { code: 'PROVIDER_MIGRATION_LOCK_UNAVAILABLE' });
    try {
      const owner = JSON.parse(readFileSync(lockFile, 'utf8'));
      if (owner?.token !== lockToken) throw new Error('provider migration lock ownership changed');
    } catch (error) {
      lockOwned = false;
      lockToken = null;
      throw Object.assign(new Error('provider migration lock ownership changed'), { code: 'PROVIDER_MIGRATION_LOCK_UNAVAILABLE', cause: error });
    }
  };
  const writeLock = () => {
    const token = randomUUID();
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() }) + '\n', { flag: 'wx' });
    lockToken = token;
    lockOwned = true;
  };

  const acquireLock = async () => {
    if (lockOwned) return { ok: true };
    sharedStoreLock = await acquireProviderStoreLock(sharedLockFile ?? join(managedRoot, 'provider-store.lock'));
    try {
      writeLock();
      return { ok: true };
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const reclaimGuard = `${lockFile}.reclaim`;
        let guardOwned = false;
        try {
          mkdirSync(reclaimGuard, { recursive: false });
          guardOwned = true;
          const owner = JSON.parse(readFileSync(lockFile, 'utf8'));
          if (!owner || typeof owner !== 'object' || Array.isArray(owner) || !Number.isInteger(owner.pid) || owner.pid <= 0 || !safeValue(owner.token, 128)) {
            throw Object.assign(new Error('provider migration lock metadata is invalid'), { code: 'PROVIDER_MIGRATION_BUSY' });
          }
          let alive = false;
          if (Number.isInteger(owner?.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); alive = true; } catch (probeError) { alive = probeError?.code === 'EPERM'; }
          }
          if (!alive) {
            rmSync(lockFile, { force: true });
            writeLock();
            return { ok: true, recovered: true };
          }
        } catch (reclaimError) {
          if (reclaimError?.code === 'PROVIDER_MIGRATION_BUSY') throw reclaimError;
        } finally { if (guardOwned) rmSync(reclaimGuard, { recursive: true, force: true }); }
        throw Object.assign(new Error('provider migration is busy'), { code: 'PROVIDER_MIGRATION_BUSY' });
      }
      throw Object.assign(new Error('provider migration lock is unavailable'), { code: 'PROVIDER_MIGRATION_LOCK_UNAVAILABLE' });
    } finally {
      if (!lockOwned && sharedStoreLock) { await sharedStoreLock.release(); sharedStoreLock = null; }
    }
  };
  const release = async () => {
    if (!lockOwned) return;
    let owned = true;
    try { ensureLock(); } catch { owned = false; /* a replacement owner will clean up its own lock */ }
    if (owned) rmSync(lockFile, { force: true });
    lockOwned = false;
    lockToken = null;
    if (sharedStoreLock) { await sharedStoreLock.release(); sharedStoreLock = null; }
  };
  const recoverLock = async ({ confirm = false } = {}) => {
    const shared = await recoverProviderStoreLock(sharedLockFile ?? join(managedRoot, 'provider-store.lock'), { confirm });
    if (shared.ok !== true || confirm !== true) return shared;
    if (!existsSync(lockFile)) return shared;
    try {
      const owner = JSON.parse(readFileSync(lockFile, 'utf8'));
      if (owner && typeof owner === 'object' && !Array.isArray(owner) && Number.isInteger(owner.pid) && owner.pid > 0 && safeValue(owner.token, 128)) {
        try { process.kill(owner.pid, 0); return { ok: false, code: 'PROVIDER_MIGRATION_BUSY' }; } catch (error) { if (error?.code === 'EPERM') return { ok: false, code: 'PROVIDER_MIGRATION_BUSY' }; }
      }
    } catch {}
    rmSync(lockFile, { force: true });
    return { ...shared, recovered: true };
  };
  const manifestFile = (root) => join(root, 'manifest.json');
  const persist = () => {
    if (!active) throw Object.assign(new Error('provider migration backup is unavailable'), { code: 'PROVIDER_MIGRATION_BACKUP_INVALID' });
    ensureLock();
    active.manifest.checksum = manifestDigest(active.manifest);
    atomicReplace(manifestFile(active.root), JSON.stringify(active.manifest, null, 2) + '\n', managedRoot);
  };
  const load = (migrationId) => {
    const id = safeId(migrationId);
    if (!id) throw Object.assign(new Error('provider migration id is invalid'), { code: 'PROVIDER_MIGRATION_PLAN_INVALID' });
    const root = join(backupDir, id);
    assertManagedPath(root, managedRoot);
    const file = manifestFile(root);
    try { if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error('invalid migration manifest path'); } catch (error) {
      throw Object.assign(new Error('provider migration manifest is invalid'), { code: 'PROVIDER_MIGRATION_BACKUP_INVALID', cause: error });
    }
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest?.plan_id !== id || !validMigrationManifest(root, manifest)) throw Object.assign(new Error('provider migration manifest is invalid'), { code: 'PROVIDER_MIGRATION_BACKUP_INVALID' });
    active = { root, manifest };
    return active;
  };

  const backup = async (plan) => {
    await acquireLock();
    if (existingMigrationId) { load(existingMigrationId); return { ok: true, migration_id: existingMigrationId }; }
    const safe = safePlan(plan);
    const root = join(backupDir, safe.plan_id);
    assertManagedPath(root, managedRoot);
    if (existsSync(root)) throw Object.assign(new Error('provider migration transaction already exists'), { code: 'PROVIDER_MIGRATION_EXISTS' });
    mkdirSync(root, { recursive: true });
  const profile = readText(profileFile);
  const settings = readText(settingsFile);
    const expected = safe.expected_revisions;
    if (revision(profile) !== expected.profile || revision(settings) !== expected.settings) {
      rmSync(root, { recursive: true, force: true });
      throw Object.assign(new Error('provider migration source changed before backup'), { code: 'PROVIDER_MIGRATION_SOURCE_CHANGED' });
    }
    // Migration snapshots are structured metadata only. Reject known inline
    // credential shapes in either source before touching it, while never
    // persisting a complete source file (including unrelated custom fields).
    const profileCheck = hasInlineProfileCredentials(profile ?? '');
    if (profileCheck.ok !== true || profileCheck.inline === true) {
      rmSync(root, { recursive: true, force: true });
      throw Object.assign(new Error('provider profile credential shape is unsupported'), { code: 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED' });
    }
    if (settings !== null) {
      const settingsCheck = hasInlineSettingsCredentials(settings);
      if (settingsCheck.ok !== true || settingsCheck.inline === true) {
        rmSync(root, { recursive: true, force: true });
        throw Object.assign(new Error('provider settings credential shape is unsupported'), { code: 'PROVIDER_INLINE_CREDENTIAL_UNSUPPORTED' });
      }
    }
    const manifest = {
      schema_version: 1,
      kind: 'provider-layer-migration',
      plan_id: safe.plan_id,
      provider_id: safe.provider_id,
      plan: safe,
      phase: 'PREPARED',
      files: {
        profile: { existed: profile !== null, revision: revision(profile) },
        settings: { existed: settings !== null, revision: revision(settings) },
      },
      applied_revisions: {},
      mutation_journal: {},
      created_at: new Date().toISOString(),
    };
    active = { root, manifest };
    persist();
    return { ok: true, migration_id: safe.plan_id };
  };

  const assertExpected = (file, expected, code) => {
    const current = readText(file);
    if (expected !== undefined && revision(current) !== expected) throw Object.assign(new Error('provider migration source changed'), { code });
    return current;
  };
  const writeApplied = (key, file, content) => {
    ensureLock();
    const nextRevision = revision(content);
    const previousRevision = active.manifest.files[key]?.revision ?? null;
    let witness = null;
    if (key === 'settings' && active.manifest.files.settings.existed === false) {
      witness = join(active.root, `settings.${randomUUID()}.ownership.witness`);
      assertManagedPath(witness, managedRoot);
      writeFileSync(witness, content, { flag: 'wx' });
    }
    active.manifest.mutation_journal[key] = {
      next_revision: nextRevision,
      previous_revision: previousRevision,
      created: active.manifest.files[key]?.existed === false,
      ...(witness ? { witness } : {}),
      phase: 'WRITE_PENDING',
    };
    persist();
    if (witness) {
      try { publishHardlink(witness, file, managedRoot); }
      catch (error) { throw Object.assign(new Error('provider migration exclusive create failed'), { code: 'PROVIDER_MIGRATION_REPLACE_FAILED', cause: error }); }
      // The witness is created inside the managed root, but the destination
      // can still be swapped between planning and publication. Re-check the
      // complete destination path immediately before and after the hardlink.
      assertManagedPath(file, managedRoot);
      fileIdentity(file);
    } else atomicReplace(file, content, managedRoot);
    active.manifest.applied_revisions[key] = nextRevision;
    if (key === 'settings' && active.manifest.files.settings.existed === false) {
      active.manifest.created_settings_identity = fileIdentity(file);
      active.manifest.created_settings_witness = witness;
    }
    active.manifest.phase = key === 'settings' ? 'USER_MATERIALIZED' : 'BASE_REMOVED';
    delete active.manifest.mutation_journal[key];
    persist();
  };

  const writeRollbackApplied = (key, file, content) => {
    ensureLock();
    const nextRevision = revision(content);
    active.manifest.mutation_journal[key] = {
      next_revision: nextRevision,
      previous_revision: active.manifest.applied_revisions[key] ?? active.manifest.files[key]?.revision ?? null,
      created: false,
      direction: 'rollback',
      phase: 'WRITE_PENDING',
    };
    persist();
    atomicReplace(file, content, managedRoot);
    active.manifest.rollback_revisions ??= {};
    active.manifest.rollback_revisions[key] = nextRevision;
    delete active.manifest.mutation_journal[key];
    active.manifest.phase = 'ROLLBACK_APPLYING';
    persist();
  };

  const writeRollbackDeleted = (key, file, witness = null) => {
    ensureLock();
    if (witness && !validWitnessPath(active.root, witness)) throw Object.assign(new Error('provider migration witness path is unsafe'), { code: 'PROVIDER_MIGRATION_UNSAFE_PATH' });
    active.manifest.mutation_journal[key] = {
      next_revision: null,
      previous_revision: active.manifest.applied_revisions[key] ?? active.manifest.files[key]?.revision ?? null,
      created: false,
      direction: 'rollback',
      ...(witness ? { witness } : {}),
      phase: 'WRITE_PENDING',
    };
    persist();
    if (typeof afterRollbackDeleteJournaled === 'function') afterRollbackDeleteJournaled({ key, file, witness });
    rmSync(file, { force: true });
    if (typeof afterRollbackFileRemoved === 'function') afterRollbackFileRemoved({ key, file, witness });
    active.manifest.rollback_revisions ??= {};
    active.manifest.rollback_revisions[key] = null;
    active.manifest.phase = 'ROLLBACK_APPLYING';
    // Checkpoint the successful unlink while the witness is still durable.
    // A crash after this point can reopen the rollback journal and finish
    // witness cleanup without losing ownership evidence.
    persist();
    if (witness) rmSync(witness, { force: true });
    if (typeof afterRollbackWitnessRemoved === 'function') afterRollbackWitnessRemoved({ key, file, witness });
    if (witness && active.manifest.created_settings_witness === witness) delete active.manifest.created_settings_witness;
    delete active.manifest.mutation_journal[key];
    persist();
  };

  const materialize = async (plan) => {
    if (!active) throw Object.assign(new Error('provider migration backup is unavailable'), { code: 'PROVIDER_MIGRATION_BACKUP_INVALID' });
    if (plan.action !== 'materialize-user') return { ok: true, changed: false };
    const expected = active.manifest.files.settings.revision;
    const current = assertExpected(settingsFile, expected, 'PROVIDER_SETTINGS_CHANGED');
    const source = current ?? 'llm-pi-ai:\n  providers: {}\n';
    const result = addProviderSettings(source, { provider: plan.materialization?.provider, expectedRevision: revision(source) });
    if (!result.ok) throw Object.assign(new Error('provider settings materialization failed'), { code: result.code });
    writeApplied('settings', settingsFile, result.text);
    return { ok: true, changed: true, revision: result.revision };
  };

  const removeBase = async (plan) => {
    if (!active) throw Object.assign(new Error('provider migration backup is unavailable'), { code: 'PROVIDER_MIGRATION_BACKUP_INVALID' });
    const settingsExpected = active.manifest.plan.action === 'materialize-user'
      ? active.manifest.applied_revisions.settings
      : active.manifest.files.settings.revision;
    if (settingsExpected !== undefined && revision(readText(settingsFile)) !== settingsExpected) throw Object.assign(new Error('provider settings changed before base removal'), { code: 'PROVIDER_SETTINGS_CHANGED' });
    const expected = active.manifest.files.profile.revision;
    const current = assertExpected(profileFile, expected, 'PROVIDER_PROFILE_CHANGED');
    if (current === null) throw Object.assign(new Error('provider profile source is missing'), { code: 'PROVIDER_PROFILE_CHANGED' });
    const result = removeProviderDeclarations(current, { providerIds: [plan.provider_id], expectedRevision: expected });
    if (!result.ok) throw Object.assign(new Error('provider profile migration failed'), { code: result.code });
    writeApplied('profile', profileFile, result.text);
    return { ok: true, changed: true, revision: result.revision };
  };

  const rollback = async () => {
    if (!active) throw Object.assign(new Error('provider migration backup is unavailable'), { code: 'PROVIDER_MIGRATION_BACKUP_INVALID' });
    if (['ROLLBACK_APPLIED', 'ROLLBACK_RESTART_PENDING', 'ROLLED_BACK'].includes(active.manifest.phase)) return { ok: true, state: active.manifest.phase };
    const cleanupWitnesses = new Set();
    for (const [key, file] of [['profile', profileFile], ['settings', settingsFile]]) {
      ensureLock();
      const snapshot = active.manifest.files[key];
      const current = readText(file);
      const currentRevision = revision(current);
      const pending = active.manifest.mutation_journal?.[key];
      const pendingApplied = currentRevision !== null && currentRevision === pending?.next_revision;
      const rollbackRevision = active.manifest.rollback_revisions?.[key];
      const rollbackReplay = active.manifest.phase?.startsWith('ROLLBACK') === true || pending?.direction === 'rollback';
      const semanticComplete = key === 'profile'
        ? (() => {
          const parsed = current === null ? { ok: false } : readProviderMaterialization(current, { providerId: active.manifest.provider_id, file: 'harness/profiles/dsh-crew/cordis.patch.yml' });
          return parsed.ok === true && sameProviderSemantics(parsed.provider, active.manifest.plan.materialization?.provider);
        })()
        : active.manifest.plan.action === 'materialize-user'
          ? (() => { const parsed = current === null ? { ok: false } : readProviderSettingsDeclarations(current, { file: 'harness/settings.yaml' }); return parsed.ok === true && !parsed.declarations.some((entry) => entry.id === active.manifest.provider_id); })()
          : (() => { const material = current === null ? { ok: false } : readProviderSettingsMaterialization(current, { providerId: active.manifest.provider_id, file: 'harness/settings.yaml' }); return material.ok === true && sameProviderSemantics(material.provider, active.manifest.plan.user_materialization_before); })();
      const alreadyRolledBack = (rollbackRevision === null && rollbackRevision !== undefined ? current === null : currentRevision === rollbackRevision)
        || (rollbackReplay && semanticComplete);
      // For an originally absent settings file, a matching digest is not
      // ownership evidence: a different actor can recreate the same bytes on
      // a different inode after a crash. Require the durable witness/identity
      // path below instead of allowing the hash-only pending journal fallback.
      const pendingWitnessPath = key === 'settings' && pending?.witness ? pending.witness : null;
      if (pendingWitnessPath) cleanupWitnesses.add(pendingWitnessPath);
      const pendingWitnessIdentity = pendingWitnessPath && validWitness(active.root, pendingWitnessPath)
        ? fileIdentity(pending.witness) : null;
      const ownershipSafePending = key !== 'settings' || snapshot.existed !== false || (pendingApplied
        && (sameFileIdentity(fileIdentity(file), active.manifest.created_settings_identity)
          || sameFileIdentity(fileIdentity(file), pendingWitnessIdentity)));
      const allowed = alreadyRolledBack || currentRevision === snapshot.revision || currentRevision === active.manifest.applied_revisions[key] || (pendingApplied && ownershipSafePending);
      if (!allowed) throw Object.assign(new Error('provider migration state changed during rollback'), { code: 'PROVIDER_MIGRATION_STATE_CHANGED' });
      if (key === 'profile') {
        if (!snapshot.existed) throw Object.assign(new Error('provider profile snapshot is unavailable'), { code: 'PROVIDER_MIGRATION_BACKUP_INVALID' });
        if (!alreadyRolledBack && currentRevision !== snapshot.revision) {
          const restored = addProviderDeclaration(current, { provider: active.manifest.plan.materialization?.provider, expectedRevision: currentRevision });
          if (!restored.ok) throw Object.assign(new Error('provider migration profile restore failed'), { code: restored.code });
          writeRollbackApplied('profile', file, restored.text);
        }
      } else if (active.manifest.plan.action === 'materialize-user') {
        if (snapshot.existed) {
          const restored = readProviderSettingsDeclarations(current ?? '', { file: 'harness/settings.yaml' });
          if (!restored.ok) throw Object.assign(new Error('provider migration settings restore failed'), { code: 'PROVIDER_MIGRATION_BACKUP_INVALID' });
          const target = restored.declarations.some((entry) => entry.id === active.manifest.provider_id) ? current : null;
          if (target === null) throw Object.assign(new Error('provider migration settings target is missing'), { code: 'PROVIDER_MIGRATION_STATE_CHANGED' });
          // Remove only the provider materialized by this transaction; other
          // settings (including user fields) remain byte-for-byte untouched.
          const removed = removeProviderSettings(current, { providerIds: [active.manifest.provider_id], expectedRevision: currentRevision });
          if (!removed.ok) throw Object.assign(new Error('provider migration settings restore failed'), { code: removed.code });
          writeRollbackApplied('settings', file, removed.text);
        } else if (current !== null) {
          const witnessPath = active.manifest.created_settings_witness ?? pending?.witness;
          if (witnessPath) cleanupWitnesses.add(witnessPath);
          const witnessIdentity = witnessPath && validWitness(active.root, witnessPath) ? fileIdentity(witnessPath) : null;
          const ownedByIdentity = sameFileIdentity(fileIdentity(file), active.manifest.created_settings_identity) || sameFileIdentity(fileIdentity(file), witnessIdentity);
          if (!ownedByIdentity) throw Object.assign(new Error('provider migration settings ownership changed'), { code: 'PROVIDER_MIGRATION_STATE_CHANGED' });
          writeRollbackDeleted('settings', file, witnessPath);
        }
      }
    }
    if (cleanupWitnesses.size > 0 && active.manifest.phase !== 'ROLLBACK_APPLYING') {
      active.manifest.phase = 'ROLLBACK_APPLYING';
      persist();
    }
    for (const witness of cleanupWitnesses) {
      if (validWitness(active.root, witness)) rmSync(witness, { force: true });
      if (active.manifest.created_settings_witness === witness) delete active.manifest.created_settings_witness;
    }
    active.manifest.mutation_journal = {};
    active.manifest.phase = 'ROLLBACK_APPLIED';
    if (active.manifest.created_settings_witness) {
      if (!validWitnessPath(active.root, active.manifest.created_settings_witness)) throw Object.assign(new Error('provider migration witness path is unsafe'), { code: 'PROVIDER_MIGRATION_UNSAFE_PATH' });
      rmSync(active.manifest.created_settings_witness, { force: true });
      delete active.manifest.created_settings_witness;
    }
    persist();
    return { ok: true, state: 'ROLLBACK_APPLIED' };
  };

  const verify = async (plan) => {
    const profile = readText(profileFile);
    const settings = readText(settingsFile);
    const profileParsed = profile === null ? { ok: false } : readProviderDeclarations(profile, { file: 'harness/profiles/dsh-crew/cordis.patch.yml' });
    const settingsParsed = settings === null ? { ok: false } : readProviderSettingsDeclarations(settings, { file: 'harness/settings.yaml' });
    const baseAbsent = profileParsed.ok === true && !profileParsed.declarations.some((entry) => entry.id === plan.provider_id);
    const userPresent = settingsParsed.ok === true && settingsParsed.declarations.some((entry) => entry.id === plan.provider_id);
    const userSemanticsPreserved = plan.action !== 'promote-existing-user'
      || (() => {
        const material = settings === null ? { ok: false } : readProviderSettingsMaterialization(settings, { providerId: plan.provider_id, file: 'harness/settings.yaml' });
        return material.ok === true && sameProviderSemantics(material.provider, active?.manifest?.plan?.user_materialization_before ?? plan.user_materialization_before);
      })();
    const nativeRemovable = baseAbsent && userPresent && userSemanticsPreserved;
    return { ok: nativeRemovable, baseAbsent, userPresent, userSemanticsPreserved, nativeRemovable };
  };

  const finalizeVerified = async () => {
    if (!active) throw Object.assign(new Error('provider migration backup is unavailable'), { code: 'PROVIDER_MIGRATION_BACKUP_INVALID' });
    if (Object.keys(active.manifest.mutation_journal ?? {}).length > 0) throw Object.assign(new Error('provider migration mutation journal is not empty'), { code: 'PROVIDER_MIGRATION_BACKUP_INVALID' });
    active.manifest.phase = 'VERIFIED';
    persist();
    return { ok: true, state: 'VERIFIED' };
  };

  const setRollbackRuntimeBaseline = async (runtimeId) => {
    if (!active || !safeValue(runtimeId, 128)) throw Object.assign(new Error('provider migration runtime identity is unavailable'), { code: 'PROVIDER_RUNTIME_ID_MISSING' });
    ensureLock();
    active.manifest.plan.rollback_runtime_id_before = safeValue(runtimeId, 128);
    active.manifest.phase = 'ROLLBACK_RESTART_PENDING';
    persist();
    return { ok: true, runtime_id: active.manifest.plan.rollback_runtime_id_before };
  };

  const setRestartRuntimeBaseline = async (runtimeId) => {
    if (!active || !safeValue(runtimeId, 128)) throw Object.assign(new Error('provider migration runtime identity is unavailable'), { code: 'PROVIDER_RUNTIME_ID_MISSING' });
    ensureLock();
    active.manifest.plan.runtime_id_before_restart = safeValue(runtimeId, 128);
    active.manifest.phase = 'RESTART_PENDING';
    persist();
    return { ok: true, runtime_id: active.manifest.plan.runtime_id_before_restart };
  };

  const verifyRollback = async (plan) => {
    const profile = readText(profileFile);
    const settings = readText(settingsFile);
    const profileParsed = profile === null ? { ok: false } : readProviderDeclarations(profile, { file: 'harness/profiles/dsh-crew/cordis.patch.yml' });
    const settingsParsed = settings === null ? { ok: false } : readProviderSettingsDeclarations(settings, { file: 'harness/settings.yaml' });
    const restored = profileParsed.ok === true
      && (() => {
        const material = readProviderMaterialization(profile, { providerId: plan.provider_id, file: 'harness/profiles/dsh-crew/cordis.patch.yml' });
        return material.ok === true && sameProviderSemantics(material.provider, active?.manifest?.plan?.materialization?.provider ?? plan.materialization?.provider);
      })();
    const basePresent = restored;
    const userPresent = settingsParsed.ok === true && settingsParsed.declarations.some((entry) => entry.id === plan.provider_id);
    const expectedUser = plan.action === 'promote-existing-user';
    const userSemantics = expectedUser
      ? (() => { const material = readProviderSettingsMaterialization(settings, { providerId: plan.provider_id, file: 'harness/settings.yaml' }); return material.ok === true && sameProviderSemantics(material.provider, active?.manifest?.plan?.user_materialization_before ?? plan.user_materialization_before); })()
      : !userPresent;
    return { ok: basePresent && userSemantics, basePresent, userPresent, userSemantics, expectedUser };
  };

  const finalizeRollback = async () => {
    if (!active) throw Object.assign(new Error('provider migration backup is unavailable'), { code: 'PROVIDER_MIGRATION_BACKUP_INVALID' });
    ensureLock();
    for (const entry of Object.values(active.manifest.mutation_journal ?? {})) {
      if (entry?.witness && validWitness(active.root, entry.witness)) rmSync(entry.witness, { force: true });
    }
    active.manifest.mutation_journal = {};
    active.manifest.phase = 'ROLLED_BACK';
    if (active.manifest.created_settings_witness) {
      rmSync(active.manifest.created_settings_witness, { force: true });
      delete active.manifest.created_settings_witness;
    }
    persist();
    return { ok: true, state: 'ROLLED_BACK' };
  };

  const quarantine = async (actionId) => {
    await acquireLock();
    try { ensureLock(); return quarantineUnderRoot(backupDir, actionId, managedRoot); }
    finally { await release(); }
  };

  return {
    acquireLock, release, recoverLock, backup, materialize, removeBase, rollback, verify, verifyRollback, finalizeVerified, finalizeRollback, setRollbackRuntimeBaseline, setRestartRuntimeBaseline, quarantine,
    backupPlan: () => active?.manifest?.plan ? JSON.parse(JSON.stringify(active.manifest.plan)) : null,
    backupManifest: () => active?.manifest ? JSON.parse(JSON.stringify(active.manifest)) : null,
    restart,
  };
}

/** Return nonterminal migration transactions without exposing source bytes. */
export function readProviderLayerMigrationTransactions(root) {
  if (typeof root !== 'string' || !existsSync(root)) return [];
  try { if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) return [{ storage_id: null, action_id: null, transaction_id: null, provider_id: null, phase: 'RECOVERY_UNRESOLVED', updated_at: new Date(0).toISOString(), recoverable: false, unresolved: true, source: 'provider-layer-migration' }]; } catch { return [{ storage_id: null, action_id: null, transaction_id: null, provider_id: null, phase: 'RECOVERY_UNRESOLVED', updated_at: new Date(0).toISOString(), recoverable: false, unresolved: true, source: 'provider-layer-migration' }]; }
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.name !== '.quarantine' && !/^\.migration\.lock(?:\.reclaim)?$/u.test(entry.name)).flatMap((entry) => {
      const file = join(root, entry.name, 'manifest.json');
      const actionId = sha256(entry.name).slice(0, 32);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return [{ storage_id: entry.name, action_id: actionId, transaction_id: null, provider_id: null, phase: 'RECOVERY_UNRESOLVED', updated_at: new Date(0).toISOString(), recoverable: false, unresolved: true, source: 'provider-layer-migration' }];
      try {
        if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error('invalid migration manifest path');
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        if (!validMigrationManifest(join(root, entry.name), manifest)) return [{ storage_id: entry.name, action_id: actionId, transaction_id: safeId(manifest?.plan_id), provider_id: safeId(manifest?.provider_id), phase: 'RECOVERY_UNRESOLVED', updated_at: new Date(0).toISOString(), recoverable: false, unresolved: true, source: 'provider-layer-migration' }];
        const phase = text(manifest?.phase) ?? 'RECOVERY_UNRESOLVED';
        if (['VERIFIED', 'ROLLED_BACK'].includes(phase)) return [];
        const providerId = safeId(manifest?.provider_id);
        return [{
          storage_id: entry.name, action_id: actionId,
          transaction_id: safeId(manifest?.plan_id),
          provider_id: providerId,
          phase,
          updated_at: text(manifest?.created_at) ?? statSync(file).mtime.toISOString(),
          recoverable: providerId !== null,
          unresolved: providerId === null,
          source: 'provider-layer-migration',
        }];
      } catch {
        return [{ storage_id: entry.name, action_id: actionId, transaction_id: null, provider_id: null, phase: 'RECOVERY_UNRESOLVED', updated_at: new Date(0).toISOString(), recoverable: false, unresolved: true, source: 'provider-layer-migration' }];
      }
    });
  } catch {
    return [{ storage_id: null, action_id: null, transaction_id: null, provider_id: null, phase: 'RECOVERY_UNRESOLVED', updated_at: new Date(0).toISOString(), recoverable: false, unresolved: true, source: 'provider-layer-migration' }];
  }
}
