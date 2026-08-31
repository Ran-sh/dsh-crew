import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfigReadinessMatrix } from '../src/config-readiness.mjs';
import { READINESS_REASON_CODES } from '../src/readiness-matrix.mjs';

function row(matrix, id) {
  return matrix.rows.find((item) => item.id === id);
}

const compatibleHub = {
  reachable: true,
  compatible: true,
  runtime_version: '0.3.0-dev',
  protocol_version: 1,
  code: null,
};

test('deepseek-official skips provider catalog while execution rows remain NOT_RUN', () => {
  const matrix = buildConfigReadinessMatrix({
    hubCompatibility: compatibleHub,
    workerProviderMode: 'deepseek-official',
  });
  assert.equal(row(matrix, 'provider_catalog').status, 'SKIP');
  assert.equal(row(matrix, 'provider_catalog').reason_code, READINESS_REASON_CODES.PROVIDER_CATALOG_NOT_REQUIRED);
  assert.equal(row(matrix, 'deepseek_flash').status, 'NOT_RUN');
  assert.equal(row(matrix, 'reviewer_pipeline').status, 'NOT_RUN');
});

test('follow-dsh healthy catalog is PASS and informational hints do not downgrade it', () => {
  const matrix = buildConfigReadinessMatrix({
    hubCompatibility: compatibleHub,
    workerProviderMode: 'follow-dsh',
    providerCatalogChecked: true,
    providerCatalogBody: {
      ok: true,
      health: {
        warning_count: 0,
        info_count: 2,
        attention: false,
        hints: [
          { code: 'CATALOG_CONSTRAINED', level: 'info', signal: 'single-provider-small-explicit-catalog' },
          { code: 'HARNESS_DEFAULT_MODEL_UNADVERTISED', level: 'info', provider: 'p', model: 'm' },
        ],
      },
    },
  });
  assert.equal(row(matrix, 'provider_catalog').status, 'PASS');
  assert.equal(row(matrix, 'provider_catalog').reason_code, READINESS_REASON_CODES.PROVIDER_CATALOG_RESOLVED);
});

test('warning-level catalog health is FAIL with bounded diagnostic codes only', () => {
  const matrix = buildConfigReadinessMatrix({
    hubCompatibility: compatibleHub,
    workerProviderMode: 'follow-dsh',
    providerCatalogChecked: true,
    providerCatalogBody: {
      ok: true,
      error: 'token=must-not-leak',
      health: {
        warning_count: 2,
        attention: true,
        hints: [
          { code: 'PROVIDER_MODEL_LIST_FAILED', level: 'warning', provider: 'opencode-go', raw: 'secret' },
          { code: 'HARNESS_DEFAULT_PROVIDER_MISSING', level: 'warning', provider: 'missing', model: 'x' },
        ],
      },
    },
  });
  const catalog = row(matrix, 'provider_catalog');
  assert.equal(catalog.status, 'FAIL');
  assert.equal(catalog.reason_code, READINESS_REASON_CODES.PROVIDER_CATALOG_HEALTH_WARNING);
  assert.deepEqual(catalog.detail_codes, ['PROVIDER_MODEL_LIST_FAILED', 'HARNESS_DEFAULT_PROVIDER_MISSING']);
  assert.doesNotMatch(JSON.stringify(matrix), /token=must-not-leak|secret/);
});

test('failed catalog response is FAIL unavailable without copying raw errors', () => {
  const matrix = buildConfigReadinessMatrix({
    hubCompatibility: compatibleHub,
    workerProviderMode: 'follow-dsh',
    providerCatalogChecked: true,
    providerCatalogBody: { ok: false, error: 'Authorization: top-secret' },
  });
  const catalog = row(matrix, 'provider_catalog');
  assert.equal(catalog.status, 'FAIL');
  assert.equal(catalog.reason_code, READINESS_REASON_CODES.PROVIDER_CATALOG_UNAVAILABLE);
  assert.doesNotMatch(JSON.stringify(matrix), /top-secret|authorization/i);
});

test('unreachable or incompatible Hub blocks follow-dsh catalog regardless of stale body evidence', () => {
  const unreachable = buildConfigReadinessMatrix({
    hubCompatibility: { reachable: false, compatible: false, code: 'HUB_UNREACHABLE' },
    workerProviderMode: 'follow-dsh',
    providerCatalogChecked: false,
  });
  assert.equal(row(unreachable, 'provider_catalog').status, 'BLOCKED');
  assert.equal(row(unreachable, 'provider_catalog').reason_code, READINESS_REASON_CODES.HUB_UNREACHABLE);

  const incompatible = buildConfigReadinessMatrix({
    hubCompatibility: { reachable: true, compatible: false, code: 'HUB_PROTOCOL_MISMATCH' },
    workerProviderMode: 'follow-dsh',
    providerCatalogChecked: true,
    providerCatalogBody: { ok: true, health: { hints: [] } },
  });
  assert.equal(row(incompatible, 'provider_catalog').status, 'BLOCKED');
  assert.equal(row(incompatible, 'provider_catalog').reason_code, READINESS_REASON_CODES.HUB_INCOMPATIBLE);
});

