// Opt-in adaptive model routing primitives.
//
// This module is deliberately pure/process-local: it never reads credentials,
// provider quota, billing data, persistent files, or DSH profile state. The
// caller may record only outcomes Crew already observed, and routing decisions
// expose bounded evidence suitable for model-selection trace metadata.

export const ADAPTIVE_ROUTING_VERSION = 1;
export const ADAPTIVE_ROUTING_DEFAULTS = Object.freeze({
  enabled: false,
  window_size: 8,
  min_samples: 2,
});

export const ADAPTIVE_ROUTING_REASON_CODES = Object.freeze({
  DISABLED: 'DISABLED',
  EXPLICIT_PRIORITY: 'EXPLICIT_PRIORITY',
  NO_ELIGIBLE_CANDIDATES: 'NO_ELIGIBLE_CANDIDATES',
  SINGLE_CANDIDATE: 'SINGLE_CANDIDATE',
  INSUFFICIENT_HISTORY: 'INSUFFICIENT_HISTORY',
  HEALTH_NEUTRAL: 'HEALTH_NEUTRAL',
  HEALTH_REORDERED: 'HEALTH_REORDERED',
  HEALTH_ORDER_UNCHANGED: 'HEALTH_ORDER_UNCHANGED',
});

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeAdaptiveRouting(raw = {}) {
  const windowSize = clampInteger(raw?.window_size, ADAPTIVE_ROUTING_DEFAULTS.window_size, 1, 32);
  return {
    enabled: raw?.enabled === true,
    window_size: windowSize,
    min_samples: clampInteger(raw?.min_samples, ADAPTIVE_ROUTING_DEFAULTS.min_samples, 1, windowSize),
  };
}

function normalizeRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  return provider && model ? { provider, model } : null;
}

function refKey(ref, role = 'worker') {
  const normalized = normalizeRef(ref);
  return normalized ? `${role === 'reviewer' ? 'reviewer' : 'worker'}\0${normalized.provider}\0${normalized.model}` : '';
}

function normalizeLatencyMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  // Bound pathological values; adaptive routing only needs a coarse signal.
  return Math.min(Math.round(n), 3_600_000);
}

function latencyBucket(samples) {
  const values = samples.map((sample) => sample.latency_ms).filter(Number.isFinite);
  if (values.length === 0) return 'unknown';
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (average <= 30_000) return 'fast';
  if (average <= 120_000) return 'medium';
  return 'slow';
}

function outcomeKind(observation = {}) {
  const stopReason = String(observation.stopReason ?? observation.stop_reason ?? '').toLowerCase();
  if (observation.timed_out === true || stopReason === 'timeout' || stopReason === 'timed_out') return 'timeout';
  const status = String(observation.status ?? '').toLowerCase();
  if (status === 'done' || status === 'success' || status === 'completed') return 'success';
  if (status === 'failed' || status === 'failure' || status === 'error') return 'failure';
  return null;
}

function healthScore(summary) {
  let score = summary.successes * 4 - summary.failures * 3 - summary.timeouts * 6;
  if (summary.latency_bucket === 'medium') score -= 1;
  else if (summary.latency_bucket === 'slow') score -= 2;
  return score;
}

export function createAdaptiveHealthStore({ maxSamples = 32 } = {}) {
  const limit = clampInteger(maxSamples, 32, 1, 32);
  const history = new Map();

  return {
    record(ref, observation = {}) {
      const key = refKey(ref, observation.role);
      const outcome = outcomeKind(observation);
      if (!key || !outcome) return false;
      const samples = history.get(key) ?? [];
      samples.push({
        outcome,
        latency_ms: normalizeLatencyMs(observation.latencyMs ?? observation.latency_ms),
      });
      if (samples.length > limit) samples.splice(0, samples.length - limit);
      history.set(key, samples);
      return true;
    },

    snapshot(ref, { role = 'worker', windowSize = ADAPTIVE_ROUTING_DEFAULTS.window_size } = {}) {
      const key = refKey(ref, role);
      const window = clampInteger(windowSize, ADAPTIVE_ROUTING_DEFAULTS.window_size, 1, 32);
      const samples = key ? (history.get(key) ?? []).slice(-window) : [];
      const summary = {
        samples: samples.length,
        successes: samples.filter((sample) => sample.outcome === 'success').length,
        failures: samples.filter((sample) => sample.outcome === 'failure').length,
        timeouts: samples.filter((sample) => sample.outcome === 'timeout').length,
        latency_bucket: latencyBucket(samples),
      };
      return { ...summary, score: healthScore(summary) };
    },

    clear() {
      history.clear();
    },
  };
}

// One bounded store per Node.js process. Hub routing and its entry wrapper share
// this module instance, so a completed opt-in Hub attempt can influence a later
// opt-in Hub selection without writing any persistent state. Process restart is
// intentionally the reset boundary.
const PROCESS_ADAPTIVE_HEALTH = createAdaptiveHealthStore();

