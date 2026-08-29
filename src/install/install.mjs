// v0.3 persisted-config authority facade.
//
// The v0.2 installer/config implementation is frozen in install-legacy.mjs.
// This module keeps all installer exports while replacing only global config
// read/write semantics with schema-v3 canonical authority.

export * from './install-legacy.mjs';
export * from './windows-startup.mjs';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as legacy from './install-legacy.mjs';
import { normalizeModelPriority } from '../model-routing.mjs';
import { runtimeActivationMetadata } from '../runtime-controls.mjs';
import {
  CONFIG_SCHEMA_VERSION,
  configHasCanonicalAuthority,
  normalizeGlobalConfig,
  normalizeLegacyGlobalConfig,
} from '../policy.mjs';

const GLOBAL_CONFIG_FILE = join(homedir(), '.config', 'dsh-crew', 'config.json');
const COLLABORATION_MODES = ['flash-only', 'pro-only', 'balanced', 'review-pipeline', 'custom'];
const TIER_STATES = ['disabled', 'manual', 'auto'];

// ---- P0 isolation contract -------------------------------------------------
// dsh-crew owns a dedicated DSH home and profile; repository installer/test
// paths must never default to the user's official ~/.dsh or its ``web`` profile.
// A fresh Crew Hub config points at the Crew-owned port only; the former
// shared-profile default 3080 is treated as a legacy value to migrate away from.
export const CREW_PROFILE_NAME = 'dsh-crew';
export const CREW_HOME_REL = join('.config', 'dsh-crew', 'harness');
export const CREW_DEFAULT_HUB_URL = 'http://127.0.0.1:3210';
export const CREW_LEGACY_HUB_URL = 'http://127.0.0.1:3080';
export function crewDshHome({ home = homedir() } = {}) {
  return join(home, CREW_HOME_REL);
}
export function crewProfileDir({ home = homedir() } = {}) {
  return join(crewDshHome({ home }), 'profiles', CREW_PROFILE_NAME);
}

// The isolated default set: identical to the legacy defaults except the Hub URL,
// so fresh Crew installs never point at the official web profile.
const CREW_GLOBAL_CONFIG_DEFAULTS = { ...legacy.GLOBAL_CONFIG_DEFAULTS, hub_url: CREW_DEFAULT_HUB_URL };

