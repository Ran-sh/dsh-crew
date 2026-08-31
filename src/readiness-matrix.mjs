// Conservative release/environment readiness matrix.
//
// A row is PASS only when the caller supplies direct evidence for that row.
// Missing evidence is NOT_RUN, not an inferred success. Runtime observations
// (Hub handshake / catalog read) are intentionally separate from execution
// verification (real worker, reviewer, cancellation, timeout, etc.).

export const READINESS_STATUSES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'SKIP', 'NOT_RUN']);

export const READINESS_REASON_CODES = Object.freeze({
  LIVE_CHECK_PASSED: 'LIVE_CHECK_PASSED',
  HUB_UNREACHABLE: 'HUB_UNREACHABLE',
  HUB_INCOMPATIBLE: 'HUB_INCOMPATIBLE',
  PROVIDER_CATALOG_RESOLVED: 'PROVIDER_CATALOG_RESOLVED',
  PROVIDER_CATALOG_UNAVAILABLE: 'PROVIDER_CATALOG_UNAVAILABLE',
  PROVIDER_CATALOG_HEALTH_WARNING: 'PROVIDER_CATALOG_HEALTH_WARNING',
  PROVIDER_CATALOG_NOT_REQUIRED: 'PROVIDER_CATALOG_NOT_REQUIRED',
  PROVIDER_MODE_UNKNOWN: 'PROVIDER_MODE_UNKNOWN',
  NO_CI_EVIDENCE: 'NO_CI_EVIDENCE',
  NO_EXECUTION_EVIDENCE: 'NO_EXECUTION_EVIDENCE',
  CREDENTIAL_STATUS_NOT_PROBED: 'CREDENTIAL_STATUS_NOT_PROBED',
  EVIDENCE_REPORTED: 'EVIDENCE_REPORTED',
});

const TARGET_ROWS = Object.freeze([
  ['linux_deterministic', 'ci'],
  ['windows_regressions', 'ci'],
  ['macos_smoke', 'ci'],
  ['hub_compatibility', 'live-runtime'],
  ['provider_catalog', 'live-runtime'],
  ['model_execution', 'real-execution'],
  ['worker_primary_callable', 'real-execution'],
  ['worker_escalation_callable', 'real-execution'],
  ['reviewer_primary_callable', 'real-execution'],
  ['provider_lifecycle_consistent', 'live-runtime'],
  ['deepseek_flash', 'real-execution'],
  ['deepseek_pro', 'real-execution'],
  ['reviewer_pipeline', 'real-execution'],
  ['cancellation_timeout_escalation', 'real-execution'],
  ['standalone_official', 'real-execution'],
]);

function baseRow(id, category, status, reasonCode, evidenceSource = 'none', extra = {}) {
  return {
    id,
    category,
    status,
    reason_code: reasonCode,
    evidence_source: evidenceSource,
    ...extra,
  };
}

function normalizeEvidence(row, evidence) {
  if (!evidence || typeof evidence !== 'object') return row;
  if (!READINESS_STATUSES.includes(evidence.status)) return row;
  const reason = typeof evidence.reason_code === 'string' && evidence.reason_code.trim()
    ? evidence.reason_code.trim()
    : READINESS_REASON_CODES.EVIDENCE_REPORTED;
  const source = typeof evidence.evidence_source === 'string' && evidence.evidence_source.trim()
    ? evidence.evidence_source.trim()
    : 'reported-evidence';
  return {
    ...row,
    status: evidence.status,
    reason_code: reason,
    evidence_source: source,
    ...(typeof evidence.evidence_ref === 'string' && evidence.evidence_ref.trim()
      ? { evidence_ref: evidence.evidence_ref.trim() }
      : {}),
  };
}