export function getProcessAdaptiveHealthStore() {
  return PROCESS_ADAPTIVE_HEALTH;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const ref = normalizeRef(candidate);
    if (!ref) continue;
    const key = `${ref.provider}\0${ref.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function traceBase(config, reason, candidates = []) {
  return {
    version: ADAPTIVE_ROUTING_VERSION,
    enabled: config.enabled,
    decision_supported: false,
    applied: false,
    reason,
    window_size: config.window_size,
    min_samples: config.min_samples,
    candidates,
  };
}

/**
 * Stable health-based ordering for automatically derived candidates.
 *
 * Explicit user priority is a hard bypass: health never changes its order.
 * Candidates below min_samples are scored as neutral (0), allowing a mature
 * unhealthy candidate to yield to an unknown one without overreacting to a
 * single sample. Ties always retain baseline order.
 */
export function rankAdaptiveCandidates(candidates, {
  config: rawConfig,
  healthStore = PROCESS_ADAPTIVE_HEALTH,
  role = 'worker',
  explicitPriority = false,
} = {}) {
  const config = normalizeAdaptiveRouting(rawConfig);
  const baseline = uniqueCandidates(candidates);

  if (!config.enabled) {
    return { candidates: baseline, trace: traceBase(config, ADAPTIVE_ROUTING_REASON_CODES.DISABLED) };
  }
  if (explicitPriority) {
    return { candidates: baseline, trace: traceBase(config, ADAPTIVE_ROUTING_REASON_CODES.EXPLICIT_PRIORITY) };
  }
  if (baseline.length === 0) {
    return { candidates: baseline, trace: traceBase(config, ADAPTIVE_ROUTING_REASON_CODES.NO_ELIGIBLE_CANDIDATES) };
  }
  if (baseline.length === 1) {
    return { candidates: baseline, trace: traceBase(config, ADAPTIVE_ROUTING_REASON_CODES.SINGLE_CANDIDATE) };
  }

  const scored = baseline.map((candidate, baselineRank) => {
    const summary = healthStore?.snapshot?.(candidate, { role, windowSize: config.window_size }) ?? {
      samples: 0, successes: 0, failures: 0, timeouts: 0, latency_bucket: 'unknown', score: 0,
    };
    const mature = summary.samples >= config.min_samples;
    return {
      candidate,
      baselineRank,
      mature,
      effectiveScore: mature ? summary.score : 0,
      summary,
    };
  });

  const mature = scored.filter((entry) => entry.mature);
  if (mature.length === 0) {
    const candidatesTrace = scored.map((entry) => ({
      ...entry.candidate,
      baseline_rank: entry.baselineRank,
      adaptive_rank: entry.baselineRank,
      health_state: 'warming',
      samples: entry.summary.samples,
      successes: entry.summary.successes,
      failures: entry.summary.failures,
      timeouts: entry.summary.timeouts,
      latency_bucket: entry.summary.latency_bucket,
      score: null,
    }));
    return {
      candidates: baseline,
      trace: traceBase(config, ADAPTIVE_ROUTING_REASON_CODES.INSUFFICIENT_HISTORY, candidatesTrace),
    };
  }

  const hasSignal = mature.some((entry) => entry.effectiveScore !== 0);
  const ranked = [...scored].sort((a, b) => {
    if (a.effectiveScore !== b.effectiveScore) return b.effectiveScore - a.effectiveScore;
    return a.baselineRank - b.baselineRank;
  });
  const orderChanged = ranked.some((entry, index) => entry.baselineRank !== index);
  const rankByKey = new Map(ranked.map((entry, index) => [`${entry.candidate.provider}\0${entry.candidate.model}`, index]));
  const candidatesTrace = scored.map((entry) => ({
    ...entry.candidate,
    baseline_rank: entry.baselineRank,
    adaptive_rank: rankByKey.get(`${entry.candidate.provider}\0${entry.candidate.model}`),
    health_state: entry.mature ? 'mature' : 'warming',
    samples: entry.summary.samples,
    successes: entry.summary.successes,
    failures: entry.summary.failures,
    timeouts: entry.summary.timeouts,
    latency_bucket: entry.summary.latency_bucket,
    score: entry.mature ? entry.effectiveScore : null,
  }));

  if (!hasSignal) {
    return {
      candidates: baseline,
      trace: traceBase(config, ADAPTIVE_ROUTING_REASON_CODES.HEALTH_NEUTRAL, candidatesTrace),
    };
  }

  const trace = traceBase(
    config,
    orderChanged ? ADAPTIVE_ROUTING_REASON_CODES.HEALTH_REORDERED : ADAPTIVE_ROUTING_REASON_CODES.HEALTH_ORDER_UNCHANGED,
    candidatesTrace,
  );
  trace.decision_supported = true;
  trace.applied = orderChanged;
  return { candidates: ranked.map((entry) => entry.candidate), trace };
}
