// Single, bounded readiness projection shared by the Hub extension surface,
// MCP diagnostics and the client. It consumes already-collected evidence and
// never performs I/O or carries raw task/result/error/credential content.

import { isCompleteRuntimeIdentity, isExactNativeCrewIdentity, sameCompleteRuntimeIdentity } from './runtime-identity-contract.mjs';
import { MODEL_CALLABILITY_SCHEMA_VERSION } from './model-callability-contract.mjs';

const MAX_HEALTH = 128;
const DEFAULT_EXECUTION_EVIDENCE_TTL_MS = 5 * 60 * 1000;
const MIN_EXECUTION_EVIDENCE_TTL_MS = 1_000;
const MAX_EXECUTION_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }

function projectRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') return null;
  return {
    execution_plane: text(runtime.execution_plane),
    profile: text(runtime.profile),
    listen_port: Number.isInteger(runtime.listen_port) ? runtime.listen_port : null,
    runtime_id: text(runtime.runtime_id),
  };
}

function runtimeIdentity(runtime) {
  return isExactNativeCrewIdentity(runtime)
    ? {
        execution_plane: runtime.execution_plane,
        profile: runtime.profile,
        listen_port: runtime.listen_port,
        runtime_id: runtime.runtime_id,
      }
    : null;
}

function projectSelection(value) {
  if (!value || typeof value !== 'object') return null;
  const provider = text(value.provider);
  const model = text(value.model);
  if (!provider || !model) return null;
  return { provider, model, ...(text(value.source) ? { source: text(value.source) } : {}) };
}

function projectHealth(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const provider = text(entry.provider);
  const model = text(entry.model);
  const state = text(entry.state);
  if (!provider || !model || !state) return null;
  return {
    provider,
    model,
    state,
    ...(text(entry.reason_code) ? { reason_code: text(entry.reason_code) } : {}),
    ...(Number.isFinite(entry.observed_at) ? { observed_at: entry.observed_at } : {}),
    ...(Number.isFinite(entry.expires_at) ? { expires_at: entry.expires_at } : {}),
    fresh: entry.fresh === true,
  };
}

function matrixRow(matrix, id) {
  return Array.isArray(matrix?.rows) ? matrix.rows.find((row) => row?.id === id) ?? null : null;
}

function projectWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object') return null;
  return {
    ...(text(workspace.status) ? { status: text(workspace.status) } : {}),
    ...(text(workspace.reason_code) ? { reason_code: text(workspace.reason_code) } : {}),
  };
}

function routeKey(value) {
  return value?.provider && value?.model ? `${value.provider}\u0000${value.model}` : null;
}

function normalizeExecutionEvidenceTtl(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_EXECUTION_EVIDENCE_TTL_MS) return DEFAULT_EXECUTION_EVIDENCE_TTL_MS;
  return Math.min(Math.floor(parsed), MAX_EXECUTION_EVIDENCE_TTL_MS);
}

function projectModelRole({ role, selected, health, jobs, runtime, now, executionEvidenceTtlMs, enabled }) {
  if (enabled === false) return { state: 'NOT_APPLICABLE', reason_code: 'ROLE_DISABLED', selected: selected ?? null, last_success: null };
  const route = routeKey(selected);
  if (!route || !isExactNativeCrewIdentity(runtime)) return { state: 'UNKNOWN', reason_code: 'MODEL_ROUTE_UNAVAILABLE', selected: selected ?? null, last_success: null };
  const matchingHealth = (Array.isArray(health) ? health : [])
    .filter((entry) => routeKey(entry) === route)
    .sort((left, right) => {
      const observedDelta = (Number(right?.observed_at) || 0) - (Number(left?.observed_at) || 0);
      if (observedDelta !== 0) return observedDelta;
      if (left?.state === 'callable' && right?.state !== 'callable') return 1;
      if (left?.state !== 'callable' && right?.state === 'callable') return -1;
      return 0;
    })[0];
  const expiresAt = Number.isFinite(matchingHealth?.expires_at) ? matchingHealth.expires_at : null;
  const observedAt = Number.isFinite(matchingHealth?.observed_at) ? matchingHealth.observed_at : null;
  if (matchingHealth) {
    if (observedAt === null || observedAt > now || expiresAt === null || expiresAt <= now
      || expiresAt - observedAt > MAX_EXECUTION_EVIDENCE_TTL_MS) {
      return { state: 'STALE', reason_code: 'PROVIDER_HEALTH_STALE_OR_INVALID', selected, observed_at: observedAt, expires_at: expiresAt, source: 'provider_health', last_success: null };
    }
  }
  const healthCurrent = matchingHealth && matchingHealth.fresh === true;
  if (healthCurrent && matchingHealth.state !== 'callable') {
    return { state: 'NOT_CALLABLE', reason_code: matchingHealth.reason_code ?? 'PROVIDER_ROUTE_UNCALLABLE', selected, observed_at: matchingHealth.observed_at ?? null, expires_at: expiresAt, source: 'provider_health', last_success: null };
  }
  if (healthCurrent && matchingHealth.state === 'callable') {
    return { state: 'CALLABLE', reason_code: matchingHealth.reason_code ?? 'PROVIDER_CALLABLE', selected, observed_at: matchingHealth.observed_at ?? null, expires_at: expiresAt, source: 'provider_health', last_success: null };
  }
  const completed = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.role === role && job?.provider === selected.provider && job?.model === selected.model
      && job?.status === 'done' && job?.task_status === 'success'
      && sameCompleteRuntimeIdentity(job.execution_context, runtime))
    .map((job) => ({ job, endedAt: Date.parse(job.endedAt ?? '') }))
    .filter(({ endedAt }) => Number.isFinite(endedAt))
    .sort((a, b) => b.endedAt - a.endedAt)[0];
  if (completed) {
    const expires = completed.endedAt + executionEvidenceTtlMs;
    const lastSuccess = { observed_at: completed.endedAt, expires_at: expires, job_id: completed.job.id };
    if (completed.endedAt > now) return { state: 'STALE', reason_code: 'EXECUTION_EVIDENCE_FUTURE_DATED', selected, observed_at: completed.endedAt, expires_at: expires, source: 'execution', last_success: lastSuccess };
    if (expires > now) return { state: 'CALLABLE', reason_code: 'RECENT_EXECUTION_PASSED', selected, observed_at: completed.endedAt, expires_at: expires, source: 'execution', last_success: lastSuccess };
    return { state: 'STALE', reason_code: 'EXECUTION_EVIDENCE_EXPIRED', selected, observed_at: completed.endedAt, expires_at: expires, source: 'execution', last_success: lastSuccess };
  }
  return { state: 'UNKNOWN', reason_code: 'NO_CURRENT_MODEL_EVIDENCE', selected, last_success: null };
}

