// Pure planning for promoting legacy Crew profile providers into the Harness
// user settings layer. Planning never reads credentials or performs writes.

const BUILTIN_PROVIDER_IDS = new Set(['deepseek-official']);

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function authorityKind(declaration) {
  return text(declaration?.declaration_authority?.kind);
}

function providerId(declaration) {
  return text(declaration?.id);
}

function safeCredentialRef(declaration) {
  const ref = declaration?.credential_ref;
  if (typeof ref === 'string' && ref.trim()) return ref.trim();
  if (ref && typeof ref === 'object' && typeof ref.name_or_handle === 'string' && ref.name_or_handle.trim()) return ref.name_or_handle.trim();
  return null;
}

function safeProjection(declaration) {
  return {
    id: providerId(declaration),
    display_name: text(declaration?.display_name) ?? providerId(declaration),
    credential_ref: safeCredentialRef(declaration),
  };
}

/**
 * Build a bounded, secret-free migration plan from composition/base provider
 * declarations to Harness user settings. The caller supplies declarations
 * already obtained from the two authoritative stores.
 */
export function buildProviderLayerMigrationPlan({ declarations = [], catalogProviders = [], harnessDefault = null, routingReferences = [] } = {}) {
  const entries = Array.isArray(declarations) ? declarations : [];
  const base = entries.filter((entry) => authorityKind(entry) === 'crew-profile' && providerId(entry));
  const user = entries.filter((entry) => authorityKind(entry) === 'harness-settings' && providerId(entry));
  const byBase = new Map(base.map((entry) => [providerId(entry), entry]));
  const byUser = new Map(user.map((entry) => [providerId(entry), entry]));
  const catalog = new Map((Array.isArray(catalogProviders) ? catalogProviders : [])
    .map((entry) => [text(entry?.id), entry]).filter(([id]) => id));
  const providers = [...new Set([...byBase.keys(), ...byUser.keys()])]
    .filter((id) => !BUILTIN_PROVIDER_IDS.has(id))
    .map((id) => {
      const baseEntry = byBase.get(id) ?? null;
      const userEntry = byUser.get(id) ?? null;
      const catalogEntry = catalog.get(id) ?? null;
      const collision = id === 'opencode-go' && catalogEntry?.adapter_owned === true;
      const action = baseEntry && userEntry ? 'promote-existing-user' : baseEntry ? 'materialize-user' : 'none';
      return {
        provider_id: id,
        action: collision ? 'collision-review' : action,
        native_removable_after: collision ? 'unknown' : true,
        source: { base: baseEntry ? safeProjection(baseEntry) : null, user: userEntry ? safeProjection(userEntry) : null },
        credential_reference: safeCredentialRef(userEntry) ?? safeCredentialRef(baseEntry),
        collision: collision ? { reason_code: 'HARNESS_PROVIDER_ID_COLLISION', requires_target_id: true } : null,
        referenced_by: (Array.isArray(routingReferences) ? routingReferences : [])
          .filter((ref) => ref?.provider === id).map((ref) => ({ provider: id, model: text(ref.model) })),
        harness_default: harnessDefault?.provider === id,
      };
    });
  return {
    schema_version: 1,
    kind: 'provider-layer-migration-plan',
    requires_confirmation: providers.some((entry) => entry.action !== 'none'),
    providers: providers.filter((entry) => entry.action !== 'none'),
    blocked: providers.filter((entry) => entry.action === 'collision-review').map((entry) => ({ provider_id: entry.provider_id, code: 'HARNESS_PROVIDER_ID_COLLISION' })),
  };
}

export function hasProviderLayerMigration(plan) {
  return Array.isArray(plan?.providers) && plan.providers.length > 0;
}
