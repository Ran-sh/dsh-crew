// Pure Harness-backed worker model selection. A worker tier describes a role,
// not a fixed model: explicit provider/model priorities win, fresh configs may
// use a tier-specific preferred model id, and Harness Default is the final
// fallback. Catalog membership is advisory; provider registration is the
// routing boundary.

export const DEFAULT_TIER_MODEL_PREFERENCES = Object.freeze({
  flash: 'deepseek-v4-flash',
  pro: 'deepseek-v4-pro',
});

// v0.2 role → default preferred model class. A role describes who does the
// work; the model class is only the fresh-config recommendation until a
// priority list or Harness Default takes over.
export const DEFAULT_ROLE_MODEL_PREFERENCES = Object.freeze({
  worker: 'deepseek-v4-flash',
  reviewer: 'deepseek-v4-pro',
});

export const MODEL_FALLBACKS = ['harness-default'];
export const NO_WORKER_MODEL_AVAILABLE = 'NO_WORKER_MODEL_AVAILABLE';
export const MODEL_SELECTION_TRACE_VERSION = 1;
export const MODEL_SELECTION_REASON_CODES = Object.freeze({
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PREFERRED_MODEL_UNAVAILABLE: 'PREFERRED_MODEL_UNAVAILABLE',
  PREFERRED_MODEL_AMBIGUOUS: 'PREFERRED_MODEL_AMBIGUOUS',
  HARNESS_DEFAULT_INVALID: 'HARNESS_DEFAULT_INVALID',
  HARNESS_DEFAULT_PROVIDER_UNAVAILABLE: 'HARNESS_DEFAULT_PROVIDER_UNAVAILABLE',
  PRIMARY_CANDIDATES_EXHAUSTED: 'PRIMARY_CANDIDATES_EXHAUSTED',
  ESCALATION_CANDIDATES_EXHAUSTED: 'ESCALATION_CANDIDATES_EXHAUSTED',
  NO_AVAILABLE_MODEL: 'NO_AVAILABLE_MODEL',
});

export function normalizeModelRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  return provider && model ? { provider, model } : null;
}

export function modelRefKey(raw) {
  const ref = normalizeModelRef(raw);
  return ref ? `${ref.provider}\0${ref.model}` : '';
}