test('trusted live Hub jobs promote only verified worker and approved reviewer executions', () => {
  const matrix = buildConfigReadinessMatrix({
    hubCompatibility: compatibleHub,
    workerProviderMode: 'follow-dsh',
    providerCatalogChecked: true,
    providerCatalogBody: { ok: true, health: { hints: [] } },
    hubJobsChecked: true,
    hubJobsBody: {
      ok: true,
      jobs: [
        { id: 'hub-worker-1', role: 'worker', status: 'done', task_status: 'success', delivery_complete: true, workspace_evidence_ok: true },
        { id: 'hub-reviewer-1', role: 'reviewer', status: 'done', task_status: 'success', delivery_complete: true, workspace_evidence_ok: true, review_verdict: 'approve' },
      ],
    },
  });

  assert.equal(row(matrix, 'model_execution').status, 'PASS');
  assert.equal(row(matrix, 'model_execution').evidence_source, 'hub-jobs');
  assert.equal(row(matrix, 'worker_primary_callable').status, 'PASS');
  assert.equal(row(matrix, 'reviewer_primary_callable').status, 'PASS');
  assert.equal(row(matrix, 'reviewer_pipeline').status, 'PASS');
  assert.equal(row(matrix, 'reviewer_pipeline').evidence_source, 'hub-jobs');
});

test('normal process completion never promotes partial work or requested review changes', () => {
  const matrix = buildConfigReadinessMatrix({
    hubCompatibility: compatibleHub,
    workerProviderMode: 'follow-dsh',
    providerCatalogChecked: true,
    providerCatalogBody: { ok: true, health: { hints: [] } },
    hubJobsChecked: true,
    hubJobsBody: {
      ok: true,
      jobs: [
        { role: 'worker', status: 'done', task_status: 'partial', delivery_complete: true, workspace_evidence_ok: true },
        { role: 'worker', status: 'done', task_status: 'success', delivery_complete: true, workspace_evidence_ok: null },
        { role: 'reviewer', status: 'done', task_status: 'success', delivery_complete: true, workspace_evidence_ok: true, review_verdict: 'request_changes' },
        { role: 'reviewer', status: 'done', task_status: 'success', delivery_complete: true, review_verdict: 'approve' },
      ],
    },
  });
  assert.equal(row(matrix, 'model_execution').status, 'NOT_RUN');
  assert.equal(row(matrix, 'reviewer_pipeline').status, 'NOT_RUN');
});

test('escalated worker success does not masquerade as primary callability', () => {
  const matrix = buildConfigReadinessMatrix({
    hubCompatibility: compatibleHub,
    workerProviderMode: 'follow-dsh',
    providerCatalogChecked: true,
    providerCatalogBody: { ok: true, health: { hints: [] } },
    hubJobsChecked: true,
    hubJobsBody: {
      ok: true,
      jobs: [{ role: 'worker', attempt: 1, status: 'done', task_status: 'success', delivery_complete: true, workspace_evidence_ok: true }],
    },
  });
  assert.equal(row(matrix, 'model_execution').status, 'PASS');
  assert.equal(row(matrix, 'worker_primary_callable').status, 'NOT_RUN');
  assert.equal(row(matrix, 'worker_escalation_callable').status, 'PASS');
});

test('provider lifecycle readiness requires a structurally consistent 3210 inventory', () => {
  const good = buildConfigReadinessMatrix({
    hubCompatibility: compatibleHub,
    workerProviderMode: 'follow-dsh',
    providerCatalogChecked: true,
    providerCatalogBody: { ok: true, health: { hints: [] } },
    providerInventoryChecked: true,
    providerInventoryBody: {
      ok: true,
      records: [{ id: 'p', desired_state: 'present', lifecycle: { installed: true, configured: true, enabled: true, catalogued: true } }],
    },
  });
  assert.equal(row(good, 'provider_lifecycle_consistent').status, 'PASS');

  const bad = buildConfigReadinessMatrix({
    hubCompatibility: compatibleHub,
    workerProviderMode: 'follow-dsh',
    providerInventoryChecked: true,
    providerInventoryBody: { ok: true, records: [{ id: 'p', desired_state: 'absent', lifecycle: { enabled: true } }] },
  });
  assert.equal(row(bad, 'provider_lifecycle_consistent').status, 'FAIL');
  assert.equal(row(bad, 'provider_lifecycle_consistent').reason_code, READINESS_REASON_CODES.PROVIDER_LIFECYCLE_INCONSISTENT);

  const unavailable = buildConfigReadinessMatrix({
    hubCompatibility: compatibleHub,
    workerProviderMode: 'follow-dsh',
    providerInventoryChecked: true,
    providerInventoryBody: { ok: false, code: 'PROVIDER_INVENTORY_UNAVAILABLE' },
  });
  assert.equal(row(unavailable, 'provider_lifecycle_consistent').reason_code, READINESS_REASON_CODES.PROVIDER_INVENTORY_UNAVAILABLE);

  const malformed = buildConfigReadinessMatrix({
    hubCompatibility: compatibleHub,
    workerProviderMode: 'follow-dsh',
    providerInventoryChecked: true,
    providerInventoryBody: { ok: true, records: [{ id: 'p', desired_state: 'present', lifecycle: {} }] },
  });
  assert.equal(row(malformed, 'provider_lifecycle_consistent').reason_code, READINESS_REASON_CODES.PROVIDER_LIFECYCLE_INCONSISTENT);
});

test('unchecked or malformed Hub job evidence never promotes execution readiness', () => {
  for (const options of [
    { hubJobsChecked: false, hubJobsBody: { ok: true, jobs: [{ role: 'worker', status: 'done' }] } },
    { hubJobsChecked: true, hubJobsBody: { ok: true, jobs: 'not-an-array' } },
    { hubJobsChecked: true, hubJobsBody: { ok: false, error: 'token=must-not-leak' } },
  ]) {
    const matrix = buildConfigReadinessMatrix({
      hubCompatibility: compatibleHub,
      workerProviderMode: 'deepseek-official',
      ...options,
    });
    assert.equal(row(matrix, 'model_execution').status, 'NOT_RUN');
    assert.doesNotMatch(JSON.stringify(matrix), /must-not-leak/);
  }
});
