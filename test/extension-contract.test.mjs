import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtensionContract } from '../src/extension-contract.mjs';
import { buildRuntimeReadinessSnapshot } from '../src/runtime-readiness-snapshot.mjs';

function callableSnapshot({ reviewer = false } = {}) {
  const now = Date.now();
  const runtime = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' };
  return {
    model_callability: {
      schema_version: 2,
      captured_at: now,
      expires_at: now + 60_000,
      current_runtime_id: 'runtime-1',
      runtime_identity: runtime,
      enabled_roles: { worker: true, reviewer },
      roles: {
        worker: { state: 'CALLABLE', reason_code: 'RECENT_EXECUTION_PASSED', selected: { provider: 'p', model: 'worker' }, source: 'execution', observed_at: now - 1_000, expires_at: now + 60_000, last_success: { job_id: 'job-worker', observed_at: now - 1_000, expires_at: now + 60_000 } },
        reviewer: reviewer ? { state: 'CALLABLE', reason_code: 'RECENT_EXECUTION_PASSED', selected: { provider: 'p', model: 'reviewer' }, source: 'execution', observed_at: now - 1_000, expires_at: now + 60_000, last_success: { job_id: 'job-reviewer', observed_at: now - 1_000, expires_at: now + 60_000 } } : { state: 'NOT_APPLICABLE', reason_code: 'ROLE_DISABLED' },
      },
      overall: 'CALLABLE',
    },
  };
}

test('extension contract exposes only Crew capabilities and conservative readiness', () => {
  const contract = buildExtensionContract({
    config: { subagents_enabled: true, worker_state: 'auto', review_state: 'manual', isolation: 'worktree', escalate_on_failure: true },
    readinessMatrix: { rows: [
      { id: 'hub_compatibility', status: 'PASS', reason_code: 'LIVE_CHECK_PASSED' },
      { id: 'provider_catalog', status: 'PASS', reason_code: 'PROVIDER_CATALOG_RESOLVED' },
      { id: 'reviewer_pipeline', status: 'NOT_RUN', reason_code: 'NO_EXECUTION_EVIDENCE' },
    ] },
    workspace: { ok: true, context: { workspace_id: 'demo', repo_root: 'D:/repo' } },
  });
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.kind, 'dsh-crew-extension');
  assert.equal(contract.capabilities['deepseek.worker'], true);
  assert.equal(contract.capabilities['deepseek.reviewer'], true);
  assert.equal(contract.capabilities['job.resume'], false);
  assert.equal(contract.capabilities['executor.dispatch'], undefined);
  assert.equal(contract.readiness.components.harness.status, 'READY');
  assert.equal(contract.readiness.components.model.status, 'DEGRADED');
  assert.equal(contract.readiness.components.model.reason_code, 'MODEL_CALLABILITY_NOT_PROJECTED');
  assert.equal(contract.readiness.components.reviewer.status, 'DEGRADED');
  assert.equal(contract.readiness.status, 'DEGRADED');
});

test('missing readiness evidence never becomes READY', () => {
  const contract = buildExtensionContract({ config: {}, readinessMatrix: { rows: [] } });
  assert.equal(contract.readiness.status, 'UNAVAILABLE');
  assert.equal(contract.readiness.components.harness.status, 'UNAVAILABLE');
  assert.equal(contract.readiness.components.model.status, 'UNAVAILABLE');
});

test('real generic execution evidence proves the selected model and disabled optional review only degrades', () => {
  const contract = buildExtensionContract({
    config: { subagents_enabled: true, worker_state: 'auto', review_state: 'disabled' },
    runtime: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' },
    readinessMatrix: { rows: [
      { id: 'hub_compatibility', status: 'PASS', reason_code: 'LIVE_CHECK_PASSED' },
      { id: 'model_execution', status: 'PASS', reason_code: 'REAL_EXECUTION_PASSED' },
    ] },
    readinessSnapshot: callableSnapshot(),
    workspace: { ok: true, context: null },
  });
  assert.equal(contract.readiness.components.model.status, 'READY');
  assert.equal(contract.readiness.components.reviewer.status, 'NOT_APPLICABLE');
  assert.equal(contract.readiness.status, 'DEGRADED');
});

