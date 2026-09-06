// Single, bounded readiness projection shared by the Hub extension surface,
// MCP diagnostics and the client. It consumes already-collected evidence and
// never performs I/O or carries raw task/result/error/credential content.

import { isCompleteRuntimeIdentity, isExactNativeCrewIdentity, sameCompleteRuntimeIdentity } from './runtime-identity-contract.mjs';
import { MODEL_CALLABILITY_SCHEMA_VERSION, validateModelCallabilityV2 } from './model-callability-contract.mjs';

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
  const projectedHealthAll = healthObservations.map(projectHealth).filter(Boolean);
  const projectedJobs = Array.isArray(jobs) ? jobs : [];
  const verified = projectedJobs.filter((job) => job?.status === 'done' && job?.task_status === 'success' && job?.delivery_complete === true).length;
  const workerJobs = projectedJobs.filter((job) => job?.role === 'worker').length;
  const reviewerJobs = projectedJobs.filter((job) => job?.role === 'reviewer').length;
  const workerSelection = projectSelection(selections.worker ?? selections.flash);
  const reviewerSelection = projectSelection(selections.reviewer ?? selections.pro);
  const selectedRoutes = [workerSelection, reviewerSelection].filter(Boolean);
  const selectedHealth = selectedRoutes.map((selection) => projectedHealthAll
    .filter((entry) => entry.provider === selection.provider && entry.model === selection.model)
    .sort((left, right) => (right.observed_at ?? 0) - (left.observed_at ?? 0))[0]).filter(Boolean);
  const selectedKeys = new Set(selectedHealth.map((entry) => `${entry.provider}\u0000${entry.model}`));
  const projectedHealth = [...selectedHealth, ...projectedHealthAll
    .filter((entry) => !selectedKeys.has(`${entry.provider}\u0000${entry.model}`))]
    .slice(0, MAX_HEALTH);
  const modelCallability = projectModelCallability({ runtime, selections: { worker: workerSelection, reviewer: reviewerSelection }, health: projectedHealthAll, health_status: resolvedHealthStatus, jobs: projectedJobs, enabled_roles, now });
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
  const sourceProjection = snapshot.model_callability;
  const sourceValidation = validateModelCallabilityV2({
    projection: sourceProjection,
    runtime: snapshot.runtime,
    expectedEnabledRoles: sourceProjection?.enabled_roles,
    expectedSelections: { worker: snapshot.worker?.selected ?? null, reviewer: snapshot.reviewer?.selected ?? null },
    now,
  });
  if (!sourceValidation.ok) {
    return projectModelCallability({
      runtime: snapshot.runtime,
      selections: { worker: snapshot.worker?.selected, reviewer: snapshot.reviewer?.selected },
      health: [],
      health_status: 'UNAVAILABLE',
      jobs: [],
      enabled_roles,
      now,
    });
  }
  const roles = {};
  for (const role of ['worker', 'reviewer']) {
    if (enabled_roles?.[role] === false) {
      roles[role] = { state: 'NOT_APPLICABLE', reason_code: 'ROLE_DISABLED', selected: null, last_success: null };
    } else if (sourceProjection.enabled_roles?.[role] === true) {
      roles[role] = structuredClone(sourceProjection.roles[role]);
    } else {
      roles[role] = { state: 'UNKNOWN', reason_code: 'ROLE_EVIDENCE_NOT_ENABLED', selected: snapshot[role]?.selected ?? null, last_success: null };
    }
  }
  const activeStates = Object.entries(roles).filter(([role]) => enabled_roles?.[role] === true).map(([, role]) => role.state);
  const overall = activeStates.includes('NOT_CALLABLE') ? 'NOT_CALLABLE'
    : activeStates.length > 0 && activeStates.every((state) => state === 'CALLABLE') ? 'CALLABLE'
      : activeStates.includes('STALE') ? 'STALE' : 'UNKNOWN';
  const expirations = Object.values(roles).map((role) => role?.expires_at).filter((value) => Number.isFinite(value));
  const projected = {
    ...structuredClone(sourceProjection),
    captured_at: now,
    enabled_roles: { worker: enabled_roles.worker === true, reviewer: enabled_roles.reviewer === true },
    roles,
    overall,
    expires_at: expirations.length ? Math.min(...expirations) : null,
  };
  const validation = validateModelCallabilityV2({
    projection: projected,
    runtime: snapshot.runtime,
    expectedEnabledRoles: projected.enabled_roles,
    expectedSelections: {
      worker: enabled_roles.worker === true ? snapshot.worker?.selected ?? null : null,
      reviewer: enabled_roles.reviewer === true ? snapshot.reviewer?.selected ?? null : null,
    },
    now,
  });
  if (!validation.ok) {
    return projectModelCallability({
      runtime: snapshot.runtime,
      selections: { worker: snapshot.worker?.selected, reviewer: snapshot.reviewer?.selected },
      health: [],
      health_status: 'UNAVAILABLE',
      jobs: [],
      enabled_roles,
      now,
    });
  }
  return projected;
}
