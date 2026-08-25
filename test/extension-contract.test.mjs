import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtensionContract } from '../src/extension-contract.mjs';

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
  assert.equal(contract.readiness.components.model.reason_code, 'MODEL_CATALOG_ONLY');
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
    readinessMatrix: { rows: [
      { id: 'hub_compatibility', status: 'PASS', reason_code: 'LIVE_CHECK_PASSED' },
      { id: 'model_execution', status: 'PASS', reason_code: 'REAL_EXECUTION_PASSED' },
    ] },
    workspace: { ok: true, context: null },
  });
  assert.equal(contract.readiness.components.model.status, 'READY');
  assert.equal(contract.readiness.components.reviewer.status, 'DEGRADED');
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