test('dynamic primary callability evidence is accepted without provider-specific release ids', () => {
  const contract = buildExtensionContract({
    config: { subagents_enabled: true, worker_state: 'auto', review_state: 'disabled' },
    runtime: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' },
    readinessMatrix: { rows: [
      { id: 'hub_compatibility', status: 'PASS', reason_code: 'LIVE_CHECK_PASSED' },
      { id: 'provider_catalog', status: 'PASS', reason_code: 'PROVIDER_CATALOG_RESOLVED' },
      { id: 'worker_primary_callable', status: 'PASS', reason_code: 'WORKER_PRIMARY_CALLABLE' },
    ] },
    readinessSnapshot: callableSnapshot(),
    workspace: { ok: true, context: null },
  });
  assert.equal(contract.readiness.components.model.status, 'READY');
  assert.equal(contract.readiness.components.model.reason_code, 'CURRENT_MODEL_CALLABLE');
});

test('current provider catalog FAIL is not masked by historical model execution PASS', () => {
  const contract = buildExtensionContract({
    config: { subagents_enabled: true, worker_state: 'auto', review_state: 'disabled' },
    readinessMatrix: { rows: [
      { id: 'hub_compatibility', status: 'PASS', reason_code: 'LIVE_CHECK_PASSED' },
      { id: 'provider_catalog', status: 'FAIL', reason_code: 'PROVIDER_CATALOG_UNAVAILABLE' },
      { id: 'model_execution', status: 'PASS', reason_code: 'REAL_EXECUTION_PASSED' },
    ] },
    workspace: { ok: true, context: null },
  });
  assert.equal(contract.readiness.components.model.status, 'UNAVAILABLE');
  assert.equal(contract.readiness.components.model.reason_code, 'PROVIDER_CATALOG_UNAVAILABLE');
  assert.equal(contract.readiness.status, 'UNAVAILABLE');
});

test('historical model execution PASS is not a current callability projection', () => {
  const contract = buildExtensionContract({
    config: { subagents_enabled: true, worker_state: 'auto', review_state: 'disabled' },
    readinessMatrix: { rows: [
      { id: 'hub_compatibility', status: 'PASS', reason_code: 'LIVE_CHECK_PASSED' },
      { id: 'provider_catalog', status: 'SKIP', reason_code: 'PROVIDER_CATALOG_NOT_REQUIRED' },
      { id: 'model_execution', status: 'PASS', reason_code: 'REAL_EXECUTION_PASSED' },
    ] },
    workspace: { ok: true, context: null },
  });
  assert.equal(contract.readiness.components.model.status, 'DEGRADED');
  assert.equal(contract.readiness.components.model.reason_code, 'MODEL_CALLABILITY_NOT_PROJECTED');
  assert.equal(contract.readiness.status, 'DEGRADED');
});

test('workspace conflict and read-only states remain machine-visible', () => {
  for (const status of ['CONFLICT', 'READ_ONLY']) {
    const contract = buildExtensionContract({
      readinessMatrix: { rows: [] },
      workspace: { status, reason_code: `WORKSPACE_${status}` },
    });
    assert.equal(contract.readiness.components.workspace.state, status);
    assert.equal(contract.readiness.components.workspace.status, 'DEGRADED');
  }
});

test('fresh current-route health failures are not masked by historical success', () => {
  const contract = buildExtensionContract({
    config: { subagents_enabled: true, worker_state: 'auto', review_state: 'manual' },
    readinessMatrix: { rows: [
      { id: 'hub_compatibility', status: 'PASS', reason_code: 'LIVE_CHECK_PASSED' },
      { id: 'provider_catalog', status: 'PASS', reason_code: 'PROVIDER_CATALOG_RESOLVED' },
      { id: 'provider_lifecycle_consistent', status: 'PASS', reason_code: 'PROVIDER_LIFECYCLE_CONSISTENT' },
      { id: 'provider_health', status: 'FAIL', reason_code: 'PROVIDER_ROUTE_UNCALLABLE' },
      { id: 'reviewer_health', status: 'FAIL', reason_code: 'PROVIDER_ROUTE_UNCALLABLE' },
      { id: 'model_execution', status: 'PASS', reason_code: 'REAL_EXECUTION_PASSED' },
      { id: 'reviewer_pipeline', status: 'PASS', reason_code: 'REAL_REVIEW_PASSED' },
    ] },
    workspace: { ok: true, context: null },
  });
  assert.equal(contract.readiness.components.model.status, 'UNAVAILABLE');
  assert.equal(contract.readiness.components.model.reason_code, 'PROVIDER_ROUTE_UNCALLABLE');
  assert.equal(contract.readiness.components.reviewer.status, 'UNAVAILABLE');
  assert.equal(contract.readiness.components.reviewer.reason_code, 'PROVIDER_ROUTE_UNCALLABLE');
  assert.equal(contract.readiness.status, 'UNAVAILABLE');
});

