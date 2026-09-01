// Provider deletion planning and transaction state machine.
//
// This module is intentionally side-effect free until executeProviderDelete is
// given explicit adapters. The live profile, credentials and restart hooks are
// owned by the caller; plans never carry secret values.

import { randomUUID } from 'node:crypto';

export const PROVIDER_DELETE_STATES = Object.freeze([
  'PLANNED', 'BLOCKED', 'APPLIED', 'RESTART_PENDING', 'VERIFYING',
  'VERIFIED', 'ROLLBACK_PENDING', 'ROLLED_BACK', 'FAILED',
]);

const TRANSITIONS = Object.freeze({
  PLANNED: Object.freeze(['BLOCKED', 'APPLIED', 'FAILED']),
  BLOCKED: Object.freeze(['PLANNED', 'FAILED']),
  APPLIED: Object.freeze(['RESTART_PENDING', 'FAILED']),
  RESTART_PENDING: Object.freeze(['VERIFYING', 'FAILED']),
  VERIFYING: Object.freeze(['VERIFIED', 'FAILED']),
  VERIFIED: Object.freeze(['ROLLBACK_PENDING']),
  ROLLBACK_PENDING: Object.freeze(['ROLLED_BACK', 'FAILED']),
  ROLLED_BACK: Object.freeze([]),
  FAILED: Object.freeze([]),
});

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const AUTHORITY_LOCATORS = Object.freeze({
  'crew-profile': (id) => `llm-pi-ai.config.providers.${id}`,
  'harness-settings': (id) => `llm-pi-ai.providers.${id}`,
});

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function boundedCode(value, fallback = 'PROVIDER_DELETE_FAILED') {
  const candidate = text(value);
  return candidate && CODE_PATTERN.test(candidate) ? candidate : fallback;
}

function fail(code) {
  return { ok: false, code };
}

function recordById(inventory, providerId) {
  const records = Array.isArray(inventory?.records) ? inventory.records : [];
  return records.find((record) => record?.id === providerId) ?? null;
}

function hasCanonicalAuthorities(record, providerId) {
  const authorities = Array.isArray(record?.declaration_authorities) ? record.declaration_authorities : [];
  if (authorities.length === 0) return false;
  return authorities.every((authority) => typeof AUTHORITY_LOCATORS[authority?.kind] === 'function'
    && authority.locator === AUTHORITY_LOCATORS[authority.kind](providerId));
}

function activeJobCount(record, activeJobs) {
  if (Array.isArray(activeJobs)) return activeJobs.filter((job) => job?.provider === record.id).length;
  return Number.isInteger(record?.references?.active_jobs) ? Math.max(0, record.references.active_jobs) : 0;
}

function sanitizedCredentialRefs(record) {
  return (Array.isArray(record?.credential_refs) ? record.credential_refs : []).map((ref) => ({
    kind: text(ref?.kind) ?? 'unknown',
    name_or_handle: text(ref?.name_or_handle) ?? 'unknown',
    ownership: text(ref?.ownership) ?? 'unknown',
  }));
}

function pushState(events, state) {
  events.push({ state, at: new Date().toISOString() });
}

/** Return whether a provider deletion state transition is legal. */
export function canTransitionProviderDelete(from, to) {
  return PROVIDER_DELETE_STATES.includes(from) && TRANSITIONS[from]?.includes(to) === true;
}

/**
 * Validate a provider deletion request and return a secret-free impact plan.
 * The caller must provide a replacement when deleting the active Harness
 * Default; running jobs and unknown declaration sources always fail closed.
 */
export function planProviderDelete({ providerId, inventory, activeJobs = [], replacementDefault = null, expectedRevision, expectedRevisions = null } = {}) {
  const id = text(providerId);
  if (!id) return fail('PROVIDER_NOT_FOUND');
  if (id === 'deepseek-official') return fail('PROVIDER_BUILTIN_IMMUTABLE');
  const record = recordById(inventory, id);
  if (!record) return fail('PROVIDER_NOT_FOUND');
  if (record.delete_capability === 'immutable-builtin') return fail('PROVIDER_BUILTIN_IMMUTABLE');
  if (inventory?.catalog_evidence && inventory.catalog_evidence.ok !== true) return fail('PROVIDER_CATALOG_UNAVAILABLE');
  if (record.delete_capability !== 'supported') return fail(text(record.delete_blocker) ?? 'PROVIDER_DELETE_SOURCE_UNRESOLVED');
  if (!hasCanonicalAuthorities(record, id)) return fail('PROVIDER_DELETE_SOURCE_UNRESOLVED');
  if (record.desired_state === 'absent') return fail('PROVIDER_ALREADY_ABSENT');
  if (activeJobCount(record, activeJobs) > 0) return fail('PROVIDER_IN_USE');

  const replacement = text(replacementDefault);
  const replacementRecord = replacement ? recordById(inventory, replacement) : null;
  if (record.references?.harness_default) {
    if (!record.references.harness_default_authority || record.references.harness_default_authority.kind !== 'harness-settings' || record.references.harness_default_authority.locator !== 'agent-default-model') {
      return fail('PROVIDER_DEFAULT_AUTHORITY_UNAVAILABLE');
    }
    if (!replacement || replacement === id || !replacementRecord || replacementRecord.desired_state === 'absent' || replacementRecord.lifecycle?.catalogued !== true) {
      return fail('PROVIDER_DEFAULT_REPLACEMENT_REQUIRED');
    }
    if (typeof replacementRecord.models?.[0] !== 'string' || replacementRecord.models[0].trim() === '') {
      return fail('PROVIDER_DEFAULT_REPLACEMENT_MODEL_REQUIRED');
    }
  }

  return {
    ok: true,
    plan: {
      plan_id: randomUUID(),
      provider_id: id,
      provider: { id, display_name: text(record.display_name) ?? id },
      declaration: record.declaration ?? { present: true },
      declaration_authorities: record.declaration_authorities,
      delete_capability: record.delete_capability,
      expected_revision: text(expectedRevision) ?? text(record.declaration?.revision),
      ...(expectedRevisions && typeof expectedRevisions === 'object' ? { expected_revisions: { ...expectedRevisions } } : {}),
      replacement_default: replacement,
      was_harness_default: record.references?.harness_default === true,
      ...(record.references?.harness_default === true ? {
        harness_default_before: inventory?.harness_default ?? null,
        harness_default_authority: record.references.harness_default_authority,
      } : {}),
      ...(replacement
        ? { replacement_default_model: text(replacementRecord?.models?.[0]) }
        : {}),
      will_remove: [
        ...(record.declaration_authorities.some((authority) => authority?.kind === 'crew-profile') ? ['profile declaration'] : []),
        ...(record.declaration_authorities.some((authority) => authority?.kind === 'harness-settings') ? ['Harness settings declaration'] : []),
        'runtime desired registration',
        'worker priority references', 'reviewer priority references',
        'Harness Default reference', 'cache/health state',
      ],
      credential_refs: sanitizedCredentialRefs(record),
      restart_required: true,
      rollback: { config_snapshot_available: true, credentials_included: false },
    },
  };
}

