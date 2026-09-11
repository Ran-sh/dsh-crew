// Pure Harness-backed worker model selection. A worker tier describes a role,
// not a fixed model: explicit provider/model priorities win, fresh configs may
// use a tier-specific preferred model id, and Harness Default is the final
// fallback. Catalog membership is advisory; provider registration is the
// routing boundary.

import { rankAdaptiveCandidates } from './adaptive-routing.mjs';
import { scheduleAdmission } from './model-schedule.mjs';

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
  ADAPTIVE_DEPRIORITIZED: 'ADAPTIVE_DEPRIORITIZED',
  PROVIDER_TOMBSTONED: 'PROVIDER_TOMBSTONED',
  CREDENTIAL_MISSING: 'CREDENTIAL_MISSING',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  RATE_LIMITED: 'RATE_LIMITED',
  PEAK_RESTRICTED: 'PEAK_RESTRICTED',
  PEAK_ADVISORY: 'PEAK_ADVISORY',
  PROBE_TIMEOUT: 'PROBE_TIMEOUT',
  PROVIDER_INTERNAL_ERROR: 'PROVIDER_INTERNAL_ERROR',
  HARNESS_DEFAULT_INVALID: 'HARNESS_DEFAULT_INVALID',
  HARNESS_DEFAULT_PROVIDER_UNAVAILABLE: 'HARNESS_DEFAULT_PROVIDER_UNAVAILABLE',
  PRIMARY_CANDIDATES_EXHAUSTED: 'PRIMARY_CANDIDATES_EXHAUSTED',
  ESCALATION_CANDIDATES_EXHAUSTED: 'ESCALATION_CANDIDATES_EXHAUSTED',
  NO_AVAILABLE_MODEL: 'NO_AVAILABLE_MODEL',
});

const HEALTH_BLOCK_REASONS = Object.freeze({
  'credential-missing': MODEL_SELECTION_REASON_CODES.CREDENTIAL_MISSING,
  'quota-exhausted': MODEL_SELECTION_REASON_CODES.QUOTA_EXHAUSTED,
  'rate-limited': MODEL_SELECTION_REASON_CODES.RATE_LIMITED,
  timeout: MODEL_SELECTION_REASON_CODES.PROBE_TIMEOUT,
  'internal-error': MODEL_SELECTION_REASON_CODES.PROVIDER_INTERNAL_ERROR,
});