export function normalizeModelPriority(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const value of raw) {
    const ref = normalizeModelRef(value);
    if (!ref) continue;
    const key = modelRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function providerMap(catalog) {
  const map = new Map();
  for (const raw of catalog?.providers ?? []) {
    if (!raw || typeof raw.id !== 'string' || raw.id === '') continue;
    map.set(raw.id, raw);
  }
  return map;
}

function normalizeAttempt(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeModelClassHint(value) {
  return value === 'flash' || value === 'pro' ? value : null;
}

function traceBase({
  role = 'worker',
  logicalAttempt = 0,
  modelClassHint = null,
  strategy = 'legacy-tier',
  candidateSet = 'primary',
  escalationReason = null,
} = {}) {
  return {
    version: MODEL_SELECTION_TRACE_VERSION,
    role: role === 'reviewer' ? 'reviewer' : 'worker',
    logical_attempt: normalizeAttempt(logicalAttempt),
    model_class_hint: normalizeModelClassHint(modelClassHint),
    strategy: typeof strategy === 'string' && strategy ? strategy : 'legacy-tier',
    candidate_set: typeof candidateSet === 'string' && candidateSet ? candidateSet : 'primary',
    ordered_candidates: [],
    selected: null,
    selection_source: null,
    fallback_reason: null,
    escalation_reason: typeof escalationReason === 'string' && escalationReason ? escalationReason : null,
  };
}

function candidateDecision(ref, source, status, { reasonCode, advertised } = {}) {
  return {
    provider: ref?.provider ?? null,
    model: ref?.model ?? null,
    source,
    status,
    ...(reasonCode ? { reason_code: reasonCode } : {}),
    ...(advertised === false ? { advertised: false } : {}),
  };
}

function selectTrace(trace, ref, source, { advertised, fallbackReason } = {}) {
  trace.ordered_candidates.push(candidateDecision(ref, source, 'selected', { advertised }));
  trace.selected = { provider: ref.provider, model: ref.model, source };
  trace.selection_source = source;
  trace.fallback_reason = fallbackReason ?? null;
  return trace;
}

/**
 * Build a one-candidate trace for transports that intentionally bypass the
 * Harness catalog (DeepSeek Official strict mode / standalone legacy mode).
 */
export function buildDirectSelectionTrace({
  role = 'worker',
  logicalAttempt = 0,
  modelClassHint = null,
  strategy = 'legacy-strict',
  candidateSet = 'primary',
  provider,
  model,
  source = 'legacy-strict',
  escalationReason = null,
} = {}) {
  const trace = traceBase({ role, logicalAttempt, modelClassHint, strategy, candidateSet, escalationReason });
  const ref = normalizeModelRef({ provider, model });
  if (!ref) {
    trace.fallback_reason = MODEL_SELECTION_REASON_CODES.NO_AVAILABLE_MODEL;
    return trace;
  }
  return selectTrace(trace, ref, source);
}

/**
 * Add workflow-only context after a transport has resolved the model. This is
 * intentionally metadata-only: it never changes provider/model selection.
 */
export function enrichSelectionTrace(trace, {
  role,
  logicalAttempt,
  modelClassHint,
  escalationReason,
} = {}) {
  const base = trace && typeof trace === 'object'
    ? {
        ...trace,
        ordered_candidates: Array.isArray(trace.ordered_candidates)
          ? trace.ordered_candidates.map((item) => ({ ...item }))
          : [],
        selected: trace.selected && typeof trace.selected === 'object' ? { ...trace.selected } : null,
      }
    : traceBase({ role, logicalAttempt, modelClassHint, escalationReason });
  if (role === 'worker' || role === 'reviewer') base.role = role;
  if (Number.isInteger(logicalAttempt) && logicalAttempt >= 0) base.logical_attempt = logicalAttempt;
  if (modelClassHint === 'flash' || modelClassHint === 'pro' || modelClassHint === null) {
    base.model_class_hint = modelClassHint;
  }
  if (typeof escalationReason === 'string' && escalationReason) base.escalation_reason = escalationReason;
  else if (logicalAttempt === 0) base.escalation_reason = null;
  return base;
}

export function resolveWorkerModel({
  tier,
  priority,
  priorityConfigured = false,
  catalog,
  harnessDefault,
  fallback = 'harness-default',
  preferredModelId = DEFAULT_TIER_MODEL_PREFERENCES[tier],
  traceContext = {},
} = {}) {
  const providers = providerMap(catalog);
  const normalizedPriority = normalizeModelPriority(priority);
  const prioritySource = typeof traceContext.prioritySource === 'string' && traceContext.prioritySource
    ? traceContext.prioritySource
    : 'priority';
  const trace = traceBase({
    role: traceContext.role ?? 'worker',
    logicalAttempt: traceContext.logicalAttempt ?? 0,
    modelClassHint: traceContext.modelClassHint ?? null,
    strategy: traceContext.strategy ?? 'legacy-tier',
    candidateSet: traceContext.candidateSet ?? 'primary',
    escalationReason: traceContext.escalationReason ?? null,
  });

  for (let index = 0; index < normalizedPriority.length; index++) {
    const ref = normalizedPriority[index];
    const provider = providers.get(ref.provider);
    if (!provider) {
      trace.ordered_candidates.push(candidateDecision(ref, prioritySource, 'skipped', {
        reasonCode: MODEL_SELECTION_REASON_CODES.PROVIDER_UNAVAILABLE,
      }));
      continue;
    }
    const advertised = (provider.models ?? []).some((model) => model?.id === ref.model);
    selectTrace(trace, ref, prioritySource, { advertised });
    return {
      ok: true,
      ...ref,
      source: 'priority',
      matchedPriorityIndex: index,
      ...(advertised ? {} : { advertised: false }),
      selection_trace: trace,
    };
  }

  // A manually managed list, including an intentionally empty list, replaces
  // the fresh-config recommendation rather than silently re-inserting it.
  if (!priorityConfigured && normalizedPriority.length === 0 && typeof preferredModelId === 'string') {
    const matches = [];
    for (const provider of providers.values()) {
      if ((provider.models ?? []).some((model) => model?.id === preferredModelId)) {
        matches.push({ provider: provider.id, model: preferredModelId });
      }
    }
    if (matches.length === 1) {
      selectTrace(trace, matches[0], 'preferred-default');
      return { ok: true, ...matches[0], source: 'preferred-default', selection_trace: trace };
    }
    if (matches.length > 1) {
      const preferredProvider = normalizeModelRef(harnessDefault)?.provider;
      const match = matches.find((candidate) => candidate.provider === preferredProvider);
      if (match) {
        for (const candidate of matches) {
          if (candidate.provider === match.provider) continue;
          trace.ordered_candidates.push(candidateDecision(candidate, 'preferred-default', 'skipped', {
            reasonCode: MODEL_SELECTION_REASON_CODES.PREFERRED_MODEL_AMBIGUOUS,
          }));
        }
        selectTrace(trace, match, 'preferred-default');
        return { ok: true, ...match, source: 'preferred-default', selection_trace: trace };
      }
      for (const candidate of matches) {
        trace.ordered_candidates.push(candidateDecision(candidate, 'preferred-default', 'skipped', {
          reasonCode: MODEL_SELECTION_REASON_CODES.PREFERRED_MODEL_AMBIGUOUS,
        }));
      }
    } else {
      trace.ordered_candidates.push(candidateDecision(
        { provider: null, model: preferredModelId },
        'preferred-default',
        'skipped',
        { reasonCode: MODEL_SELECTION_REASON_CODES.PREFERRED_MODEL_UNAVAILABLE },
      ));
    }
  }

  if (fallback === 'harness-default') {
    const defaultRef = normalizeModelRef(harnessDefault);
    if (!defaultRef) {
      trace.ordered_candidates.push(candidateDecision(null, 'harness-default', 'skipped', {
        reasonCode: MODEL_SELECTION_REASON_CODES.HARNESS_DEFAULT_INVALID,
      }));
    } else if (!providers.has(defaultRef.provider)) {
      trace.ordered_candidates.push(candidateDecision(defaultRef, 'harness-default', 'skipped', {
        reasonCode: MODEL_SELECTION_REASON_CODES.HARNESS_DEFAULT_PROVIDER_UNAVAILABLE,
      }));
    } else {
      const fallbackReason = traceContext.candidateSet === 'escalation'
        ? MODEL_SELECTION_REASON_CODES.ESCALATION_CANDIDATES_EXHAUSTED
        : MODEL_SELECTION_REASON_CODES.PRIMARY_CANDIDATES_EXHAUSTED;
      selectTrace(trace, defaultRef, 'harness-default', { fallbackReason });
      return {
        ok: true,
        ...defaultRef,
        source: 'harness-default',
        ...(typeof harnessDefault.reasoningEffort === 'string' && harnessDefault.reasoningEffort
          ? { reasoningEffort: harnessDefault.reasoningEffort }
          : {}),
        selection_trace: trace,
      };
    }
  }
  trace.fallback_reason = MODEL_SELECTION_REASON_CODES.NO_AVAILABLE_MODEL;
  return {
    ok: false,
    code: NO_WORKER_MODEL_AVAILABLE,
    message: `No Harness model is available for the ${tier ?? 'requested'} worker.`,
    selection_trace: trace,
  };
}

/**
 * v0.2 role-based model selection. Turns a role's model policy (from
 * policy.resolveModelPolicy) into an ordered selection:
 *   attempt 0      → policy.priority (primary / cheap candidates)
 *   attempt >= 1   → policy.escalation_priority (strong / escalation candidates)
 *   otherwise      → Harness Default fallback
 * The output shape matches resolveWorkerModel (provider/model/source/...) plus
 * role + attempt so selection provenance lands in job metadata.
 */
export function resolveModel({
  role = 'worker',
  attempt = 0,
  policy,
  catalog,
  harnessDefault,
} = {}) {
  const p = policy && typeof policy === 'object' ? policy : {};
  const escalated = Number.isInteger(attempt) && attempt > 0;
  const candidates = escalated ? p.escalation_priority : p.priority;
  const configured = escalated
    ? p.escalation_priority_configured === true || (Array.isArray(candidates) && candidates.length > 0)
    : p.priorityConfigured === true || (Array.isArray(candidates) && candidates.length > 0);
  // Escalation never re-picks the fresh "preferred" role default: an empty
  // escalation pool falls through to Harness Default instead.
  const preferredModelId = escalated ? undefined : DEFAULT_ROLE_MODEL_PREFERENCES[role] ?? undefined;
  const result = resolveWorkerModel({
    tier: role,
    priority: candidates,
    priorityConfigured: configured,
    catalog,
    harnessDefault,
    fallback: p.fallback === 'harness-default' ? 'harness-default' : 'harness-default',
    preferredModelId,
    traceContext: {
      role,
      logicalAttempt: attempt,
      strategy: p.strategy ?? (role === 'reviewer' ? 'strong' : 'balanced'),
      candidateSet: escalated ? 'escalation' : 'primary',
      prioritySource: escalated ? 'escalation-priority' : 'priority',
    },
  });
  if (!result.ok) return { ...result, role, attempt };
  return { ...result, role, attempt };
}