function hookError(name) {
  return Object.assign(new Error(`provider delete hook missing: ${name}`), { code: 'PROVIDER_LIFECYCLE_HOOK_MISSING' });
}

/**
 * Execute a deletion plan through injected adapters. All mutating adapters are
 * explicit so the Hub/API layer can provide atomic profile/config stores and a
 * supervisor that only restarts the owned 3210 child.
 */
export async function executeProviderDelete(plan, hooks = {}, { deferRestart = false } = {}) {
  let state = 'PLANNED';
  const events = [];
  pushState(events, state);
  let errorCode = null;
  let verification = null;
  let mutationsStarted = false;
  let rollbackAttempted = false;
  let rollbackErrorCode = null;
  let rollbackRuntimeRestarted = null;
  let rollbackRuntimeVerified = null;
  const transition = (next) => {
    if (!canTransitionProviderDelete(state, next)) throw Object.assign(new Error(`illegal provider delete transition ${state} -> ${next}`), { code: 'PROVIDER_DELETE_STATE_INVALID' });
    state = next;
    pushState(events, state);
  };
  try {
    if (!plan?.plan_id || !plan?.provider_id) throw Object.assign(new Error('provider delete plan is invalid'), { code: 'PROVIDER_DELETE_PLAN_INVALID' });
    for (const name of ['backup', 'markTombstone', 'scrubReferences', 'removeDeclarations', 'restart', 'rollback']) {
      if (typeof hooks[name] !== 'function') throw hookError(name);
    }
    await hooks.backup(plan);
    // From this point onward at least one destructive adapter may have
    // committed; any later failure must attempt compensation before returning.
    mutationsStarted = true;
    await hooks.markTombstone(plan.provider_id, 'absent', plan);
    await hooks.scrubReferences(plan);
    await hooks.removeDeclarations(plan);
    transition('APPLIED');
    transition('RESTART_PENDING');
    if (!deferRestart) {
      const restarted = await hooks.restart(plan);
      if (restarted?.ok === false) throw Object.assign(new Error('provider delete restart failed'), { code: restarted.code });
      if (typeof hooks.verify !== 'function') throw hookError('verify');
      transition('VERIFYING');
      verification = await hooks.verify(plan);
      if (verification?.providerAbsent !== true || verification?.routingClear !== true || verification?.tombstonePresent !== true) {
        throw Object.assign(new Error('provider delete verification incomplete'), { code: 'PROVIDER_DELETE_VERIFY_FAILED' });
      }
      transition('VERIFIED');
    }
  } catch (error) {
    errorCode = boundedCode(error?.code);
    if (mutationsStarted && typeof hooks.rollback === 'function') {
      rollbackAttempted = true;
      try {
        await hooks.rollback(plan);
        if (typeof hooks.restartRollback === 'function') {
          const restarted = await hooks.restartRollback(plan);
          rollbackRuntimeRestarted = restarted?.ok !== false;
          if (rollbackRuntimeRestarted && typeof hooks.verifyRollback === 'function') {
            const verified = await hooks.verifyRollback(plan);
            rollbackRuntimeVerified = verified?.ok !== false;
          }
        }
      } catch (rollbackError) {
        rollbackErrorCode = boundedCode(rollbackError?.code, 'PROVIDER_DELETE_ROLLBACK_FAILED');
        rollbackRuntimeRestarted = false;
      }
    }
    if (state !== 'FAILED' && canTransitionProviderDelete(state, 'FAILED')) transition('FAILED');
  }
  const result = {
    transaction_id: plan?.plan_id ?? null,
    provider_id: plan?.provider_id ?? null,
    state,
    error_code: errorCode,
    rollback_attempted: rollbackAttempted,
    rollback_error_code: rollbackErrorCode,
    rollback_runtime_restarted: rollbackRuntimeRestarted,
    rollback_runtime_verified: rollbackRuntimeVerified,
    verification,
    events,
  };
  if (typeof hooks.recordTransaction === 'function') {
    try {
      await hooks.recordTransaction(result, plan);
      result.audit_recorded = true;
    } catch (error) {
      result.audit_recorded = false;
      result.audit_error_code = boundedCode(error?.code, 'PROVIDER_LIFECYCLE_RECORD_FAILED');
    }
  }
  if (typeof hooks.release === 'function') {
    try { await hooks.release(plan); } catch {}
  }
  return result;
}
