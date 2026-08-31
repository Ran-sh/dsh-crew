import { buildReadinessMatrix, READINESS_REASON_CODES } from './readiness-matrix.mjs';

function warningCodes(catalogBody) {
  const hints = Array.isArray(catalogBody?.health?.hints) ? catalogBody.health.hints : [];
  return [...new Set(hints
    .filter((hint) => hint?.level === 'warning' && typeof hint?.code === 'string' && hint.code.trim())
    .map((hint) => hint.code.trim()))];
}

function verifiedHubJob(job) {
  return job?.status === 'done'
    && job?.task_status === 'success'
    && job?.delivery_complete === true
    && job?.workspace_evidence_ok === true;
}

export function buildHubExecutionRows(hubJobs = []) {
  const jobs = Array.isArray(hubJobs) ? hubJobs : [];
  const workerPassed = jobs.some((job) => job?.role === 'worker' && verifiedHubJob(job));
  const workerPrimaryPassed = jobs.some((job) => job?.role === 'worker'
    && verifiedHubJob(job)
    && Number(job?.attempt ?? job?.selection_trace?.logical_attempt ?? 0) === 0);
  const workerEscalationPassed = jobs.some((job) => job?.role === 'worker'
    && verifiedHubJob(job)
    && (Number(job?.attempt ?? job?.selection_trace?.logical_attempt ?? 0) > 0));
  const reviewerPassed = jobs.some((job) => job?.role === 'reviewer'
    && verifiedHubJob(job)
    && job?.review_verdict === 'approve');
  return [
    workerPassed
      ? { id: 'model_execution', status: 'PASS', reason_code: 'REAL_EXECUTION_PASSED', evidence_source: 'hub-jobs' }
      : { id: 'model_execution', status: 'NOT_RUN', reason_code: 'NO_EXECUTION_EVIDENCE', evidence_source: 'none' },
    workerPrimaryPassed
      ? { id: 'worker_primary_callable', status: 'PASS', reason_code: 'WORKER_PRIMARY_CALLABLE', evidence_source: 'hub-jobs' }
      : { id: 'worker_primary_callable', status: 'NOT_RUN', reason_code: 'NO_EXECUTION_EVIDENCE', evidence_source: 'none' },
    workerEscalationPassed
      ? { id: 'worker_escalation_callable', status: 'PASS', reason_code: 'WORKER_ESCALATION_CALLABLE', evidence_source: 'hub-jobs' }
      : { id: 'worker_escalation_callable', status: 'NOT_RUN', reason_code: 'NO_EXECUTION_EVIDENCE', evidence_source: 'none' },
    reviewerPassed
      ? { id: 'reviewer_primary_callable', status: 'PASS', reason_code: 'REVIEWER_PRIMARY_CALLABLE', evidence_source: 'hub-jobs' }
      : { id: 'reviewer_primary_callable', status: 'NOT_RUN', reason_code: 'NO_EXECUTION_EVIDENCE', evidence_source: 'none' },
    { id: 'provider_lifecycle_consistent', status: 'NOT_RUN', reason_code: 'NO_EXECUTION_EVIDENCE', evidence_source: 'none' },
    reviewerPassed
      ? { id: 'reviewer_pipeline', status: 'PASS', reason_code: 'REAL_REVIEW_PASSED', evidence_source: 'hub-jobs' }
      : { id: 'reviewer_pipeline', status: 'NOT_RUN', reason_code: 'NO_EXECUTION_EVIDENCE', evidence_source: 'none' },
  ];
}

/**
 * Enrich the conservative runtime matrix with evidence the config report has
 * already collected. This function performs no I/O and never reads provider
 * configuration, credentials, quotas, pricing, or hidden catalog expectations.
 */
export function buildConfigReadinessMatrix({
  platform = process.platform,
  hubCompatibility = null,
  workerProviderMode = null,
  providerCatalogChecked = false,
  providerCatalogBody = null,
  hubJobsChecked = false,
  hubJobsBody = null,
} = {}) {
  const warnings = warningCodes(providerCatalogBody);
  const catalogResponseOk = !!providerCatalogBody
    && typeof providerCatalogBody === 'object'
    && providerCatalogBody.ok !== false;
  const catalogOk = providerCatalogChecked && catalogResponseOk && warnings.length === 0;

  const evidence = {};
  const hubJobs = hubCompatibility?.compatible === true
    && hubJobsChecked
    && hubJobsBody?.ok !== false
    && Array.isArray(hubJobsBody?.jobs)
    ? hubJobsBody.jobs
    : [];
  for (const row of buildHubExecutionRows(hubJobs)) {
    if (row.status === 'PASS') {
      evidence[row.id] = {
        status: row.status,
        reason_code: row.reason_code,
        evidence_source: row.evidence_source,
      };
    }
  }
  if (
    workerProviderMode !== 'deepseek-official'
    && hubCompatibility?.compatible === true
    && providerCatalogChecked
    && catalogResponseOk
    && warnings.length > 0
  ) {
    evidence.provider_catalog = {
      status: 'FAIL',
      reason_code: READINESS_REASON_CODES.PROVIDER_CATALOG_HEALTH_WARNING,
      evidence_source: 'harness-catalog',
    };
  }

  const matrix = buildReadinessMatrix({
    platform,
    hubCompatibility,
    workerProviderMode,
    providerCatalogChecked,
    providerCatalogOk: catalogOk,
    evidence,
  });

  if (warnings.length === 0) return matrix;
  return {
    ...matrix,
    rows: matrix.rows.map((row) => row.id === 'provider_catalog'
      ? { ...row, detail_codes: warnings }
      : row),
  };
}