export const GLOBAL_CONFIG_SCHEMA_VERSION = CONFIG_SCHEMA_VERSION;
export const GLOBAL_CONFIG_DEFAULTS = Object.freeze({
  ...CREW_GLOBAL_CONFIG_DEFAULTS,
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

function legacySnapshotFrom(config = {}) {
  const mode = COLLABORATION_MODES.includes(config.collaboration_mode)
    ? config.collaboration_mode
    : (config.tier_policy === 'flash-only' ? 'flash-only'
      : config.tier_policy === 'pro-only' ? 'pro-only' : 'balanced');
  let flash = TIER_STATES.includes(config.flash_state) ? config.flash_state : 'auto';
  let pro = TIER_STATES.includes(config.pro_state) ? config.pro_state : 'auto';
  if (mode === 'flash-only') { flash = 'auto'; pro = 'disabled'; }
  else if (mode === 'pro-only') { flash = 'disabled'; pro = 'auto'; }
  else if (mode === 'balanced' || mode === 'review-pipeline') { flash = 'auto'; pro = 'auto'; }
  return {
    collaboration_mode: mode,
    tier_policy: mode === 'flash-only' ? 'flash-only' : mode === 'pro-only' ? 'pro-only' : 'auto',
    flash_state: flash,
    pro_state: pro,
  };
}

function attachReadMetadata(config, { version, canonical }) {
  return {
    ...config,
    config_schema_version: version,
    config_authority: canonical ? 'canonical' : 'legacy-import',
    config_migration_required: !canonical,
    config_activation: runtimeActivationMetadata(),
  };
}

function freshConfig() {
  const imported = normalizeLegacyGlobalConfig(CREW_GLOBAL_CONFIG_DEFAULTS);
  const normalized = normalizeGlobalConfig({
    ...imported,
    legacy: legacySnapshotFrom(imported),
    config_schema_version: CONFIG_SCHEMA_VERSION,
  });
  return attachReadMetadata(normalized, { version: CONFIG_SCHEMA_VERSION, canonical: true });
}

/**
 * Migrate the former shared-profile Crew Hub default (3080) to the Crew-owned
 * dedicated port on the read path so a fresh or recovered install can never
 * silently reconnect to the official web profile. Everything else is preserved.
 */
function migrateHubUrl(config, { legacyUrl = CREW_LEGACY_HUB_URL, dedicatedUrl = CREW_DEFAULT_HUB_URL } = {}) {
  if (validObject(config) && config.hub_url === legacyUrl) {
    return { ...config, hub_url: dedicatedUrl, hub_url_migrated_from_legacy: true };
  }
  return config;
}

export function mergeStoredGlobalConfig(stored) {
  if (!validObject(stored)) return freshConfig();

  const version = sourceVersion(stored);
  if (configHasCanonicalAuthority(stored)) {
    const merged = { ...CREW_GLOBAL_CONFIG_DEFAULTS, ...stored };
    return attachReadMetadata(migrateHubUrl(normalizeGlobalConfig(merged)), { version, canonical: true });
  }

  // Legacy files keep the exact v0.2 import semantics. Reading is non-mutating:
  // migration is reported but the disk file is upgraded only on the next
  // explicit save.
  const legacyMerged = migrateHubUrl(legacy.mergeStoredGlobalConfig(stored));
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
  delete next.config_activation;
  return next;
}

function cloneCanonical(config) {
  return {
    ...config,
    execution: { ...config.execution },
    worker: {
      ...config.worker,
      model_policy: {
        ...config.worker?.model_policy,
        priority: [...(config.worker?.model_policy?.priority ?? [])],
        escalation_priority: [...(config.worker?.model_policy?.escalation_priority ?? [])],
        escalation: { ...config.worker?.model_policy?.escalation },
      },
    },
    review: {
      ...config.review,
      model_policy: {
        ...config.review?.model_policy,
        priority: [...(config.review?.model_policy?.priority ?? [])],
      },
    },
    legacy: validObject(config.legacy) ? { ...config.legacy } : legacySnapshotFrom(config),
  };
}

function mergeCanonicalPatch(current, patch) {
  const next = cloneCanonical(current);
  if (validObject(patch.execution)) {
    next.execution = { ...next.execution, ...patch.execution };
    if (patch.execution.enabled !== undefined) next.subagents_enabled = Boolean(patch.execution.enabled);
  }
  if (validObject(patch.worker)) {
    next.worker = {
      ...next.worker,
      ...patch.worker,
      model_policy: validObject(patch.worker.model_policy)
        ? {
            ...next.worker?.model_policy,
            ...patch.worker.model_policy,
            escalation: validObject(patch.worker.model_policy.escalation)
              ? { ...next.worker?.model_policy?.escalation, ...patch.worker.model_policy.escalation }
              : next.worker?.model_policy?.escalation,
          }
        : next.worker?.model_policy,
    };
  }
  if (validObject(patch.review)) {
    next.review = {
      ...next.review,
      ...patch.review,
      model_policy: validObject(patch.review.model_policy)
        ? { ...next.review?.model_policy, ...patch.review.model_policy }
        : next.review?.model_policy,
    };
  }
  if (validObject(patch.legacy)) next.legacy = { ...next.legacy, ...patch.legacy };

  // v0.3 still has one provider-mode control. A direct canonical patch is
  // allowed, but it cannot manufacture separate worker/reviewer authorities.
  const providerMode = patch.worker?.provider_mode ?? patch.review?.provider_mode;
  if (providerMode !== undefined) {
    next.worker = { ...next.worker, provider_mode: providerMode };
    next.review = { ...next.review, provider_mode: providerMode };
    next.worker_provider_mode = providerMode;
  }
  return next;
}

function legacyInputFrom(next, patch) {
  const input = { ...next };
  delete input.worker;
  delete input.review;
  delete input.execution;
  delete input.legacy;
  delete input.config_schema_version;

  // Preset commands own derived role state. Schema-v3 mirrors from the previous
  // preset must not masquerade as explicit overrides during translation.
  if (patch?.collaboration_mode !== undefined || patch?.tier_policy !== undefined) {
    delete input.worker_state;
    delete input.review_state;
    delete input.auto_review;
    delete input.pro_reviews_flash;
    // Non-custom presets own both tier states. Custom deliberately keeps the
    // previous states as its starting point.
    if (input.collaboration_mode !== 'custom') {
      delete input.flash_state;
      delete input.pro_state;
    }
  }

  // Individual tier-state commands own role eligibility only; the existing
  // role mirrors must not shadow them.
  if (patch?.flash_state !== undefined || patch?.pro_state !== undefined) {
    delete input.worker_state;
    delete input.review_state;
  }

  // auto_review is itself the new compatibility input. pro_reviews_flash is
  // older, so remove the schema-v3 auto_review mirror when translating it.
  if (patch?.auto_review !== undefined) delete input.review_state;
  if (patch?.pro_reviews_flash !== undefined) {
    delete input.review_state;
    delete input.auto_review;
  }
  return input;
}

function anyPatched(patch, keys) {
  return keys.some((key) => patch?.[key] !== undefined);
}

/**
 * Translate the old flat Settings/API surface into a schema-v3 canonical
 * update without reconstructing unrelated canonical-only fields. This is the
 * key single-authority boundary: a legacy UI command may change what it names,
 * but cannot erase e.g. escalation.max_attempts or future canonical metadata.
 */
function mergeLegacyPatchIntoCanonical(current, compatibilityView, candidate, patch) {
  const next = cloneCanonical({
    ...compatibilityView,
    execution: current.execution,
    worker: current.worker,
    review: current.review,
    legacy: current.legacy,
    subagents_enabled: current.subagents_enabled,
    main_agent_mode: current.main_agent_mode,
  });

  if (patch?.subagents_enabled !== undefined) {
    next.subagents_enabled = candidate.subagents_enabled;
    next.execution.enabled = candidate.subagents_enabled;
  }
  if (patch?.main_agent_mode !== undefined) next.main_agent_mode = candidate.main_agent_mode;

  const executionMap = {
    default_effort: 'default_effort',
    default_timeout_seconds: 'default_timeout_seconds',
    mode: 'mode',
    max_parallel: 'max_parallel',
    isolation: 'isolation',
  };
  for (const [flat, canonical] of Object.entries(executionMap)) {
    if (patch?.[flat] !== undefined) next.execution[canonical] = candidate.execution[canonical];
  }

  // Presets own strategy + both role states + automatic-review
  // semantics and the canonical legacy compatibility snapshot.
  if (patch?.collaboration_mode !== undefined || patch?.tier_policy !== undefined) {
    next.worker.state = candidate.worker.state;
    next.review.state = candidate.review.state;
    next.worker.model_policy.strategy = candidate.worker.model_policy.strategy;
    next.review.auto_review = candidate.review.auto_review;
    next.legacy = legacySnapshotFrom(candidate);
  }
  // Tier-state controls are narrower: changing eligibility must not reset a
  // canonical model strategy or another future policy dimension. They still
  // update the nested legacy tier-state snapshot because that is their owned
  // compatibility behavior.
  if (patch?.flash_state !== undefined || patch?.pro_state !== undefined) {
    next.worker.state = candidate.worker.state;
    next.review.state = candidate.review.state;
    next.legacy = legacySnapshotFrom(candidate);
  }
  if (patch?.worker_state !== undefined) next.worker.state = candidate.worker.state;
  if (patch?.review_state !== undefined) next.review.state = candidate.review.state;
  if (patch?.auto_review !== undefined || patch?.pro_reviews_flash !== undefined) {
    next.review.auto_review = candidate.review.auto_review;
    next.review.state = candidate.review.state;
  }

  if (patch?.worker_provider_mode !== undefined) {
    next.worker.provider_mode = candidate.worker.provider_mode;
    next.review.provider_mode = candidate.worker.provider_mode;
  }

  if (anyPatched(patch, ['flash_model_priority', 'flash_model_priority_configured', 'flash_model_fallback'])) {
    next.worker.model_policy.priority = [...candidate.worker.model_policy.priority];
    next.worker.model_policy.priorityConfigured = candidate.worker.model_policy.priorityConfigured;
    next.worker.model_policy.fallback = candidate.worker.model_policy.fallback;
  }
  if (anyPatched(patch, ['pro_model_priority', 'pro_model_priority_configured', 'pro_model_fallback'])) {
    next.worker.model_policy.escalation_priority = [...candidate.worker.model_policy.escalation_priority];
    next.worker.model_policy.escalation_priority_configured = candidate.worker.model_policy.escalation_priority_configured;
    next.worker.model_policy.fallback = candidate.worker.model_policy.fallback;
    next.review.model_policy.priority = [...candidate.review.model_policy.priority];
    next.review.model_policy.priorityConfigured = candidate.review.model_policy.priorityConfigured;
    next.review.model_policy.fallback = candidate.review.model_policy.fallback;
  }
  if (patch?.escalate_on_failure !== undefined) {
    next.worker.model_policy.escalation.enabled = candidate.worker.model_policy.escalation.enabled;
  }

  return next;
}

/**
 * Persist one schema-v3 snapshot.
 *
 * Flat fields remain in the JSON as compatibility mirrors for older UI/MCP
 * builds, but schema-v3 readers ignore conflicting mirrors and trust the nested
 * canonical snapshot. Legacy flat patches are accepted as input commands and
 * translated only into the canonical fields they own.
 */
export function writeGlobalConfig(patch, { configFile = GLOBAL_CONFIG_FILE } = {}) {
  mkdirSync(dirname(configFile), { recursive: true });
  const current = readGlobalConfig({ configFile });
  const wasCanonical = current.config_authority === 'canonical';
  let compatibilityView = stripReadMetadata(current);

  // Existing public settings surface: accept only known flat keys. Schema and
  // read-only authority metadata are never caller-controlled.
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined && key in legacy.GLOBAL_CONFIG_DEFAULTS) compatibilityView[key] = value;
  }

  for (const tier of ['flash', 'pro']) {
    const key = `${tier}_model_priority`;
    if (patch?.[key] !== undefined) {
      compatibilityView[key] = normalizeModelPriority(patch[key]);
      compatibilityView[`${tier}_model_priority_configured`] = true;
    }
  }

  // Deprecated routing fields are input commands only. Keep their input view
  // coherent before the frozen migration translates them.
  if (patch?.tier_policy !== undefined) {
    compatibilityView.tier_policy = patch.tier_policy;
    if (patch.tier_policy === 'flash-only') compatibilityView.collaboration_mode = 'flash-only';
    else if (patch.tier_policy === 'pro-only') compatibilityView.collaboration_mode = 'pro-only';
    else if (compatibilityView.collaboration_mode === 'flash-only' || compatibilityView.collaboration_mode === 'pro-only') compatibilityView.collaboration_mode = 'balanced';
  }
  if (patch?.collaboration_mode !== undefined) {
    if (patch.collaboration_mode === 'flash-only') compatibilityView.tier_policy = 'flash-only';
    else if (patch.collaboration_mode === 'pro-only') compatibilityView.tier_policy = 'pro-only';
    else compatibilityView.tier_policy = 'auto';
  }

  const candidate = normalizeLegacyGlobalConfig(legacyInputFrom(compatibilityView, patch));
  let normalized = wasCanonical
    ? mergeLegacyPatchIntoCanonical(current, compatibilityView, candidate, patch)
    : { ...candidate, legacy: legacySnapshotFrom(candidate) };

  const hasCanonicalPatch = validObject(patch?.worker)
    || validObject(patch?.review)
    || validObject(patch?.execution)
    || validObject(patch?.legacy);
  if (hasCanonicalPatch) normalized = mergeCanonicalPatch(normalized, patch);

  if (!validObject(normalized.legacy)) normalized.legacy = legacySnapshotFrom(candidate);
  normalized = normalizeGlobalConfig({
    ...normalized,
    config_schema_version: CONFIG_SCHEMA_VERSION,
  });

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
      'collaboration_mode', 'tier_policy', 'flash_state', 'pro_state',
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
