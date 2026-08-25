// Stable extension-capability projection for GPT-first orchestrators. It
// describes only DSH Crew and deliberately never advertises itself as a top-
// level Executor or control plane.

export const EXTENSION_CONTRACT_SCHEMA_VERSION = 1;

function row(matrix, id) {
  return Array.isArray(matrix?.rows) ? matrix.rows.find((entry) => entry?.id === id) : undefined;
}

function component(status, reasonCode, evidence = null) {
  return { status, reason_code: reasonCode, ...(evidence ? { evidence } : {}) };
}

function readinessFromRow(entry, { pass = 'READY', notRun = 'DEGRADED' } = {}) {
  if (!entry) return component('UNAVAILABLE', 'NO_EVIDENCE');
  if (entry.status === 'PASS') return component(pass, entry.reason_code ?? 'CHECK_PASSED');
  if (entry.status === 'NOT_RUN' || entry.status === 'SKIP') return component(notRun, entry.reason_code ?? 'CHECK_NOT_RUN');
  return component('UNAVAILABLE', entry.reason_code ?? 'CHECK_FAILED');
}

export function buildExtensionContract({ config = {}, readinessMatrix = {}, workspace = null, profiles = null, runtime = null } = {}) {
  const workerEnabled = config.subagents_enabled !== false && config.worker_state !== 'disabled';
  const reviewerEnabled = config.subagents_enabled !== false && config.review_state !== 'disabled';
  const realModelEvidence = ['model_execution', 'deepseek_flash', 'deepseek_pro', 'opencode_go_mimo_qwen']
    .map((id) => row(readinessMatrix, id))
    .find((entry) => entry?.status === 'PASS');
  const catalogEvidence = row(readinessMatrix, 'provider_catalog');
  const modelReadiness = realModelEvidence
    ? component('READY', realModelEvidence.reason_code ?? 'MODEL_EXECUTION_PASSED')
    : catalogEvidence?.status === 'PASS' || catalogEvidence?.status === 'SKIP'
      ? component('DEGRADED', 'MODEL_CATALOG_ONLY')
      : component('UNAVAILABLE', catalogEvidence?.reason_code ?? 'NO_EVIDENCE');
  const components = {
    harness: readinessFromRow(row(readinessMatrix, 'hub_compatibility')),
    model: modelReadiness,
    workspace: workspace?.ok === true
      ? component('READY', workspace.context ? 'WORKSPACE_CONTEXT_RESOLVED' : 'WORKSPACE_CONTEXT_NOT_REQUESTED')
      : component('UNAVAILABLE', workspace?.code ?? 'WORKSPACE_NOT_CHECKED'),
    reviewer: reviewerEnabled
      ? readinessFromRow(row(readinessMatrix, 'reviewer_pipeline'))
      : component('DEGRADED', 'REVIEWER_DISABLED'),
  };
  const states = Object.values(components).map((entry) => entry.status);
  const readiness = states.includes('UNAVAILABLE') ? 'UNAVAILABLE' : states.includes('DEGRADED') ? 'DEGRADED' : 'READY';
  return {
    schema_version: EXTENSION_CONTRACT_SCHEMA_VERSION,
    kind: 'dsh-crew-extension',
    runtime: runtime ?? null,
    capabilities: {
      'deepseek.worker': workerEnabled,
      'deepseek.reviewer': reviewerEnabled,
      'worktree.isolation': true,
      'model.fallback': config.escalate_on_failure === true,
      'job.cancel': true,
      'job.watch': true,
      'job.resume': false,
      'result.evidence': true,
      'events.canonical': true,
      'profiles.roles': profiles?.ok === true,
      'workspace.context': true,
    },
    readiness: { status: readiness, components },
  };
}