function defaultRows() {
  return Object.fromEntries(TARGET_ROWS.map(([id, category]) => {
    const reason = category === 'ci'
      ? READINESS_REASON_CODES.NO_CI_EVIDENCE
      : id === 'standalone_official'
        ? READINESS_REASON_CODES.CREDENTIAL_STATUS_NOT_PROBED
        : READINESS_REASON_CODES.NO_EXECUTION_EVIDENCE;
    return [id, baseRow(id, category, 'NOT_RUN', reason)];
  }));
}

/**
 * Build a secret-free readiness matrix from direct runtime observations plus
 * optional trusted evidence supplied by a higher layer.
 *
 * `evidence` is deliberately inert metadata: this module never reads files,
 * credentials, GitHub, provider config, or the network on its own.
 */
export function buildReadinessMatrix({
  platform = process.platform,
  hubCompatibility = null,
  workerProviderMode = null,
  providerCatalogChecked = false,
  providerCatalogOk = false,
  evidence = {},
} = {}) {
  const rows = defaultRows();

  if (hubCompatibility?.compatible === true) {
    rows.hub_compatibility = baseRow(
      'hub_compatibility', 'live-runtime', 'PASS',
      READINESS_REASON_CODES.LIVE_CHECK_PASSED, 'hub-handshake',
      {
        runtime_version: hubCompatibility.runtime_version ?? null,
        protocol_version: hubCompatibility.protocol_version ?? null,
      },
    );
  } else if (hubCompatibility?.reachable === true) {
    rows.hub_compatibility = baseRow(
      'hub_compatibility', 'live-runtime', 'FAIL',
      READINESS_REASON_CODES.HUB_INCOMPATIBLE, 'hub-handshake',
      { detail_code: hubCompatibility.code ?? null },
    );
  } else {
    rows.hub_compatibility = baseRow(
      'hub_compatibility', 'live-runtime', 'BLOCKED',
      READINESS_REASON_CODES.HUB_UNREACHABLE, 'hub-handshake',
      { detail_code: hubCompatibility?.code ?? null },
    );
  }

  if (workerProviderMode == null) {
    rows.provider_catalog = baseRow(
      'provider_catalog', 'live-runtime', 'NOT_RUN',
      READINESS_REASON_CODES.PROVIDER_MODE_UNKNOWN, 'none',
    );
  } else if (workerProviderMode === 'deepseek-official') {
    rows.provider_catalog = baseRow(
      'provider_catalog', 'live-runtime', 'SKIP',
      READINESS_REASON_CODES.PROVIDER_CATALOG_NOT_REQUIRED, 'runtime-policy',
    );
  } else if (!hubCompatibility?.compatible) {
    rows.provider_catalog = baseRow(
      'provider_catalog', 'live-runtime', 'BLOCKED',
      hubCompatibility?.reachable
        ? READINESS_REASON_CODES.HUB_INCOMPATIBLE
        : READINESS_REASON_CODES.HUB_UNREACHABLE,
      'hub-handshake',
      { detail_code: hubCompatibility?.code ?? null },
    );
  } else if (providerCatalogChecked && providerCatalogOk) {
    rows.provider_catalog = baseRow(
      'provider_catalog', 'live-runtime', 'PASS',
      READINESS_REASON_CODES.PROVIDER_CATALOG_RESOLVED, 'harness-catalog',
    );
  } else if (providerCatalogChecked) {
    rows.provider_catalog = baseRow(
      'provider_catalog', 'live-runtime', 'FAIL',
      READINESS_REASON_CODES.PROVIDER_CATALOG_UNAVAILABLE, 'harness-catalog',
    );
  }

  for (const [id] of TARGET_ROWS) {
    rows[id] = normalizeEvidence(rows[id], evidence?.[id]);
  }

  const ordered = TARGET_ROWS.map(([id]) => rows[id]);
  const counts = Object.fromEntries(READINESS_STATUSES.map((status) => [
    status,
    ordered.filter((row) => row.status === status).length,
  ]));

  return {
    schema_version: 1,
    platform,
    conservative: true,
    summary: counts,
    rows: ordered,
  };
}