const BLOCKED_MODEL_CODES = Object.freeze({
  [MODEL_SELECTION_REASON_CODES.CREDENTIAL_MISSING]: 'MODEL_BLOCKED_CREDENTIAL',
  [MODEL_SELECTION_REASON_CODES.QUOTA_EXHAUSTED]: 'MODEL_BLOCKED_QUOTA',
  [MODEL_SELECTION_REASON_CODES.RATE_LIMITED]: 'MODEL_BLOCKED_RATE_LIMIT',
  [MODEL_SELECTION_REASON_CODES.PROBE_TIMEOUT]: 'MODEL_BLOCKED_TIMEOUT',
  [MODEL_SELECTION_REASON_CODES.PROVIDER_INTERNAL_ERROR]: 'MODEL_BLOCKED_PROVIDER',
  [MODEL_SELECTION_REASON_CODES.PROVIDER_TOMBSTONED]: 'MODEL_BLOCKED_TOMBSTONED',
  [MODEL_SELECTION_REASON_CODES.PEAK_RESTRICTED]: 'MODEL_BLOCKED_PEAK',
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

function healthAdmissionReason(ref, { healthStore, healthGate, tombstones } = {}) {
  if (tombstones?.[ref?.provider] === 'absent') return MODEL_SELECTION_REASON_CODES.PROVIDER_TOMBSTONED;
  if (healthGate !== 'hard-failures' || typeof healthStore?.get !== 'function') return null;
  const observation = healthStore.get(ref?.provider, ref?.model);
  if (observation?.fresh !== true) return null;
  return HEALTH_BLOCK_REASONS[observation.state] ?? null;
}

/**
 * Peak/off-peak admission for one candidate.
 *
 * Returns `null` when the model is unrestricted or off-peak; otherwise the
 * schedule's verdict, which the caller applies. A `warn` rule is advisory — the
 * candidate is still selected, and the trace records why.
 */
function peakAdmission(schedule, ref, at) {
  if (!schedule) return null;
  return scheduleAdmission(schedule, ref, at);
}

function blockedSelection(trace, ref, source, reasonCode) {
  trace.fallback_reason = reasonCode;
  return {
    ok: false,
    code: BLOCKED_MODEL_CODES[reasonCode] ?? 'MODEL_BLOCKED_PROVIDER',
    message: `Model ${ref?.provider ?? 'unknown'}/${ref?.model ?? 'unknown'} is blocked by ${reasonCode}.`,
    selection_trace: trace,
  };
}

function selectTrace(trace, ref, source, { advertised, fallbackReason, reasonCode } = {}) {
  trace.ordered_candidates.push(candidateDecision(ref, source, 'selected', { advertised, reasonCode }));
  trace.selected = { provider: ref.provider, model: ref.model, source };
  trace.selection_source = source;
  trace.fallback_reason = fallbackReason ?? null;
  return trace;
}

function rankForTrace(trace, candidates, {
  adaptive,
  adaptiveHealth,
  explicitPriority = false,
} = {}) {
  const ranked = rankAdaptiveCandidates(candidates, {
    config: adaptive,
    healthStore: adaptiveHealth,
    role: trace.role,
    explicitPriority,
  });
  if (ranked.trace.enabled) trace.adaptive = ranked.trace;
  return ranked;
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
  peakAdvisory = false,
} = {}) {
  const trace = traceBase({ role, logicalAttempt, modelClassHint, strategy, candidateSet, escalationReason });
  const ref = normalizeModelRef({ provider, model });
  if (!ref) {
    trace.fallback_reason = MODEL_SELECTION_REASON_CODES.NO_AVAILABLE_MODEL;
    return trace;
  }
  return selectTrace(trace, ref, source, {
    reasonCode: peakAdvisory ? MODEL_SELECTION_REASON_CODES.PEAK_ADVISORY : null,
  });
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
        ...(trace.adaptive && typeof trace.adaptive === 'object'
          ? {
              adaptive: {
                ...trace.adaptive,
                candidates: Array.isArray(trace.adaptive.candidates)
                  ? trace.adaptive.candidates.map((item) => ({ ...item }))
                  : [],
              },
            }
          : {}),
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
  adaptive,
  adaptiveHealth,
  healthStore,
  healthGate,
  allowFallback = true,
  tombstones,
  schedule,
  at,
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

  // One clock read for the whole resolution. Calling `new Date()` per admission
  // would let a resolution that straddles a peak boundary judge candidates
  // against different instants — the filter and the all-blocked rescan below
  // could then disagree about the same candidate.
  const selectionAt = at ?? new Date();

  // Explicit priority — including an intentionally empty configured list — is
  // authoritative. Adaptive mode records that bypass but never reorders it.
  if (priorityConfigured || normalizedPriority.length > 0) {
    rankForTrace(trace, normalizedPriority, { adaptive, adaptiveHealth, explicitPriority: true });
  }

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
    const healthReason = healthAdmissionReason(ref, { healthStore, healthGate, tombstones });
    if (healthReason) {
      trace.ordered_candidates.push(candidateDecision(ref, prioritySource, 'skipped', {
        reasonCode: healthReason, advertised,
      }));
      if (allowFallback === false) return blockedSelection(trace, ref, prioritySource, healthReason);
      continue;
    }
    // A peak-blocked model is skipped so the next candidate can serve the job;
    // only an explicit no-fallback call turns it into a hard failure.
    const peak = peakAdmission(schedule, ref, selectionAt);
    if (peak?.mode === 'block') {
      trace.ordered_candidates.push(candidateDecision(ref, prioritySource, 'skipped', {
        reasonCode: MODEL_SELECTION_REASON_CODES.PEAK_RESTRICTED, advertised,
      }));
      if (allowFallback === false) return blockedSelection(trace, ref, prioritySource, MODEL_SELECTION_REASON_CODES.PEAK_RESTRICTED);
      continue;
    }
    selectTrace(trace, ref, prioritySource, {
      advertised,
      reasonCode: peak?.mode === 'warn' ? MODEL_SELECTION_REASON_CODES.PEAK_ADVISORY : null,
    });
    return {
      ok: true,
      ...ref,
      source: 'priority',
      matchedPriorityIndex: index,
      ...(advertised ? {} : { advertised: false }),
      ...(peak?.mode === 'warn' ? { peak_advisory: true } : {}),
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
      const preferred = matches[0];
      const healthReason = healthAdmissionReason(preferred, { healthStore, healthGate, tombstones });
      const peak = healthReason ? null : peakAdmission(schedule, preferred, selectionAt);
      const blockReason = healthReason ?? (peak?.mode === 'block' ? MODEL_SELECTION_REASON_CODES.PEAK_RESTRICTED : null);
      if (blockReason) {
        trace.ordered_candidates.push(candidateDecision(preferred, 'preferred-default', 'skipped', {
          reasonCode: blockReason,
        }));
        if (allowFallback === false) return blockedSelection(trace, preferred, 'preferred-default', blockReason);
      } else {
        rankForTrace(trace, matches, { adaptive, adaptiveHealth });
        selectTrace(trace, preferred, 'preferred-default', {
          reasonCode: peak?.mode === 'warn' ? MODEL_SELECTION_REASON_CODES.PEAK_ADVISORY : null,
        });
        return {
          ok: true,
          ...preferred,
          source: 'preferred-default',
          ...(peak?.mode === 'warn' ? { peak_advisory: true } : {}),
          selection_trace: trace,
        };
      }
    }
    if (matches.length > 1) {
      // Keep each admitted candidate's advisory verdict alongside it: a `warn`
      // rule is only advisory if the caller learns about it, and recomputing it
      // after the pick would re-evaluate a clock already read once.
      const verdicts = new Map();
      const availableMatches = matches.filter((candidate) => {
        const healthReason = healthAdmissionReason(candidate, { healthStore, healthGate, tombstones });
        const peak = healthReason ? null : peakAdmission(schedule, candidate, selectionAt);
        const reason = healthReason ?? (peak?.mode === 'block' ? MODEL_SELECTION_REASON_CODES.PEAK_RESTRICTED : null);
        if (!reason) {
          verdicts.set(modelRefKey(candidate), peak ?? null);
          return true;
        }
        trace.ordered_candidates.push(candidateDecision(candidate, 'preferred-default', 'skipped', {
          reasonCode: reason,
        }));
        return false;
      });
      if (availableMatches.length === 0) {
        const blocked = matches.find((candidate) => healthAdmissionReason(candidate, { healthStore, healthGate, tombstones })
          || peakAdmission(schedule, candidate, selectionAt)?.mode === 'block');
        if (blocked && allowFallback === false) {
          const reason = healthAdmissionReason(blocked, { healthStore, healthGate, tombstones })
            ?? MODEL_SELECTION_REASON_CODES.PEAK_RESTRICTED;
          return blockedSelection(trace, blocked, 'preferred-default', reason);
        }
      }
      const preferredProvider = normalizeModelRef(harnessDefault)?.provider;
      const deterministicMatch = availableMatches.find((candidate) => candidate.provider === preferredProvider) ?? null;
      // Filtering can leave exactly one admissible candidate while removing the
      // one that matched the Harness Default provider, which leaves both the
      // deterministic match and the adaptive choice empty. Ambiguity only means
      // something with two or more candidates left, so a lone survivor is picked
      // outright rather than reported as ambiguous and dropped.
      const soleMatch = availableMatches.length === 1 ? availableMatches[0] : null;
      const baseline = deterministicMatch
        ? [deterministicMatch, ...availableMatches.filter((candidate) => candidate.provider !== deterministicMatch.provider)]
        : availableMatches;
      // Ranking still runs for a lone survivor so `trace.adaptive` reflects the
      // configured policy in this shape too; the result is not consulted, because
      // ranking orders candidates rather than admitting them and must never
      // discard the only one that passed admission.
      const ranked = rankForTrace(trace, soleMatch ? [soleMatch] : baseline, { adaptive, adaptiveHealth });
      const adaptiveChoice = !soleMatch && ranked?.trace.decision_supported ? ranked.candidates[0] : null;
      const match = soleMatch ?? adaptiveChoice ?? deterministicMatch;
      if (match) {
        const decisionOrder = soleMatch ? [] : adaptiveChoice ? ranked.candidates : availableMatches;
        for (const candidate of decisionOrder) {
          if (candidate.provider === match.provider && candidate.model === match.model) continue;
          trace.ordered_candidates.push(candidateDecision(candidate, 'preferred-default', 'skipped', {
            reasonCode: adaptiveChoice
              ? MODEL_SELECTION_REASON_CODES.ADAPTIVE_DEPRIORITIZED
              : MODEL_SELECTION_REASON_CODES.PREFERRED_MODEL_AMBIGUOUS,
          }));
        }
        const verdict = verdicts.get(modelRefKey(match)) ?? null;
        selectTrace(trace, match, 'preferred-default', {
          reasonCode: verdict?.mode === 'warn' ? MODEL_SELECTION_REASON_CODES.PEAK_ADVISORY : null,
        });
        return {
          ok: true,
          ...match,
          source: 'preferred-default',
          ...(verdict?.mode === 'warn' ? { peak_advisory: true } : {}),
          selection_trace: trace,
        };
      }
      // Only the candidates still in play can be ambiguous; one already rejected
      // for a concrete reason keeps that reason and appears once.
      for (const candidate of availableMatches) {
        trace.ordered_candidates.push(candidateDecision(candidate, 'preferred-default', 'skipped', {
          reasonCode: MODEL_SELECTION_REASON_CODES.PREFERRED_MODEL_AMBIGUOUS,
        }));
      }
    } else {
      rankForTrace(trace, [], { adaptive, adaptiveHealth });
      trace.ordered_candidates.push(candidateDecision(
        { provider: null, model: preferredModelId },
        'preferred-default',
        'skipped',
        { reasonCode: MODEL_SELECTION_REASON_CODES.PREFERRED_MODEL_UNAVAILABLE },
      ));
    }
  }

  if (adaptive?.enabled === true && trace.adaptive === undefined) {
    rankForTrace(trace, [], { adaptive, adaptiveHealth });
  }

  if (fallback === 'harness-default') {
    const defaultRef = normalizeModelRef(harnessDefault);
    // The Harness Default is often also a priority or preferred candidate, and
    // that candidate has already been judged. Recording it a second time with a
    // different reason would make the trace contradict itself, so a ref that
    // already has a verdict keeps it.
    const alreadyJudged = defaultRef
      ? trace.ordered_candidates.some((row) => row.provider === defaultRef.provider && row.model === defaultRef.model)
      : false;
    if (!defaultRef) {
      trace.ordered_candidates.push(candidateDecision(null, 'harness-default', 'skipped', {
        reasonCode: MODEL_SELECTION_REASON_CODES.HARNESS_DEFAULT_INVALID,
      }));
    } else if (alreadyJudged) {
      // Keep its existing verdict; nothing further to record.
    } else if (!providers.has(defaultRef.provider)) {
      trace.ordered_candidates.push(candidateDecision(defaultRef, 'harness-default', 'skipped', {
        reasonCode: MODEL_SELECTION_REASON_CODES.HARNESS_DEFAULT_PROVIDER_UNAVAILABLE,
      }));
    } else {
      const fallbackReason = traceContext.candidateSet === 'escalation'
        ? MODEL_SELECTION_REASON_CODES.ESCALATION_CANDIDATES_EXHAUSTED
        : MODEL_SELECTION_REASON_CODES.PRIMARY_CANDIDATES_EXHAUSTED;
      const healthReason = healthAdmissionReason(defaultRef, { healthStore, healthGate, tombstones });
      const peak = healthReason ? null : peakAdmission(schedule, defaultRef, selectionAt);
      const blockReason = healthReason ?? (peak?.mode === 'block' ? MODEL_SELECTION_REASON_CODES.PEAK_RESTRICTED : null);
      if (blockReason) {
        trace.ordered_candidates.push(candidateDecision(defaultRef, 'harness-default', 'skipped', {
          reasonCode: blockReason,
        }));
        if (allowFallback === false) return blockedSelection(trace, defaultRef, 'harness-default', blockReason);
      } else {
      selectTrace(trace, defaultRef, 'harness-default', {
        fallbackReason,
        reasonCode: peak?.mode === 'warn' ? MODEL_SELECTION_REASON_CODES.PEAK_ADVISORY : null,
      });
      return {
        ok: true,
        ...defaultRef,
        source: 'harness-default',
        ...(peak?.mode === 'warn' ? { peak_advisory: true } : {}),
        ...(typeof harnessDefault.reasoningEffort === 'string' && harnessDefault.reasoningEffort
          ? { reasoningEffort: harnessDefault.reasoningEffort }
          : {}),
        selection_trace: trace,
      };
      }
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
  adaptiveHealth,
  healthStore,
  healthGate,
  allowFallback = true,
  tombstones,
  schedule,
  at,
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
    adaptive: p.adaptive,
    adaptiveHealth,
    healthStore,
    healthGate,
    allowFallback,
    tombstones,
    schedule,
    at,
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
