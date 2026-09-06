// Stable extension-capability projection for GPT-first orchestrators. It
// describes only DSH Crew and deliberately never advertises itself as a top-
// level Executor or control plane.

import { isCompleteRuntimeIdentity, sameCompleteRuntimeIdentity } from './runtime-identity-contract.mjs';
import { MODEL_CALLABILITY_SCHEMA_VERSION } from './runtime-readiness-snapshot.mjs';

export const EXTENSION_CONTRACT_SCHEMA_VERSION = 1;

function row(matrix, id) {
  return Array.isArray(matrix?.rows) ? matrix.rows.find((entry) => entry?.id === id) : undefined;
}

function component(status, reasonCode, evidence = null) {
  return { status, reason_code: reasonCode, ...(evidence ? { evidence } : {}) };
}

function workspaceComponent(workspace) {
  if (workspace?.status === 'CONFLICT' || workspace?.status === 'READ_ONLY') {
    return { ...component('DEGRADED', workspace.reason_code ?? `WORKSPACE_${workspace.status}`), state: workspace.status };
  }
  if (workspace?.status === 'UNAVAILABLE') {
    return { ...component('UNAVAILABLE', workspace.reason_code ?? 'WORKSPACE_UNAVAILABLE'), state: 'UNAVAILABLE' };
  }
  if (workspace?.status === 'READY') {
    return { ...component('READY', workspace.reason_code ?? 'WORKSPACE_READY'), state: 'READY' };
  }
  return workspace?.ok === true
    ? { ...component('READY', workspace.context ? 'WORKSPACE_CONTEXT_RESOLVED' : 'WORKSPACE_CONTEXT_NOT_REQUESTED'), state: 'READY' }
    : { ...component('UNAVAILABLE', workspace?.code ?? 'WORKSPACE_NOT_CHECKED'), state: 'UNAVAILABLE' };
}

function readinessFromRow(entry, { pass = 'READY', notRun = 'DEGRADED' } = {}) {
  if (!entry) return component('UNAVAILABLE', 'NO_EVIDENCE');
  if (entry.status === 'PASS') return component(pass, entry.reason_code ?? 'CHECK_PASSED');
  if (entry.status === 'NOT_RUN' || entry.status === 'SKIP') return component(notRun, entry.reason_code ?? 'CHECK_NOT_RUN');
  return component('UNAVAILABLE', entry.reason_code ?? 'CHECK_FAILED');
}

function validProjectionIdentity(callability, runtime, now = Date.now()) {
  return callability && typeof callability === 'object' && callability.schema_version === MODEL_CALLABILITY_SCHEMA_VERSION
    && Number.isFinite(callability.captured_at) && callability.captured_at <= now
    && isCompleteRuntimeIdentity(callability.runtime_identity)
    && isCompleteRuntimeIdentity(runtime)
    && sameCompleteRuntimeIdentity(callability.runtime_identity, runtime)
    && callability.current_runtime_id === callability.runtime_identity.runtime_id;
}

function validCallableProjection(callability, runtime, now = Date.now()) {
  if (!validProjectionIdentity(callability, runtime, now)
    || !Number.isFinite(callability.expires_at) || callability.expires_at <= now
    || !callability.enabled_roles || typeof callability.enabled_roles !== 'object'
    || !callability.roles || typeof callability.roles !== 'object') return false;
  const allowedRoles = new Set(['worker', 'reviewer']);
  if (Object.keys(callability.enabled_roles).some((role) => !allowedRoles.has(role))
    || Object.keys(callability.roles).some((role) => !allowedRoles.has(role))) return false;
  const activeRoles = Object.entries(callability.enabled_roles).filter(([, enabled]) => enabled === true).map(([role]) => role);
  return activeRoles.length > 0
    && activeRoles.every((role) => callability.roles?.[role]?.state === 'CALLABLE')
    && Object.entries(callability.enabled_roles).every(([role, enabled]) => enabled === true || callability.roles?.[role]?.state === 'NOT_APPLICABLE');
}

function validNotCallableProjection(callability, runtime, now = Date.now()) {
  if (!validProjectionIdentity(callability, runtime, now)
    || !callability.enabled_roles || typeof callability.enabled_roles !== 'object'
    || !callability.roles || typeof callability.roles !== 'object') return false;
  const allowedRoles = new Set(['worker', 'reviewer']);
  if (Object.keys(callability.enabled_roles).some((role) => !allowedRoles.has(role))
    || Object.keys(callability.roles).some((role) => !allowedRoles.has(role))) return false;
  const activeRoles = Object.entries(callability.enabled_roles).filter(([, enabled]) => enabled === true).map(([role]) => role);
  return activeRoles.length > 0
    && activeRoles.some((role) => callability.roles?.[role]?.state === 'NOT_CALLABLE'
      && Number.isFinite(callability.roles?.[role]?.expires_at) && callability.roles[role].expires_at > now)
    && Object.entries(callability.enabled_roles).every(([role, enabled]) => enabled === true || callability.roles?.[role]?.state === 'NOT_APPLICABLE');
}

