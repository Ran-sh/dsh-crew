// Secret-free inventory projection for Harness providers.
//
// Harness owns the live provider/model catalog; Crew owns the routing policy
// and (where explicitly marked) profile provenance. This module only joins
// those observations into a bounded record set for lifecycle/readiness UIs.

const LIFECYCLE_ORIGINS = new Set(['builtin', 'profile-managed', 'dynamic', 'unknown']);
const OWNERSHIPS = new Set(['harness', 'crew-managed-profile', 'user-managed-profile', 'dynamic-user', 'unknown']);
const MUTABLE_AUTHORITY_KINDS = new Set(['crew-profile', 'harness-settings']);
export const IMMUTABLE_HARNESS_PROVIDER_IDS = Object.freeze(['deepseek-official']);

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeProviderId(value) {
  return text(value);
}

function normalizeCredentialRefs(declarations) {
  const entries = Array.isArray(declarations) ? declarations : [declarations];
  const seen = new Set();
  const refs = [];
  for (const declaration of entries) {
    const raw = declaration?.credential_refs ?? declaration?.credential_ref;
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
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
  }
  return refs;
}

function findPriorityIndex(policy, key, providerId) {
  const list = Array.isArray(policy?.[key]) ? policy[key] : [];
  const index = list.findIndex((entry) => normalizeProviderId(entry?.provider) === providerId);
  return index >= 0 ? index : null;
}

function declarationsFor(declarations, id) {
  return declarations.filter((entry) => normalizeProviderId(entry?.id) === id);
}

function normalizeAuthority(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = text(value.kind);
  const locator = text(value.locator);
  return kind && locator ? { kind, locator } : null;
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
    const providerDeclarations = declarationsFor(safeDeclarations, id);
    const declaration = providerDeclarations[0] ?? null;
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

    const authorities = providerDeclarations.map((entry) => normalizeAuthority(entry.declaration_authority)).filter(Boolean);
    const uniqueAuthorities = [...new Map(authorities.map((authority) => [`${authority.kind}:${authority.locator}`, authority])).values()];
    const mutableAuthorities = uniqueAuthorities.filter((authority) => MUTABLE_AUTHORITY_KINDS.has(authority.kind));
    const immutable = IMMUTABLE_HARNESS_PROVIDER_IDS.includes(id);
    const allAuthoritiesKnown = providerDeclarations.length > 0
      && uniqueAuthorities.length === providerDeclarations.length
      && uniqueAuthorities.every((authority) => MUTABLE_AUTHORITY_KINDS.has(authority.kind));
    const deleteCapability = immutable ? 'immutable-builtin' : allAuthoritiesKnown && mutableAuthorities.length > 0 ? 'supported' : 'source-unresolved';
    const deleteBlocker = immutable ? 'PROVIDER_BUILTIN_IMMUTABLE' : deleteCapability === 'supported' ? null : 'PROVIDER_DELETE_SOURCE_UNRESOLVED';
    const origin = normalizeOrigin(declaration?.origin ?? (immutable ? 'builtin' : declared ? 'profile-managed' : 'unknown'));
    const ownership = normalizeOwnership(declaration?.ownership ?? (immutable ? 'harness' : declared ? 'crew-managed-profile' : 'unknown'));
    return {
      id,
      display_name: text(declaration?.display_name) ?? text(declaration?.name) ?? text(catalogEntry?.name) ?? id,
      origin,
      ownership,
      declaration: {
        ...(declarationFile ? { file: declarationFile } : {}),
        ...(locator ? { locator } : {}),
        ...(normalizeAuthority(declaration?.declaration_authority) ? { authority: normalizeAuthority(declaration.declaration_authority) } : {}),
        present: declared,
      },
      declaration_authorities: uniqueAuthorities,
      delete_capability: deleteCapability,
      ...(deleteBlocker ? { delete_blocker: deleteBlocker } : {}),
      models: modelIds(catalogEntry),
      lifecycle: {
        installed: declared || catalogued,
        configured,
        enabled: !tombstoned && declaration?.enabled !== false,
        catalogued,
      },
      credential_refs: normalizeCredentialRefs(providerDeclarations),
      references: {
        harness_default: harnessDefault === id,
        ...(harnessDefault === id && normalizeAuthority(catalog?.harness_default_authority) ? { harness_default_authority: normalizeAuthority(catalog.harness_default_authority) } : {}),
        worker_priority: findPriorityIndex(policy?.worker, 'priority', id),
        worker_escalation: findPriorityIndex(policy?.worker, 'escalation_priority', id),
        reviewer_priority: findPriorityIndex(policy?.reviewer ?? policy?.review, 'priority', id),
        reviewer_escalation: findPriorityIndex(policy?.reviewer ?? policy?.review, 'escalation_priority', id),
        active_jobs: active,
        multimodal_refs: multimodal,
      },
      desired_state: tombstoned ? 'absent' : 'present',
      activation: declared ? 'restart-required' : 'live',
    };
  });

  return { schema_version: 1, records, harness_default: catalog?.harness_default ?? null };
}
