import { buildReadinessMatrix, READINESS_REASON_CODES } from './readiness-matrix.mjs';

function warningCodes(catalogBody) {
  const hints = Array.isArray(catalogBody?.health?.hints) ? catalogBody.health.hints : [];
  return [...new Set(hints
    .filter((hint) => hint?.level === 'warning' && typeof hint?.code === 'string' && hint.code.trim())
    .map((hint) => hint.code.trim()))];
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
} = {}) {
  const warnings = warningCodes(providerCatalogBody);
  const catalogResponseOk = !!providerCatalogBody
    && typeof providerCatalogBody === 'object'
    && providerCatalogBody.ok !== false;
  const catalogOk = providerCatalogChecked && catalogResponseOk && warnings.length === 0;

  const evidence = {};
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
