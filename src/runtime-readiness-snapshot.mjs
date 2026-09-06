// Single, bounded readiness projection shared by the Hub extension surface,
// MCP diagnostics and the client. It consumes already-collected evidence and
// never performs I/O or carries raw task/result/error/credential content.

const MAX_HEALTH = 128;
const DEFAULT_EXECUTION_EVIDENCE_TTL_MS = 5 * 60 * 1000;

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }

function projectRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') return null;
  return {
    execution_plane: text(runtime.execution_plane),
    profile: text(runtime.profile),
    listen_port: Number.isFinite(Number(runtime.listen_port)) ? Number(runtime.listen_port) : null,
    runtime_id: text(runtime.runtime_id),
  };
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

function projectModelRole({ role, selected, health, jobs, runtime, now, executionEvidenceTtlMs }) {
  const route = routeKey(selected);
  if (!route || !runtime?.runtime_id) return { state: 'UNKNOWN', reason_code: 'MODEL_ROUTE_UNAVAILABLE', selected: selected ?? null, last_success: null };
  const matchingHealth = (Array.isArray(health) ? health : []).find((entry) => routeKey(entry) === route);
  const expiresAt = Number.isFinite(matchingHealth?.expires_at) ? matchingHealth.expires_at : null;
  const healthCurrent = matchingHealth && matchingHealth.fresh === true && (expiresAt === null || expiresAt > now);
  if (healthCurrent && matchingHealth.state !== 'callable') {
    return { state: 'NOT_CALLABLE', reason_code: matchingHealth.reason_code ?? 'PROVIDER_ROUTE_UNCALLABLE', selected, observed_at: matchingHealth.observed_at ?? null, expires_at: expiresAt, source: 'provider_health', last_success: null };
  }
  if (healthCurrent && matchingHealth.state === 'callable') {
    return { state: 'CALLABLE', reason_code: matchingHealth.reason_code ?? 'PROVIDER_CALLABLE', selected, observed_at: matchingHealth.observed_at ?? null, expires_at: expiresAt, source: 'provider_health', last_success: null };
  }
  if (matchingHealth && expiresAt !== null && expiresAt <= now) {
    return { state: 'STALE', reason_code: 'PROVIDER_HEALTH_EXPIRED', selected, observed_at: matchingHealth.observed_at ?? null, expires_at: expiresAt, source: 'provider_health', last_success: null };
  }
  const completed = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.role === role && job?.provider === selected.provider && job?.model === selected.model
      && job?.status === 'done' && job?.task_status === 'success'
      && job?.execution_context?.runtime_id === runtime.runtime_id)
    .map((job) => ({ job, endedAt: Date.parse(job.endedAt ?? '') }))
    .filter(({ endedAt }) => Number.isFinite(endedAt))
    .sort((a, b) => b.endedAt - a.endedAt)[0];
  if (completed) {
    const expires = completed.endedAt + executionEvidenceTtlMs;
    const lastSuccess = { observed_at: completed.endedAt, expires_at: expires, job_id: completed.job.id };
    if (expires > now) return { state: 'CALLABLE', reason_code: 'RECENT_EXECUTION_PASSED', selected, observed_at: completed.endedAt, expires_at: expires, source: 'execution', last_success: lastSuccess };
    return { state: 'STALE', reason_code: 'EXECUTION_EVIDENCE_EXPIRED', selected, observed_at: completed.endedAt, expires_at: expires, source: 'execution', last_success: lastSuccess };
  }
  return { state: 'UNKNOWN', reason_code: 'NO_CURRENT_MODEL_EVIDENCE', selected, last_success: null };
}

export function projectModelCallability({ runtime = null, selections = {}, health = [], jobs = [], now = Date.now(), execution_evidence_ttl_ms = DEFAULT_EXECUTION_EVIDENCE_TTL_MS } = {}) {
  const roles = {
    worker: projectModelRole({ role: 'worker', selected: selections.worker ?? selections.flash, health, jobs, runtime, now, executionEvidenceTtlMs: execution_evidence_ttl_ms }),
    reviewer: projectModelRole({ role: 'reviewer', selected: selections.reviewer ?? selections.pro, health, jobs, runtime, now, executionEvidenceTtlMs: execution_evidence_ttl_ms }),
  };
  const states = Object.values(roles).map((role) => role.state);
  const overall = states.includes('NOT_CALLABLE') ? 'NOT_CALLABLE' : states.every((state) => state === 'CALLABLE') ? 'CALLABLE' : states.some((state) => state === 'STALE') ? 'STALE' : 'UNKNOWN';
  const expirations = Object.values(roles)
    .map((role) => role?.expires_at)
    .filter((value) => Number.isFinite(value));
  return {
    schema_version: 1,
    captured_at: now,
    expires_at: expirations.length ? Math.min(...expirations) : null,
    current_runtime_id: runtime?.runtime_id ?? null,
    execution_evidence_ttl_ms,
    overall,
    roles,
  };
}

export function buildRuntimeReadinessSnapshot({
  runtime = null,
  readinessMatrix = null,
  selections = {},
  health = [],
  jobs = [],
  workspace = null,
  now = Date.now(),
} = {}) {
  const projectedHealth = (Array.isArray(health) ? health : []).map(projectHealth).filter(Boolean).slice(0, MAX_HEALTH);
  const projectedJobs = Array.isArray(jobs) ? jobs : [];
  const verified = projectedJobs.filter((job) => job?.status === 'done' && job?.task_status === 'success' && job?.delivery_complete === true).length;
  const workerJobs = projectedJobs.filter((job) => job?.role === 'worker').length;
  const reviewerJobs = projectedJobs.filter((job) => job?.role === 'reviewer').length;
  const workerSelection = projectSelection(selections.worker ?? selections.flash);
  const reviewerSelection = projectSelection(selections.reviewer ?? selections.pro);
  const modelCallability = projectModelCallability({ runtime, selections: { worker: workerSelection, reviewer: reviewerSelection }, health: projectedHealth, jobs: projectedJobs, now });
  return {
    schema_version: 1,
    captured_at: now,
    expires_at: modelCallability.expires_at,
    runtime: projectRuntime(runtime),
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
