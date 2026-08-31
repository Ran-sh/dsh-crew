// v0.3 config-authority facade over the frozen v0.2 policy implementation.
//
// The v0.2 module remains byte-for-byte available as policy-legacy.mjs. New
// callers import this facade. For schema-v3 persisted configs, the nested
// worker/review/execution/legacy snapshot is authoritative; flat Flash/Pro
// fields are compatibility mirrors only. Legacy files still flow through the
// old migration exactly as before.

export * from './policy-legacy.mjs';
import * as legacy from './policy-legacy.mjs';
import { normalizeAdaptiveRouting } from './adaptive-routing.mjs';

export { normalizeAdaptiveRouting };
export const CONFIG_SCHEMA_VERSION = 4;
const MIN_CANONICAL_SCHEMA_VERSION = 3;

function validObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const EXECUTION_TRANSPORTS = new Set(['hub-3210', 'standalone-legacy']);

function normalizeExecutionTransport(value) {
  return EXECUTION_TRANSPORTS.has(value) ? value : 'hub-3210';
}

function hasCanonicalAuthority(raw) {
  return Number(raw?.config_schema_version) >= MIN_CANONICAL_SCHEMA_VERSION
    && validObject(raw?.worker)
    && validObject(raw?.review)
    && validObject(raw?.execution);
}

function semanticLegacyMode(canonical) {
  if (canonical.review.auto_review === true && canonical.review.state === 'auto') return 'review-pipeline';
  if (canonical.worker.state === 'auto' && canonical.review.state === 'disabled'
      && canonical.worker.model_policy.strategy === 'economy') return 'flash-only';
  if (canonical.worker.state === 'auto' && canonical.review.state === 'disabled'
      && canonical.worker.model_policy.strategy === 'quality') return 'pro-only';
  if (canonical.worker.state === 'auto' && canonical.review.state === 'manual') return 'balanced';
  return 'custom';
}

function normalizeLegacySnapshot(raw, canonical) {
  // A nested v3 legacy snapshot is canonical compatibility metadata. Flat
  // fields are only a fallback for transitional/pre-v3 inputs.
  const nested = validObject(raw?.legacy) ? raw.legacy : {};
  const source = { ...raw, ...nested };
  const mode = legacy.COLLABORATION_MODES.includes(source.collaboration_mode)
    ? source.collaboration_mode
    : semanticLegacyMode(canonical);

  let flash = legacy.TIER_STATES.includes(source.flash_state) ? source.flash_state : undefined;
  let pro = legacy.TIER_STATES.includes(source.pro_state) ? source.pro_state : undefined;
  if (mode === 'flash-only') { flash = 'auto'; pro = 'disabled'; }
  else if (mode === 'pro-only') { flash = 'disabled'; pro = 'auto'; }
  else if (mode === 'balanced' || mode === 'review-pipeline') { flash = 'auto'; pro = 'auto'; }
  else {
    flash ??= canonical.worker.state;
    // reviewer=manual historically means the Pro tier is available/Auto but
    // review itself is on-demand. Preserve an explicit nested pro state when
    // present; otherwise use a conservative compatibility reconstruction.
    pro ??= canonical.review.state === 'disabled' ? 'disabled' : 'auto';
  }

  return {
    collaboration_mode: mode,
    tier_policy: mode === 'flash-only' ? 'flash-only' : mode === 'pro-only' ? 'pro-only' : 'auto',
    flash_state: flash,
    pro_state: pro,
  };
}

function modelPolicyWithAdaptive(basePolicy, rawPolicy) {
  return {
    ...basePolicy,
    adaptive: normalizeAdaptiveRouting(rawPolicy?.adaptive),
    ordering: rawPolicy?.ordering === 'health-aware' ? 'health-aware' : 'manual',
    health_gate: rawPolicy?.health_gate === 'off' ? 'off' : 'hard-failures',
  };
}

function normalizeCanonical(raw) {
  const base = legacy.getCanonical(raw);
  const providerMode = legacy.normalizeWorkerProviderMode(base.worker?.provider_mode);
  const canonical = {
    ...base,
    execution: {
      ...base.execution,
      // There is one global dispatch permission. `execution.enabled` is a
      // canonical mirror of the top-level switch, never a second authority.
      enabled: base.subagents_enabled,
      transport: normalizeExecutionTransport(raw?.execution?.transport ?? base.execution?.transport),
    },
    worker: {
      ...base.worker,
      provider_mode: providerMode,
      model_policy: modelPolicyWithAdaptive(base.worker.model_policy, raw?.worker?.model_policy),
    },
    review: {
      ...base.review,
      gate: ['required', 'optional', 'off'].includes(raw?.review?.gate) ? raw.review.gate : 'required',
      // v0.3 still exposes one Worker Provider selector. Until per-role
      // provider modes become first-class, keep both roles aligned.
      provider_mode: providerMode,
      model_policy: modelPolicyWithAdaptive(base.review.model_policy, raw?.review?.model_policy),
    },
  };
  canonical.legacy = normalizeLegacySnapshot(raw, canonical);
  return canonical;
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

function legacyRoutingMirror(canonical) {
  // Legacy tier/UI behavior has its own canonical compatibility sub-domain.
  // Never infer this back from flat mirrors: schema-v3 `legacy` owns it.
  return normalizeLegacySnapshot({ legacy: canonical.legacy }, canonical);
}

/**
 * Re-exported normalizer with schema-v3 precedence.
 *
 * `legacy.normalizeGlobalConfig` remains the import path for legacy-file
 * migration. Once schema v3 is present, flat compatibility fields are rebuilt
 * from the canonical snapshot so a stale/manual mirror cannot override runtime
 * behavior.
 */
export function normalizeGlobalConfig(raw = {}) {
  const normalized = legacy.normalizeGlobalConfig(raw);
  if (!hasCanonicalAuthority(raw)) return normalized;

  const canonical = normalizeCanonical(raw);
  const pro = proMirror(canonical);
  const routing = legacyRoutingMirror(canonical);
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
    collaboration_mode: routing.collaboration_mode,
    tier_policy: routing.tier_policy,
    flash_state: routing.flash_state,
    pro_state: routing.pro_state,
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
    legacy: canonical.legacy,
  };
}

/**
 * v0.3 model-policy view. The frozen v0.2 resolver remains authoritative for
 * every existing dimension. This facade only adds the normalized opt-in
 * adaptive sub-domain, so direct canonical-ish v0.2 callers retain the exact
 * priority/escalation semantics they had before schema-v3 existed.
 */
export function resolveModelPolicy(config = {}, role = 'worker', context = {}) {
  const base = legacy.resolveModelPolicy(config, role, context);
  const rawPolicy = role === 'reviewer'
    ? config?.review?.model_policy
    : config?.worker?.model_policy;
  return {
    ...base,
    adaptive: normalizeAdaptiveRouting(rawPolicy?.adaptive ?? base.adaptive),
  };
}

/** Automatic review respects the v4 reviewer gate; session opt-out remains authoritative. */
export function shouldAutoReview(config = {}, session = {}) {
  const normalized = normalizeGlobalConfig(config);
  const gate = ['required', 'optional', 'off'].includes(config?.review?.gate)
    ? config.review.gate
    : normalized.review?.gate;
  if (gate === 'off') return false;
  return legacy.shouldAutoReview(normalized, session);
}

/** Explicit legacy-import normalizer for the persistence layer. */
export function normalizeLegacyGlobalConfig(raw = {}) {
  return legacy.normalizeGlobalConfig(raw);
}

export function configHasCanonicalAuthority(raw = {}) {
  return hasCanonicalAuthority(raw);
}
