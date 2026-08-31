import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReadinessMatrix,
  READINESS_REASON_CODES,
} from '../src/readiness-matrix.mjs';

function row(matrix, id) {
  return matrix.rows.find((item) => item.id === id);
}

test('compatible Hub is PASS while execution and CI rows remain NOT_RUN without evidence', () => {
  const matrix = buildReadinessMatrix({
    platform: 'linux',
    hubCompatibility: {
      reachable: true,
      compatible: true,
      runtime_version: '0.3.0-dev',
      protocol_version: 1,
      code: null,
    },
    workerProviderMode: 'deepseek-official',
  });

  assert.equal(matrix.schema_version, 1);
  assert.equal(matrix.conservative, true);
  assert.equal(row(matrix, 'hub_compatibility').status, 'PASS');
  assert.equal(row(matrix, 'provider_catalog').status, 'SKIP');
  assert.equal(row(matrix, 'provider_catalog').reason_code, READINESS_REASON_CODES.PROVIDER_CATALOG_NOT_REQUIRED);
  assert.equal(row(matrix, 'linux_deterministic').status, 'NOT_RUN');
  assert.equal(row(matrix, 'deepseek_flash').status, 'NOT_RUN');
  assert.equal(row(matrix, 'standalone_official').reason_code, READINESS_REASON_CODES.CREDENTIAL_STATUS_NOT_PROBED);
  assert.equal(row(matrix, 'opencode_go_mimo_qwen'), undefined);
  assert.equal(row(matrix, 'worker_primary_callable').status, 'NOT_RUN');
  assert.equal(row(matrix, 'reviewer_primary_callable').status, 'NOT_RUN');
});

test('unreachable Hub blocks Hub/catalog rows instead of reporting FAIL for unavailable infrastructure', () => {
  const matrix = buildReadinessMatrix({
    hubCompatibility: { reachable: false, compatible: false, code: 'HUB_UNREACHABLE' },
    workerProviderMode: 'follow-dsh',
  });

  assert.equal(row(matrix, 'hub_compatibility').status, 'BLOCKED');
  assert.equal(row(matrix, 'hub_compatibility').reason_code, READINESS_REASON_CODES.HUB_UNREACHABLE);
  assert.equal(row(matrix, 'provider_catalog').status, 'BLOCKED');
  assert.equal(row(matrix, 'provider_catalog').reason_code, READINESS_REASON_CODES.HUB_UNREACHABLE);
});

test('reachable incompatible Hub is a live FAIL with bounded detail code', () => {
  const matrix = buildReadinessMatrix({
    hubCompatibility: { reachable: true, compatible: false, code: 'HUB_PROTOCOL_MISMATCH' },
    workerProviderMode: 'follow-dsh',
  });

  assert.deepEqual(row(matrix, 'hub_compatibility'), {
    id: 'hub_compatibility',
    category: 'live-runtime',
    status: 'FAIL',
    reason_code: READINESS_REASON_CODES.HUB_INCOMPATIBLE,
    evidence_source: 'hub-handshake',
    detail_code: 'HUB_PROTOCOL_MISMATCH',
  });
  assert.equal(row(matrix, 'provider_catalog').status, 'BLOCKED');
});

test('follow-dsh catalog PASS requires an actual successful catalog check', () => {
  const unchecked = buildReadinessMatrix({
    hubCompatibility: { reachable: true, compatible: true },
    workerProviderMode: 'follow-dsh',
    providerCatalogChecked: false,
  });
  assert.equal(row(unchecked, 'provider_catalog').status, 'NOT_RUN');

  const good = buildReadinessMatrix({
    hubCompatibility: { reachable: true, compatible: true },
    workerProviderMode: 'follow-dsh',
    providerCatalogChecked: true,
    providerCatalogOk: true,
  });
  assert.equal(row(good, 'provider_catalog').status, 'PASS');
  assert.equal(row(good, 'provider_catalog').reason_code, READINESS_REASON_CODES.PROVIDER_CATALOG_RESOLVED);

  const bad = buildReadinessMatrix({
    hubCompatibility: { reachable: true, compatible: true },
    workerProviderMode: 'follow-dsh',
    providerCatalogChecked: true,
    providerCatalogOk: false,
  });
  assert.equal(row(bad, 'provider_catalog').status, 'FAIL');
  assert.equal(row(bad, 'provider_catalog').reason_code, READINESS_REASON_CODES.PROVIDER_CATALOG_UNAVAILABLE);
});

test('trusted evidence can report CI/real-execution rows without changing unrelated rows', () => {
  const matrix = buildReadinessMatrix({
    hubCompatibility: { reachable: false, compatible: false },
    evidence: {
      linux_deterministic: {
        status: 'PASS',
        reason_code: 'CI_GREEN',
        evidence_source: 'github-actions',
        evidence_ref: 'run-123',
      },
      standalone_official: {
        status: 'BLOCKED',
        reason_code: 'AUTHORIZED_KEY_UNAVAILABLE',
        evidence_source: 'real-smoke',
      },
    },
  });

  assert.equal(row(matrix, 'linux_deterministic').status, 'PASS');
  assert.equal(row(matrix, 'linux_deterministic').evidence_ref, 'run-123');
  assert.equal(row(matrix, 'standalone_official').status, 'BLOCKED');
  assert.equal(row(matrix, 'reviewer_pipeline').status, 'NOT_RUN');
  assert.equal(matrix.summary.PASS, 1);
});

test('invalid evidence status is ignored rather than broadening the matrix contract', () => {
  const matrix = buildReadinessMatrix({
    hubCompatibility: { reachable: false, compatible: false },
    evidence: {
      linux_deterministic: { status: 'GREEN', reason_code: 'whatever' },
    },
  });
  assert.equal(row(matrix, 'linux_deterministic').status, 'NOT_RUN');
  assert.equal(row(matrix, 'linux_deterministic').reason_code, READINESS_REASON_CODES.NO_CI_EVIDENCE);
});
