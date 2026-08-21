// v0.3 persisted-config authority facade.
//
// The v0.2 installer/config implementation is frozen in install-legacy.mjs.
// This module keeps all installer exports while replacing only global config
// read/write semantics with schema-v3 canonical authority.

export * from './install-legacy.mjs';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as legacy from './install-legacy.mjs';
import { normalizeModelPriority } from '../model-routing.mjs';
import {
  CONFIG_SCHEMA_VERSION,
  configHasCanonicalAuthority,
  normalizeGlobalConfig,
  normalizeLegacyGlobalConfig,
} from '../policy.mjs';

const GLOBAL_CONFIG_FILE = join(homedir(), '.config', 'dsh-crew', 'config.json');

export const GLOBAL_CONFIG_SCHEMA_VERSION = CONFIG_SCHEMA_VERSION;
export const GLOBAL_CONFIG_DEFAULTS = Object.freeze({
  ...legacy.GLOBAL_CONFIG_DEFAULTS,
  config_schema_version: CONFIG_SCHEMA_VERSION,
});

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function validObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sourceVersion(stored) {
  return Number.isInteger(stored?.config_schema_version) ? stored.config_schema_version : 0;
}

function attachReadMetadata(config, { version, canonical }) {
  return {
    ...config,
    config_schema_version: version,
    config_authority: canonical ? 'canonical' : 'legacy-import',
    config_migration_required: !canonical,
  };
}

function freshConfig() {
  const normalized = normalizeLegacyGlobalConfig(legacy.GLOBAL_CONFIG_DEFAULTS);
  return attachReadMetadata({
    ...normalized,
    config_schema_version: CONFIG_SCHEMA_VERSION,
  }, { version: CONFIG_SCHEMA_VERSION, canonical: true });
}

export function mergeStoredGlobalConfig(stored) {
  if (!validObject(stored)) return freshConfig();

  const version = sourceVersion(stored);
  if (configHasCanonicalAuthority(stored)) {
    const merged = { ...legacy.GLOBAL_CONFIG_DEFAULTS, ...stored };
    return attachReadMetadata(normalizeGlobalConfig(merged), { version, canonical: true });
  }

  // Legacy files keep the exact v0.2 import semantics.  Reading is non-
  // mutating: migration is reported but the disk file is upgraded only on the
  // next explicit save.
  const legacyMerged = legacy.mergeStoredGlobalConfig(stored);
  const normalized = normalizeLegacyGlobalConfig(legacyMerged);
  return attachReadMetadata(normalized, { version, canonical: false });
}

export function readGlobalConfig({ configFile = GLOBAL_CONFIG_FILE } = {}) {
  if (!existsSync(configFile)) return freshConfig();
  return mergeStoredGlobalConfig(readJson(configFile, {}));
}

function stripReadMetadata(config) {
  const next = { ...config };
  delete next.config_authority;
  delete next.config_migration_required;
  return next;
}

function mergeCanonicalPatch(current, patch) {
  const next = { ...current };
  if (validObject(patch.execution)) {
    next.execution = { ...current.execution, ...patch.execution };
    if (patch.execution.enabled !== undefined) next.subagents_enabled = Boolean(patch.execution.enabled);
  }
  if (validObject(patch.worker)) {
    next.worker = {
      ...current.worker,
      ...patch.worker,
      model_policy: validObject(patch.worker.model_policy)
        ? { ...current.worker?.model_policy, ...patch.worker.model_policy }
        : current.worker?.model_policy,
    };
  }
  if (validObject(patch.review)) {
    next.review = {
      ...current.review,
      ...patch.review,
      model_policy: validObject(patch.review.model_policy)
        ? { ...current.review?.model_policy, ...patch.review.model_policy }
        : current.review?.model_policy,
    };
  }

  // v0.3 still has one provider-mode control.  A direct canonical patch is
  // allowed, but it cannot manufacture separate worker/reviewer authorities.
  const providerMode = patch.worker?.provider_mode ?? patch.review?.provider_mode;
  if (providerMode !== undefined) {
    next.worker = { ...next.worker, provider_mode: providerMode };
    next.review = { ...next.review, provider_mode: providerMode };
    next.worker_provider_mode = providerMode;
  }
  return next;
}

/**
 * Persist one schema-v3 snapshot.
 *
 * Flat fields remain in the JSON as compatibility mirrors for older UI/MCP
 * builds, but schema-v3 readers ignore conflicting mirrors and trust the nested
 * canonical snapshot.  Legacy flat patches are accepted as migration commands
 * and immediately recompiled into canonical state before the write completes.
 */
