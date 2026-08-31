// Secret-free inventory projection for Harness providers.
//
// Harness owns the live provider/model catalog; Crew owns the routing policy
// and (where explicitly marked) profile provenance. This module only joins
// those observations into a bounded record set for lifecycle/readiness UIs.

const LIFECYCLE_ORIGINS = new Set(['builtin', 'profile-managed', 'dynamic', 'unknown']);
const OWNERSHIPS = new Set(['harness', 'crew-managed-profile', 'user-managed-profile', 'dynamic-user', 'unknown']);

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeProviderId(value) {
  return text(value);
}

function normalizeCredentialRefs(declaration) {
  const raw = declaration?.credential_refs ?? declaration?.credential_ref;
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const seen = new Set();
  const refs = [];
  for (const candidate of values) {
    const name = text(typeof candidate === 'object' ? candidate.name_or_handle ?? candidate.name : candidate);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const kind = text(typeof candidate === 'object' ? candidate.kind : null) ?? 'env';
    const ownership = text(typeof candidate === 'object' ? candidate.ownership : null) ?? 'crew';
    refs.push({
      kind: ['env', 'crew-store', 'harness-store', 'unknown'].includes(kind) ? kind : 'unknown',
      name_or_handle: name,
      ownership: ['crew', 'user', 'external', 'unknown'].includes(ownership) ? ownership : 'unknown',
    });
  }
  return refs;
}

function findPriorityIndex(policy, key, providerId) {
  const list = Array.isArray(policy?.[key]) ? policy[key] : [];
  const index = list.findIndex((entry) => normalizeProviderId(entry?.provider) === providerId);
  return index >= 0 ? index : null;
}

function declarationFor(declarations, id) {
  return declarations.find((entry) => normalizeProviderId(entry?.id) === id) ?? null;
}

function catalogFor(providers, id) {
  return providers.find((entry) => normalizeProviderId(entry?.id) === id) ?? null;
}

function normalizeOrigin(value) {
  const origin = text(value) ?? 'unknown';
  return LIFECYCLE_ORIGINS.has(origin) ? origin : 'unknown';
}

function normalizeOwnership(value) {
  const ownership = text(value) ?? 'unknown';
  return OWNERSHIPS.has(ownership) ? ownership : 'unknown';
}

function modelIds(provider) {
  if (!Array.isArray(provider?.models)) return [];
  return [...new Set(provider.models.map((model) => text(typeof model === 'object' ? model?.id : model)).filter(Boolean))];
}

/**
 * Build a secret-free provider inventory from live Harness and Crew-owned
 * observations. No credential value is accepted or copied into the result.
 */
export function buildProviderInventory({ catalog = {}, declarations = [], policy = {}, tombstones = {}, activeJobs = [], multimodalRefs = {} } = {}) {
  const catalogProviders = Array.isArray(catalog?.providers) ? catalog.providers : [];
  const safeDeclarations = Array.isArray(declarations) ? declarations : [];
  const ids = [];
  const seen = new Set();
  for (const source of [catalogProviders, safeDeclarations]) {
    for (const entry of source) {
      const id = normalizeProviderId(entry?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }

  const harnessDefault = normalizeProviderId(catalog?.harness_default?.provider);
  const records = ids.map((id) => {
    const catalogEntry = catalogFor(catalogProviders, id);
    const declaration = declarationFor(safeDeclarations, id);
    const declared = declaration !== null;
    const catalogued = catalogEntry !== null;
    const tombstoned = tombstones?.[id] === 'absent';
    const configured = declared;
    const active = Array.isArray(activeJobs)
      ? activeJobs.filter((job) => normalizeProviderId(job?.provider) === id).length
      : Number.isInteger(activeJobs?.[id]) ? Math.max(0, activeJobs[id]) : 0;
    const multimodal = Array.isArray(multimodalRefs?.[id]) ? multimodalRefs[id].length : Number.isInteger(multimodalRefs?.[id]) ? Math.max(0, multimodalRefs[id]) : 0;
    const declarationFile = text(declaration?.file);
    const locator = text(declaration?.locator);

    return {
      id,
      display_name: text(declaration?.display_name) ?? text(declaration?.name) ?? text(catalogEntry?.name) ?? id,
      origin: normalizeOrigin(declaration?.origin ?? (declared ? 'profile-managed' : 'builtin')),
      ownership: normalizeOwnership(declaration?.ownership ?? (declared ? 'crew-managed-profile' : 'harness')),
      declaration: {
        ...(declarationFile ? { file: declarationFile } : {}),
        ...(locator ? { locator } : {}),
        present: declared,
      },
      models: modelIds(catalogEntry),
      lifecycle: {
        installed: declared || catalogued,
        configured,
        enabled: !tombstoned && declaration?.enabled !== false,
        catalogued,
      },
      credential_refs: normalizeCredentialRefs(declaration),
      references: {
        harness_default: harnessDefault === id,
        worker_priority: findPriorityIndex(policy?.worker, 'priority', id),
        worker_escalation: findPriorityIndex(policy?.worker, 'escalation_priority', id),
        reviewer_priority: findPriorityIndex(policy?.reviewer ?? policy?.review, 'priority', id),
        active_jobs: active,
        multimodal_refs: multimodal,
      },
      desired_state: tombstoned ? 'absent' : 'present',
      activation: declared ? 'restart-required' : 'live',
    };
  });

  return { schema_version: 1, records };
}
