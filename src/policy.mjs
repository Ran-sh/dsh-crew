// v0.3 config-authority facade over the frozen v0.2 policy implementation.
//
// The v0.2 module remains byte-for-byte available as policy-legacy.mjs.  New
// callers import this facade.  For schema-v3 persisted configs the nested
// worker/review/execution snapshot is authoritative; flat Flash/Pro fields are
// compatibility mirrors only.  Legacy files still flow through the old
// migration exactly as before.

export * from './policy-legacy.mjs';
import * as legacy from './policy-legacy.mjs';

export const CONFIG_SCHEMA_VERSION = 3;

function hasCanonicalAuthority(raw) {
  return Number(raw?.config_schema_version) >= CONFIG_SCHEMA_VERSION
    && raw?.worker && typeof raw.worker === 'object'
    && raw?.review && typeof raw.review === 'object'
    && raw?.execution && typeof raw.execution === 'object';
}

function normalizeCanonical(raw) {
  const canonical = legacy.getCanonical(raw);
  const providerMode = legacy.normalizeWorkerProviderMode(canonical.worker?.provider_mode);
  return {
    ...canonical,
    execution: {
      ...canonical.execution,
      // There is one global dispatch permission.  `execution.enabled` is a
      // canonical mirror of the top-level switch, never a second authority.
      enabled: canonical.subagents_enabled,
    },
    worker: {
      ...canonical.worker,
      provider_mode: providerMode,
    },
    review: {
      ...canonical.review,
      // v0.3 still exposes one Worker Provider selector.  Until per-role
      // provider modes become a first-class feature, keep both roles aligned.
      provider_mode: providerMode,
    },
  };
}

function proMirror(canonical) {
  const escalation = canonical.worker.model_policy;
  const reviewer = canonical.review.model_policy;
  if (escalation.escalation_priority_configured || escalation.escalation_priority.length > 0) {
    return {
      priority: escalation.escalation_priority,
      configured: escalation.escalation_priority_configured,
      fallback: escalation.fallback,
    };
  }
  return {
    priority: reviewer.priority,
    configured: reviewer.priorityConfigured,
    fallback: reviewer.fallback,
  };
}

/**
 * Re-exported normalizer with schema-v3 precedence.
 *
 * `legacy.normalizeGlobalConfig` remains the import path for legacy-file
 * migration.  Once schema v3 is present, exact flat mirrors are rebuilt from
 * canonical state so a stale/manual mirror cannot override runtime behavior.
 */
export function normalizeGlobalConfig(raw = {}) {
  const normalized = legacy.normalizeGlobalConfig(raw);
  if (!hasCanonicalAuthority(raw)) return normalized;

  const canonical = normalizeCanonical(raw);
  const pro = proMirror(canonical);
  return {
    ...normalized,
    config_schema_version: CONFIG_SCHEMA_VERSION,
    subagents_enabled: canonical.subagents_enabled,
    main_agent_mode: canonical.main_agent_mode,
    default_effort: canonical.execution.default_effort,
    default_timeout_seconds: canonical.execution.default_timeout_seconds,
    mode: canonical.execution.mode,
    max_parallel: canonical.execution.max_parallel,
    isolation: canonical.execution.isolation,
    worker_state: canonical.worker.state,
    review_state: canonical.review.state,
    auto_review: canonical.review.auto_review === true,
    worker_provider_mode: canonical.worker.provider_mode,
    flash_model_priority: [...canonical.worker.model_policy.priority],
    flash_model_priority_configured: canonical.worker.model_policy.priorityConfigured,
    flash_model_fallback: canonical.worker.model_policy.fallback,
    pro_model_priority: [...pro.priority],
    pro_model_priority_configured: pro.configured,
    pro_model_fallback: pro.fallback,
    escalate_on_failure: canonical.worker.model_policy.escalation.enabled,
    pro_reviews_flash: canonical.review.auto_review === true,
    execution: canonical.execution,
    worker: canonical.worker,
    review: canonical.review,
  };
}

/** Explicit legacy-import normalizer for the persistence layer. */
export function normalizeLegacyGlobalConfig(raw = {}) {
  return legacy.normalizeGlobalConfig(raw);
}

export function configHasCanonicalAuthority(raw = {}) {
  return hasCanonicalAuthority(raw);
}