test('disabled reviewer is not part of the extension readiness aggregate', () => {
  const contract = buildExtensionContract({
    config: { subagents_enabled: true, worker_state: 'auto', review_state: 'disabled' },
    runtime: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' },
    readinessMatrix: { rows: [
      { id: 'hub_compatibility', status: 'PASS' },
      { id: 'provider_lifecycle_consistent', status: 'PASS' },
    ] },
    readinessSnapshot: callableSnapshot(),
    workspace: { status: 'READY' },
  });
  assert.equal(contract.readiness.components.reviewer.status, 'NOT_APPLICABLE');
  assert.equal(contract.readiness.status, 'READY');
});

test('validated canonical projection is the single model readiness answer', () => {
  const contract = buildExtensionContract({
    config: { subagents_enabled: true, worker_state: 'auto', review_state: 'disabled' },
    runtime: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' },
    readinessMatrix: { rows: [
      { id: 'hub_compatibility', status: 'PASS', reason_code: 'LIVE_CHECK_PASSED' },
      { id: 'provider_health', status: 'FAIL', reason_code: 'PROVIDER_ROUTE_UNCALLABLE' },
    ] },
    readinessSnapshot: callableSnapshot(),
    workspace: { ok: true, context: null },
  });
  assert.equal(contract.readiness.components.model.status, 'READY');
  assert.equal(contract.readiness.components.model.reason_code, 'CURRENT_MODEL_CALLABLE');
});

test('incomplete, expired, and contradictory callability projections never become READY', () => {
  const runtime = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' };
  const base = callableSnapshot();
  const expired = structuredClone(base);
  expired.model_callability.expires_at = Date.now() - 1;
  const incomplete = structuredClone(base);
  delete incomplete.model_callability.runtime_identity;
  const contradictory = structuredClone(base);
  contradictory.model_callability.overall = 'CALLABLE';
  contradictory.model_callability.roles.reviewer = { state: 'NOT_CALLABLE', reason_code: 'STALE_REVIEWER' };
  contradictory.model_callability.enabled_roles.reviewer = false;
  for (const readinessSnapshot of [expired, incomplete, contradictory]) {
    const contract = buildExtensionContract({
      config: { subagents_enabled: true, worker_state: 'auto', review_state: 'disabled' },
      runtime,
      readinessMatrix: { rows: [{ id: 'hub_compatibility', status: 'PASS' }, { id: 'provider_catalog', status: 'PASS' }] },
      readinessSnapshot,
      workspace: { ok: true, context: null },
    });
    assert.notEqual(contract.readiness.components.model.status, 'READY');
  }
});

test('expired negative model evidence is not treated as permanently unavailable', () => {
  const runtime = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' };
  const snapshot = callableSnapshot();
  snapshot.model_callability.overall = 'NOT_CALLABLE';
  snapshot.model_callability.roles.worker = { state: 'NOT_CALLABLE', expires_at: Date.now() - 1, reason_code: 'QUOTA_EXHAUSTED' };
  const contract = buildExtensionContract({
    config: { subagents_enabled: true, worker_state: 'auto', review_state: 'disabled' },
    runtime,
    readinessMatrix: { rows: [{ id: 'hub_compatibility', status: 'PASS' }, { id: 'provider_catalog', status: 'PASS' }] },
    readinessSnapshot: snapshot,
    workspace: { ok: true, context: null },
  });
  assert.notEqual(contract.readiness.components.model.status, 'UNAVAILABLE');
});

test('extension contract consumes the unified readiness snapshot as its matrix authority', () => {
  const snapshot = buildRuntimeReadinessSnapshot({ readinessMatrix: { rows: [
    { id: 'hub_compatibility', status: 'PASS', reason_code: 'LIVE_CHECK_PASSED' },
    { id: 'provider_catalog', status: 'FAIL', reason_code: 'PROVIDER_CATALOG_UNAVAILABLE' },
  ] } });
  const contract = buildExtensionContract({
    config: {},
    readinessMatrix: { rows: [{ id: 'hub_compatibility', status: 'PASS' }] },
    readinessSnapshot: snapshot,
  });
  assert.equal(contract.readiness_snapshot, snapshot);
  assert.equal(contract.readiness.components.model.status, 'DEGRADED');
});
