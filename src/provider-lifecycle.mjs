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

const DELETEABLE_OWNERSHIPS = new Set(['crew-managed-profile', 'user-managed-profile', 'dynamic-user']);
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

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
 * Default; running jobs and unknown ownership always fail closed.
 */
export function planProviderDelete({ providerId, inventory, activeJobs = [], replacementDefault = null, expectedRevision } = {}) {
  const id = text(providerId);
  if (!id) return fail('PROVIDER_NOT_FOUND');
  const record = recordById(inventory, id);
  if (!record) return fail('PROVIDER_NOT_FOUND');
  if (!DELETEABLE_OWNERSHIPS.has(record.ownership)) return fail('PROVIDER_OWNERSHIP_AMBIGUOUS');
  if (record.desired_state === 'absent') return fail('PROVIDER_ALREADY_ABSENT');
  if (activeJobCount(record, activeJobs) > 0) return fail('PROVIDER_IN_USE');

  const replacement = text(replacementDefault);
  if (record.references?.harness_default) {
    if (!replacement || replacement === id || !recordById(inventory, replacement) || recordById(inventory, replacement)?.desired_state === 'absent') {
      return fail('PROVIDER_DEFAULT_REPLACEMENT_REQUIRED');
    }
  }

  return {
    ok: true,
    plan: {
      plan_id: randomUUID(),
      provider_id: id,
      provider: { id, display_name: text(record.display_name) ?? id },
      expected_revision: text(expectedRevision) ?? text(record.declaration?.revision),
      replacement_default: replacement,
      will_remove: [
        'profile declaration', 'runtime desired registration',
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
export async function executeProviderDelete(plan, hooks = {}) {
  let state = 'PLANNED';
  const events = [];
  pushState(events, state);
  let errorCode = null;
  let verification = null;
  let mutationsStarted = false;
  let rollbackAttempted = false;
  let rollbackErrorCode = null;
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
    const restarted = await hooks.restart(plan);
    if (restarted?.ok === false) throw Object.assign(new Error('provider delete restart failed'), { code: restarted.code });
    if (typeof hooks.verify !== 'function') throw hookError('verify');
    transition('VERIFYING');
    verification = await hooks.verify(plan);
    if (verification?.providerAbsent !== true || verification?.routingClear !== true || verification?.tombstonePresent !== true) {
      throw Object.assign(new Error('provider delete verification incomplete'), { code: 'PROVIDER_DELETE_VERIFY_FAILED' });
    }
    transition('VERIFIED');
  } catch (error) {
    errorCode = boundedCode(error?.code);
    if (mutationsStarted && typeof hooks.rollback === 'function') {
      rollbackAttempted = true;
      try {
        await hooks.rollback(plan);
      } catch (rollbackError) {
        rollbackErrorCode = boundedCode(rollbackError?.code, 'PROVIDER_DELETE_ROLLBACK_FAILED');
      }
    }
    if (state !== 'FAILED' && canTransitionProviderDelete(state, 'FAILED')) transition('FAILED');
  }
  return {
    transaction_id: plan?.plan_id ?? null,
    provider_id: plan?.provider_id ?? null,
    state,
    error_code: errorCode,
    rollback_attempted: rollbackAttempted,
    rollback_error_code: rollbackErrorCode,
    verification,
    events,
  };
}
