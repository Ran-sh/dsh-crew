// Single, bounded readiness projection shared by the Hub extension surface,
// MCP diagnostics and the client. It consumes already-collected evidence and
// never performs I/O or carries raw task/result/error/credential content.

const MAX_HEALTH = 128;

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

export function buildRuntimeReadinessSnapshot({
  runtime = null,
  readinessMatrix = null,
  selections = {},
  health = [],
  jobs = [],
  workspace = null,
} = {}) {
  const projectedHealth = (Array.isArray(health) ? health : []).map(projectHealth).filter(Boolean).slice(0, MAX_HEALTH);
  const projectedJobs = Array.isArray(jobs) ? jobs : [];
  const verified = projectedJobs.filter((job) => job?.status === 'done' && job?.task_status === 'success' && job?.delivery_complete === true).length;
  const workerJobs = projectedJobs.filter((job) => job?.role === 'worker').length;
  const reviewerJobs = projectedJobs.filter((job) => job?.role === 'reviewer').length;
  const workerSelection = projectSelection(selections.worker ?? selections.flash);
  const reviewerSelection = projectSelection(selections.reviewer ?? selections.pro);
  return {
    schema_version: 1,
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
  };
}