export function projectModelCallability({ runtime = null, selections = {}, health = [], health_status = 'AVAILABLE', jobs = [], now = Date.now(), execution_evidence_ttl_ms = DEFAULT_EXECUTION_EVIDENCE_TTL_MS, enabled_roles = {} } = {}) {
  const ttl = normalizeExecutionEvidenceTtl(execution_evidence_ttl_ms);
  const enabledRoles = {
    worker: enabled_roles?.worker !== false,
    reviewer: enabled_roles?.reviewer !== false,
  };
  const roles = {
    worker: projectModelRole({ role: 'worker', selected: selections.worker ?? selections.flash, health, jobs, runtime, now, executionEvidenceTtlMs: ttl, enabled: enabledRoles.worker }),
    reviewer: projectModelRole({ role: 'reviewer', selected: selections.reviewer ?? selections.pro, health, jobs, runtime, now, executionEvidenceTtlMs: ttl, enabled: enabledRoles.reviewer }),
  };
  if (health_status !== 'AVAILABLE') {
    for (const [name, enabled] of Object.entries(enabledRoles)) {
      if (enabled) roles[name] = { ...roles[name], state: 'UNKNOWN', reason_code: 'PROVIDER_HEALTH_UNAVAILABLE', source: 'provider_health' };
    }
  }
  const states = Object.entries(roles).filter(([name]) => enabledRoles[name]).map(([, role]) => role.state);
  const overall = states.length === 0 ? 'UNKNOWN'
    : states.includes('NOT_CALLABLE') ? 'NOT_CALLABLE'
      : states.every((state) => state === 'CALLABLE') ? 'CALLABLE'
        : states.some((state) => state === 'STALE') ? 'STALE' : 'UNKNOWN';
  const expirations = Object.values(roles)
    .map((role) => role?.expires_at)
    .filter((value) => Number.isFinite(value));
  return {
    schema_version: MODEL_CALLABILITY_SCHEMA_VERSION,
    captured_at: now,
    expires_at: expirations.length ? Math.min(...expirations) : null,
    current_runtime_id: runtime?.runtime_id ?? null,
    runtime_identity: runtimeIdentity(runtime),
    execution_evidence_ttl_ms: ttl,
    enabled_roles: enabledRoles,
    overall,
    roles,
  };
}