export function writeGlobalConfig(patch, { configFile = GLOBAL_CONFIG_FILE } = {}) {
  mkdirSync(dirname(configFile), { recursive: true });
  const current = readGlobalConfig({ configFile });
  let next = stripReadMetadata(current);

  // Existing public settings surface: accept only known flat keys.  Schema and
  // read-only authority metadata are never caller-controlled.
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined && key in legacy.GLOBAL_CONFIG_DEFAULTS) next[key] = value;
  }

  for (const tier of ['flash', 'pro']) {
    const key = `${tier}_model_priority`;
    if (patch?.[key] !== undefined) {
      next[key] = normalizeModelPriority(patch[key]);
      next[`${tier}_model_priority_configured`] = true;
    }
  }

  // The deprecated clamp is an input command only.  Keep its mirror coherent
  // with the collaboration selector so old callers cannot create two meanings.
  if (patch?.tier_policy !== undefined) {
    next.tier_policy = patch.tier_policy;
    if (patch.tier_policy === 'flash-only') next.collaboration_mode = 'flash-only';
    else if (patch.tier_policy === 'pro-only') next.collaboration_mode = 'pro-only';
    else if (next.collaboration_mode === 'flash-only' || next.collaboration_mode === 'pro-only') next.collaboration_mode = 'balanced';
  }
  if (patch?.collaboration_mode !== undefined) {
    if (patch.collaboration_mode === 'flash-only') next.tier_policy = 'flash-only';
    else if (patch.collaboration_mode === 'pro-only') next.tier_policy = 'pro-only';
    else next.tier_policy = 'auto';
  }

  const hasCanonicalPatch = validObject(patch?.worker)
    || validObject(patch?.review)
    || validObject(patch?.execution);

  let normalized;
  if (hasCanonicalPatch) {
    next = mergeCanonicalPatch(next, patch);
    normalized = normalizeGlobalConfig({
      ...next,
      config_schema_version: CONFIG_SCHEMA_VERSION,
    });
  } else {
    // Recompile the compatibility view through the frozen migration.  Remove
    // the previous nested snapshot first so a flat settings change (for
    // example max_parallel) cannot be shadowed by yesterday's canonical value.
    const legacyInput = { ...next };
    delete legacyInput.worker;
    delete legacyInput.review;
    delete legacyInput.execution;
    delete legacyInput.config_schema_version;
    normalized = normalizeLegacyGlobalConfig(legacyInput);
  }

  const persisted = stripReadMetadata({
    ...normalized,
    config_schema_version: CONFIG_SCHEMA_VERSION,
  });
  writeFileSync(configFile, JSON.stringify(persisted, null, 2) + '\n');
  return attachReadMetadata(normalizeGlobalConfig(persisted), {
    version: CONFIG_SCHEMA_VERSION,
    canonical: true,
  });
}

export function getGlobalConfigDiagnostics({ configFile = GLOBAL_CONFIG_FILE } = {}) {
  if (!existsSync(configFile)) {
    return {
      current_schema_version: CONFIG_SCHEMA_VERSION,
      stored_schema_version: null,
      authority: 'canonical',
      migration_required: false,
      canonical_present: true,
      legacy_mirror_conflicts: [],
    };
  }

  const stored = readJson(configFile, {});
  const version = sourceVersion(stored);
  const canonical = configHasCanonicalAuthority(stored);
  const conflicts = [];
  if (canonical) {
    const effective = normalizeGlobalConfig(stored);
    const mirrorKeys = [
      'subagents_enabled', 'main_agent_mode', 'default_effort',
      'default_timeout_seconds', 'mode', 'max_parallel', 'isolation',
      'worker_state', 'review_state', 'auto_review', 'worker_provider_mode',
      'flash_model_priority', 'flash_model_priority_configured',
      'flash_model_fallback', 'pro_model_priority',
      'pro_model_priority_configured', 'pro_model_fallback',
      'escalate_on_failure', 'pro_reviews_flash',
    ];
    for (const key of mirrorKeys) {
      if (!Object.prototype.hasOwnProperty.call(stored, key)) continue;
      if (JSON.stringify(stored[key]) !== JSON.stringify(effective[key])) conflicts.push(key);
    }
  }

  return {
    current_schema_version: CONFIG_SCHEMA_VERSION,
    stored_schema_version: version,
    authority: canonical ? 'canonical' : 'legacy-import',
    migration_required: !canonical,
    canonical_present: canonical,
    legacy_mirror_conflicts: conflicts,
  };
}