function modelReadinessFromSnapshot(readinessSnapshot, matrix, runtime, now = Date.now()) {
  const callability = readinessSnapshot?.model_callability;
  const providerHealthEvidence = row(matrix, 'provider_health');
  const catalogEvidence = row(matrix, 'provider_catalog');
  if (callability && typeof callability === 'object') {
    if (callability.overall === 'CALLABLE' && validCallableProjection(callability, runtime, now)) return component('READY', 'CURRENT_MODEL_CALLABLE', { captured_at: callability.captured_at, expires_at: callability.expires_at, runtime_id: callability.current_runtime_id });
    const enabledRoles = callability.enabled_roles && typeof callability.enabled_roles === 'object' ? callability.enabled_roles : {};
    const activeRoleNames = Object.entries(enabledRoles).filter(([, enabled]) => enabled === true).map(([name]) => name);
    const activeRoles = activeRoleNames.map((name) => callability.roles?.[name]).filter(Boolean);
    if (callability.overall === 'NOT_CALLABLE' && validNotCallableProjection(callability, runtime, now)) return component('UNAVAILABLE', activeRoles.find((role) => role?.state === 'NOT_CALLABLE')?.reason_code ?? 'CURRENT_MODEL_NOT_CALLABLE');
    if (!validProjectionIdentity(callability, runtime, now)) return component('DEGRADED', 'MODEL_CALLABILITY_NOT_CURRENT');
    if (callability.overall === 'STALE') return component('DEGRADED', 'MODEL_EVIDENCE_STALE');
    return component('DEGRADED', 'MODEL_CALLABILITY_UNKNOWN');
  }
  if (providerHealthEvidence?.status === 'FAIL') return readinessFromRow(providerHealthEvidence);
  if (catalogEvidence?.status === 'FAIL') return readinessFromRow(catalogEvidence);
  if (providerHealthEvidence || catalogEvidence) return component('DEGRADED', 'MODEL_CALLABILITY_NOT_PROJECTED');
  return component('UNAVAILABLE', 'MODEL_CALLABILITY_NOT_PROJECTED');
}

export function buildExtensionContract({ config = {}, readinessMatrix = {}, readinessSnapshot = null, workspace = null, profiles = null, runtime = null } = {}) {
  const matrix = readinessSnapshot?.readiness_matrix ?? readinessMatrix;
  const workerEnabled = config.subagents_enabled !== false && config.worker_state !== 'disabled';
  const reviewerEnabled = config.subagents_enabled !== false && config.review_state !== 'disabled';
  const reviewerHealthEvidence = row(matrix, 'reviewer_health');
  const lifecycleEvidence = row(matrix, 'provider_lifecycle_consistent');
  const modelReadiness = modelReadinessFromSnapshot(readinessSnapshot, matrix, runtime);
  const components = {
    harness: readinessFromRow(row(matrix, 'hub_compatibility')),
    provider_lifecycle: lifecycleEvidence
      ? readinessFromRow(lifecycleEvidence, { notRun: 'DEGRADED' })
      : component('DEGRADED', 'PROVIDER_LIFECYCLE_NOT_CHECKED'),
    model: modelReadiness,
    workspace: workspaceComponent(workspace),
    reviewer: reviewerEnabled
      ? reviewerHealthEvidence?.status === 'FAIL'
        ? readinessFromRow(reviewerHealthEvidence)
        : readinessFromRow(row(matrix, 'reviewer_pipeline'))
      : component('DEGRADED', 'REVIEWER_DISABLED'),
  };
  const states = Object.values(components).map((entry) => entry.status);
  const readiness = states.includes('UNAVAILABLE') ? 'UNAVAILABLE' : states.includes('DEGRADED') ? 'DEGRADED' : 'READY';
  return {
    schema_version: EXTENSION_CONTRACT_SCHEMA_VERSION,
    kind: 'dsh-crew-extension',
    runtime: runtime ?? null,
    ...(readinessSnapshot ? { readiness_snapshot: readinessSnapshot } : {}),
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
