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

  assert.equal(matrix.schema_version, 2);
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

// The built-in DeepSeek rows describe a route only when the operator runs it.
// Under follow-dsh with a KNOWN other provider they can never gather evidence, and
// NOT_RUN reads like a check that should have run rather than a route never chosen.
// They stay in the matrix as NOT_APPLICABLE — answered, not forgotten — and an
// unknown selection stays conservative.
test('built-in DeepSeek rows are not applicable for another known route and kept otherwise', () => {
  const skipped = buildReadinessMatrix({
    workerProviderMode: 'follow-dsh',
    workerSelection: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
  });
  assert.equal(row(skipped, 'deepseek_flash').status, 'NOT_APPLICABLE');
  assert.equal(row(skipped, 'deepseek_flash').reason_code, READINESS_REASON_CODES.WORKER_PROVIDER_FOLLOWS_DSH);
  assert.equal(row(skipped, 'deepseek_pro').status, 'NOT_APPLICABLE');
  assert.equal(skipped.summary.NOT_APPLICABLE, 2, 'the rows are counted, not dropped');
  assert.equal(skipped.summary.FAIL, 0, 'and nothing about them fails');

  const deepseek = buildReadinessMatrix({
    workerProviderMode: 'follow-dsh',
    workerSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  });
  assert.equal(row(deepseek, 'deepseek_flash').status, 'NOT_RUN', 'a DeepSeek selection keeps the rows meaningful');

  const official = buildReadinessMatrix({ workerProviderMode: 'deepseek-official' });
  assert.equal(row(official, 'deepseek_flash').status, 'NOT_RUN');

  const unknown = buildReadinessMatrix({ workerProviderMode: 'follow-dsh' });
  assert.equal(row(unknown, 'deepseek_flash').status, 'NOT_RUN', 'an unknown selection stays conservative');
});

// Applicability is decided when the row is built, never by evidence. Evidence that
// could declare a required row not applicable would be a way to make a check vanish
// while the matrix still looks healthy, and evidence that could flip an unused route
// to PASS would report a check the machine never ran.
test('evidence can neither create nor clear a not-applicable row', () => {
  const skipped = buildReadinessMatrix({
    workerProviderMode: 'follow-dsh',
    workerSelection: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
    // A stale DeepSeek PASS arriving from a previous route selection.
    evidence: { deepseek_flash: { status: 'PASS', reason_code: 'DEEPSEEK_FLASH_EXECUTED', evidence_source: 'hub-jobs' } },
  });
  const flash = row(skipped, 'deepseek_flash');
  assert.equal(flash.status, 'NOT_APPLICABLE', 'the policy decision outranks reported evidence');
  assert.equal(flash.reason_code, READINESS_REASON_CODES.WORKER_PROVIDER_FOLLOWS_DSH);
  assert.deepEqual(flash.reported_evidence, { status: 'PASS', reason_code: 'DEEPSEEK_FLASH_EXECUTED', evidence_source: 'hub-jobs' }, 'and what was reported is kept rather than dropped');

  // The other direction: no row may be talked out of applicability by evidence.
  for (const id of ['hub_compatibility', 'provider_lifecycle_consistent', 'model_execution', 'linux_deterministic']) {
    const matrix = buildReadinessMatrix({ evidence: { [id]: { status: 'NOT_APPLICABLE', evidence_source: 'reported-evidence' } } });
    assert.notEqual(row(matrix, id).status, 'NOT_APPLICABLE', `${id} cannot be made not-applicable by evidence`);
  }

  // Only the policy rows can carry the status, and only the follow-dsh policy produces
  // it: an unknown or future mode is not a licence to mark the built-in routes unused,
  // so those rows stay real and conservative.
  assert.equal(skipped.summary.NOT_APPLICABLE, 2);
  for (const mode of ['follow-someone', 'deepseek-official']) {
    const other = buildReadinessMatrix({ workerProviderMode: mode, workerSelection: { provider: 'commandcode', model: 'x' } });
    assert.equal(row(other, 'deepseek_flash').status, 'NOT_RUN', `${mode} does not produce a not-applicable row`);
  }
  const deepseek = buildReadinessMatrix({
    workerProviderMode: 'follow-dsh',
    workerSelection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    evidence: { deepseek_flash: { status: 'PASS', reason_code: 'DEEPSEEK_FLASH_EXECUTED', evidence_source: 'hub-jobs' } },
  });
  assert.equal(row(deepseek, 'deepseek_flash').status, 'PASS', 'a selected route still consumes its real evidence');
});

// The observation is not lost when applicability wins: the same sanitized fields an
// applied record keeps are kept here too.
test('a not-applicable row keeps the full reported evidence as metadata', () => {
  const matrix = buildReadinessMatrix({
    workerProviderMode: 'follow-dsh',
    workerSelection: { provider: 'commandcode', model: 'x' },
    evidence: { deepseek_pro: {
      status: 'FAIL', reason_code: 'DEEPSEEK_PRO_ROUTE_UNCALLABLE', evidence_source: 'hub-jobs',
      evidence_ref: 'job-42', detail_code: 'QUOTA_EXHAUSTED', ignored: 'not a field the matrix accepts',
    } },
  });
  assert.deepEqual(row(matrix, 'deepseek_pro').reported_evidence, {
    status: 'FAIL', reason_code: 'DEEPSEEK_PRO_ROUTE_UNCALLABLE', evidence_source: 'hub-jobs',
    evidence_ref: 'job-42', detail_code: 'QUOTA_EXHAUSTED',
  });
});
