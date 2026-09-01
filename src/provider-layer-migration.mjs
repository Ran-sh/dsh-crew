// Pure planning for promoting legacy Crew profile providers into the Harness
// user settings layer. Planning never reads credentials or performs writes.

import { classifyCredentialReference } from './credential-reference.mjs';

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
  const kind = ref && typeof ref === 'object' && typeof ref.kind === 'string' ? ref.kind : 'env';
  return classifyCredentialReference(ref, { kind }).value;
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
export function buildProviderLayerMigrationPlan({ declarations = [], catalogProviders = [], harnessDefault = null, routingReferences = [], tombstones = {}, recoveryTransactions = [], catalogEvidence = { ok: true, partial: false }, declarationEvidence = { ok: true }, lifecycleEvidence = { ok: true }, defaultEvidence = { ok: true } } = {}) {
  const entries = Array.isArray(declarations) ? declarations : [];
  const base = entries.filter((entry) => authorityKind(entry) === 'crew-profile' && providerId(entry));
  const user = entries.filter((entry) => authorityKind(entry) === 'harness-settings' && providerId(entry));
  const byBase = new Map(base.map((entry) => [providerId(entry), entry]));
  const byUser = new Map(user.map((entry) => [providerId(entry), entry]));
  const catalog = new Map((Array.isArray(catalogProviders) ? catalogProviders : [])
    .map((entry) => [text(entry?.id), entry]).filter(([id]) => id));
  const safeTombstones = tombstones && typeof tombstones === 'object' && !Array.isArray(tombstones) ? tombstones : {};
  const safeRecoveryTransactions = Array.isArray(recoveryTransactions) ? recoveryTransactions : [];
  const unresolvedRecovery = safeRecoveryTransactions.some((entry) => entry?.unresolved === true || !text(entry?.provider_id));
  const pendingRecovery = safeRecoveryTransactions.length > 0;
  const catalogUnavailable = catalogEvidence?.ok !== true || catalogEvidence?.partial === true;
  const declarationUnavailable = declarationEvidence?.ok !== true;
  const lifecycleUnavailable = lifecycleEvidence?.ok !== true;
  const defaultUnavailable = defaultEvidence?.ok !== true;
  const providers = [...new Set([...byBase.keys(), ...byUser.keys()])]
    .filter((id) => !BUILTIN_PROVIDER_IDS.has(id))
    .map((id) => {
      const baseEntry = byBase.get(id) ?? null;
      const userEntry = byUser.get(id) ?? null;
      const catalogEntry = catalog.get(id) ?? null;
      // Adapter ownership is a catalog fact, not a provider-name heuristic.
      // An explicit true blocks the transition; missing metadata (including a
      // missing catalog entry) also blocks a base-layer transition because
      // reusing an unknown adapter id could hide the native Delete action.
      const collision = catalogEntry?.adapter_owned === true;
      const ownershipUnknown = baseEntry !== null && (catalogEntry === null || typeof catalogEntry.adapter_owned !== 'boolean');
      const tombstoned = safeTombstones[id] === 'absent';
      const recovery = safeRecoveryTransactions.find((entry) => text(entry?.provider_id) === id);
      const blockedCode = lifecycleUnavailable
        ? 'PROVIDER_LIFECYCLE_UNAVAILABLE'
        : catalogUnavailable
          ? 'MODEL_CATALOG_UNAVAILABLE'
            : declarationUnavailable
              ? 'PROVIDER_SOURCE_UNRESOLVED'
              : defaultUnavailable
                ? 'PROVIDER_DEFAULT_AUTHORITY_UNAVAILABLE'
                : unresolvedRecovery
              ? 'PROVIDER_DELETE_RECOVERY_UNRESOLVED'
              : pendingRecovery
                ? 'PROVIDER_DELETE_RECOVERY_PENDING'
                : tombstoned
                  ? 'PROVIDER_ALREADY_ABSENT'
                  : null;
      const ownershipCode = collision
        ? 'HARNESS_PROVIDER_ID_COLLISION'
        : ownershipUnknown ? 'HARNESS_PROVIDER_OWNERSHIP_UNAVAILABLE' : null;
      const action = blockedCode ? 'blocked' : ownershipCode ? 'collision-review' : baseEntry && userEntry ? 'promote-existing-user' : baseEntry ? 'materialize-user' : 'none';
      const currentNativeRemovable = userEntry !== null && baseEntry === null;
      const migrationAction = action === 'promote-existing-user' || action === 'materialize-user';
      return {
        provider_id: id,
        action,
        current_native_removable: currentNativeRemovable,
        target_native_removable: migrationAction ? true : currentNativeRemovable,
        native_removable_after: migrationAction ? 'pending-verification' : ownershipCode || blockedCode ? 'unknown' : currentNativeRemovable,
        requires_base_removal: baseEntry !== null,
        target_user_layer: migrationAction || currentNativeRemovable,
        source: { base: baseEntry ? safeProjection(baseEntry) : null, user: userEntry ? safeProjection(userEntry) : null },
        credential_reference: safeCredentialRef(userEntry) ?? safeCredentialRef(baseEntry),
        collision: ownershipCode ? { reason_code: ownershipCode, ...(ownershipCode === 'HARNESS_PROVIDER_ID_COLLISION' ? { requires_target_id: true } : {}) } : null,
        ...(blockedCode ? { blocked_reason: blockedCode } : ownershipCode ? { blocked_reason: ownershipCode } : {}),
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
    blocked: providers.filter((entry) => entry.action === 'collision-review' || entry.action === 'blocked').map((entry) => ({
      provider_id: entry.provider_id,
      code: entry.blocked_reason ?? 'HARNESS_PROVIDER_ID_COLLISION',
    })),
  };
}

export function hasProviderLayerMigration(plan) {
  return Array.isArray(plan?.providers) && plan.providers.length > 0;
}

const MIGRATION_STATES = Object.freeze(['PLANNED', 'APPLIED', 'RESTART_PENDING', 'VERIFYING', 'VERIFIED', 'FAILED']);

function migrationCode(error, fallback = 'PROVIDER_MIGRATION_FAILED') {
  const code = text(error?.code);
  return code && /^[A-Z][A-Z0-9_]{1,63}$/u.test(code) ? code : fallback;
}

/**
 * Execute one confirmed provider-layer transition through explicit adapters.
 * Adapters own filesystem/CAS/restart details; this state machine never reads
 * credentials and never runs for a GET or an unconfirmed request.
 */
export async function executeProviderLayerMigration(plan, hooks = {}, { confirm = false, deferRestart = false } = {}) {
  if (confirm !== true) return { ok: false, state: 'BLOCKED', code: 'PROVIDER_MIGRATION_CONFIRM_REQUIRED', transaction_id: plan?.plan_id ?? null };
  if (!plan?.plan_id || !text(plan.provider_id) || !['promote-existing-user', 'materialize-user'].includes(plan.action)) {
    return { ok: false, state: 'BLOCKED', code: 'PROVIDER_MIGRATION_PLAN_INVALID', transaction_id: plan?.plan_id ?? null };
  }
  for (const name of ['backup', 'materialize', 'removeBase', 'rollback']) {
    if (typeof hooks[name] !== 'function') return { ok: false, state: 'FAILED', code: 'PROVIDER_MIGRATION_HOOK_MISSING', transaction_id: plan.plan_id };
  }
  if (!deferRestart && (typeof hooks.restart !== 'function' || typeof hooks.verify !== 'function')) {
    return { ok: false, state: 'FAILED', code: 'PROVIDER_MIGRATION_HOOK_MISSING', transaction_id: plan.plan_id };
  }
  let state = 'PLANNED';
  const events = [{ state, at: new Date().toISOString() }];
  let rollbackAttempted = false;
  let rollbackError = null;
  let verification = null;
  try {
    await hooks.backup(plan);
    await hooks.materialize(plan);
    await hooks.removeBase(plan);
    state = 'APPLIED';
    events.push({ state, at: new Date().toISOString() });
    if (deferRestart) {
      state = 'RESTART_PENDING';
      events.push({ state, at: new Date().toISOString() });
    } else {
      const restarted = await hooks.restart(plan);
      if (restarted?.ok === false) throw Object.assign(new Error('provider migration restart failed'), { code: restarted.code });
      state = 'VERIFYING';
      events.push({ state, at: new Date().toISOString() });
      verification = await hooks.verify(plan);
      if (verification?.nativeRemovable !== true || verification?.baseAbsent !== true || verification?.userPresent !== true) {
        throw Object.assign(new Error('provider migration verification incomplete'), { code: 'PROVIDER_MIGRATION_VERIFY_FAILED' });
      }
      state = 'VERIFIED';
      events.push({ state, at: new Date().toISOString() });
    }
  } catch (error) {
    rollbackAttempted = true;
    try { await hooks.rollback(plan); }
    catch (rollbackErrorValue) { rollbackError = migrationCode(rollbackErrorValue, 'PROVIDER_MIGRATION_ROLLBACK_FAILED'); }
    state = 'FAILED';
    events.push({ state, at: new Date().toISOString() });
    return {
      ok: false,
      state,
      code: migrationCode(error),
      transaction_id: plan.plan_id,
      provider_id: plan.provider_id,
      rollback_attempted: rollbackAttempted,
      ...(rollbackError ? { rollback_error: rollbackError } : {}),
      events,
    };
  }
  return {
    ok: state === 'VERIFIED' || state === 'RESTART_PENDING',
    state,
    transaction_id: plan.plan_id,
    provider_id: plan.provider_id,
    restart_required: true,
    ...(verification ? { verification } : {}),
    events,
  };
}