export function buildRuntimeReadinessSnapshot({
  runtime = null,
  readinessMatrix = null,
  selections = {},
  health = [],
  health_status = null,
  jobs = [],
  workspace = null,
  enabled_roles = {},
  now = Date.now(),
} = {}) {
  const healthObservations = Array.isArray(health) ? health : (Array.isArray(health?.observations) ? health.observations : []);
  const resolvedHealthStatus = health_status
    ?? (health && !Array.isArray(health) ? health.status : null)
    ?? (Array.isArray(health) && health.length > 0 ? 'AVAILABLE' : 'UNKNOWN');
  const projectedHealth = healthObservations.map(projectHealth).filter(Boolean).slice(0, MAX_HEALTH);
  const projectedJobs = Array.isArray(jobs) ? jobs : [];
  const verified = projectedJobs.filter((job) => job?.status === 'done' && job?.task_status === 'success' && job?.delivery_complete === true).length;
  const workerJobs = projectedJobs.filter((job) => job?.role === 'worker').length;
  const reviewerJobs = projectedJobs.filter((job) => job?.role === 'reviewer').length;
  const workerSelection = projectSelection(selections.worker ?? selections.flash);
  const reviewerSelection = projectSelection(selections.reviewer ?? selections.pro);
  const modelCallability = projectModelCallability({ runtime, selections: { worker: workerSelection, reviewer: reviewerSelection }, health: projectedHealth, health_status: resolvedHealthStatus, jobs: projectedJobs, enabled_roles, now });
  return {
    schema_version: 1,
    captured_at: now,
    expires_at: modelCallability.expires_at,
    health_status: resolvedHealthStatus,
    runtime: projectRuntime(runtime),
    runtime_identity: runtimeIdentity(runtime),
    readiness_matrix: readinessMatrix && typeof readinessMatrix === 'object' ? structuredClone(readinessMatrix) : null,
    provider_lifecycle: matrixRow(readinessMatrix, 'provider_lifecycle_consistent'),
    health: projectedHealth,
    worker: { selected: workerSelection, health: projectedHealth.filter((entry) => entry.provider === workerSelection?.provider && entry.model === workerSelection?.model) },
    reviewer: { selected: reviewerSelection, health: projectedHealth.filter((entry) => entry.provider === reviewerSelection?.provider && entry.model === reviewerSelection?.model) },
    historical_evidence: {
      job_count: projectedJobs.length,
      verified_job_count: verified,
      worker_job_count: workerJobs,
      reviewer_job_count: reviewerJobs,
    },
    workspace: projectWorkspace(workspace),
    model_callability: modelCallability,
  };
}

/** Re-project a Hub snapshot when the MCP session changes role enablement. */
export function reprojectRuntimeModelCallability(snapshot, { enabled_roles = {}, now = Date.now() } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const retainedExpiry = {};
  const historicalJobs = Object.entries({ worker: snapshot.worker, reviewer: snapshot.reviewer })
    .filter(([role, value]) => enabled_roles?.[role] !== false && value?.selected?.provider && value?.selected?.model)
    .map(([role, value]) => {
      const evidence = snapshot.model_callability?.roles?.[role];
      const lastSuccess = evidence?.source === 'execution' && evidence?.state === 'CALLABLE' ? evidence.last_success : null;
      if (!lastSuccess || !Number.isFinite(lastSuccess.observed_at)
        || !Number.isFinite(lastSuccess.expires_at) || lastSuccess.expires_at <= now || lastSuccess.observed_at > now
        || !isExactNativeCrewIdentity(snapshot.runtime)
        || !sameCompleteRuntimeIdentity(snapshot.runtime, snapshot.model_callability?.runtime_identity)
        || !sameCompleteRuntimeIdentity(snapshot.runtime, evidence.runtime_identity ?? snapshot.model_callability.runtime_identity)
        || !sameCompleteRuntimeIdentity(snapshot.runtime, evidence.selected_runtime_identity ?? snapshot.runtime)
        || !evidence.selected?.provider || !evidence.selected?.model
        || evidence.selected.provider !== value.selected.provider || evidence.selected.model !== value.selected.model
        || lastSuccess.observed_at !== evidence.observed_at || lastSuccess.expires_at !== evidence.expires_at) return null;
      retainedExpiry[role] = lastSuccess.expires_at;
      return {
        id: lastSuccess.job_id ?? `reprojected-${role}`,
        role,
        provider: value.selected.provider,
        model: value.selected.model,
        status: 'done',
        task_status: 'success',
        endedAt: new Date(lastSuccess.observed_at).toISOString(),
        execution_context: snapshot.runtime,
      };
    }).filter(Boolean);
  const projected = projectModelCallability({
    runtime: snapshot.runtime,
    selections: { worker: snapshot.worker?.selected, reviewer: snapshot.reviewer?.selected },
    health: snapshot.health ?? [],
    health_status: snapshot.health_status ?? 'UNKNOWN',
    jobs: historicalJobs,
    enabled_roles,
    now,
  });
  for (const [role, expiry] of Object.entries(retainedExpiry)) {
    if (projected.roles?.[role]?.source === 'execution' && Number.isFinite(projected.roles[role].expires_at)) {
      projected.roles[role].expires_at = Math.min(projected.roles[role].expires_at, expiry);
      if (projected.roles[role].last_success) projected.roles[role].last_success.expires_at = Math.min(projected.roles[role].last_success.expires_at, expiry);
    }
  }
  const expirations = Object.values(projected.roles).map((role) => role?.expires_at).filter((value) => Number.isFinite(value));
  projected.expires_at = expirations.length ? Math.min(...expirations) : null;
  return projected;
}
