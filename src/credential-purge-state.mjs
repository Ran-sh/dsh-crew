// Durable, secret-free audit state for irreversible Crew credential purges.

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const MAX_RECORDS = 128;

function validId(value) { return typeof value === 'string' && ID_PATTERN.test(value); }

export function normalizeCredentialPurgeState(input = {}) {
  const purged = {};
  const unverified = {};
  const entries = input && typeof input === 'object' && !Array.isArray(input) && input.purged && typeof input.purged === 'object' && !Array.isArray(input.purged)
    ? Object.entries(input.purged) : [];
  for (const [referenceId, record] of entries.slice(-MAX_RECORDS)) {
    if (!validId(referenceId) || !record || typeof record !== 'object' || Array.isArray(record) || !validId(record.transaction_id)) continue;
    purged[referenceId] = { transaction_id: record.transaction_id };
  }
  const pending = input && typeof input === 'object' && !Array.isArray(input) && input.unverified && typeof input.unverified === 'object' && !Array.isArray(input.unverified)
    ? Object.entries(input.unverified) : [];
  for (const [referenceId, record] of pending.slice(-MAX_RECORDS)) {
    if (!validId(referenceId) || !record || typeof record !== 'object' || Array.isArray(record)
      || !validId(record.transaction_id) || record.state !== 'PURGED') continue;
    unverified[referenceId] = { transaction_id: record.transaction_id, state: 'PURGED' };
  }
  return { schema_version: 1, purged, unverified };
}

export function markCredentialPurged(input, plan) {
  const state = normalizeCredentialPurgeState(input);
  if (!validId(plan?.reference_id) || !validId(plan?.plan_id)) return state;
  const unverified = { ...state.unverified };
  delete unverified[plan.reference_id];
  return {
    schema_version: 1,
    purged: { ...state.purged, [plan.reference_id]: { transaction_id: plan.plan_id } },
    unverified,
  };
}

export function markCredentialPurgeUnverified(input, plan) {
  const state = normalizeCredentialPurgeState(input);
  if (!validId(plan?.reference_id) || !validId(plan?.plan_id)) return state;
  const purged = { ...state.purged };
  delete purged[plan.reference_id];
  return {
    schema_version: 1,
    purged,
    unverified: { ...state.unverified, [plan.reference_id]: { transaction_id: plan.plan_id, state: 'PURGED' } },
  };
}

export function recordCredentialPurgeOutcome(input, plan, result) {
  if (result?.state === 'VERIFIED') return markCredentialPurged(input, plan);
  if (result?.state === 'PURGED') return markCredentialPurgeUnverified(input, plan);
  return normalizeCredentialPurgeState(input);
}

export function isCredentialPurged(input, referenceId) {
  return Object.prototype.hasOwnProperty.call(normalizeCredentialPurgeState(input).purged, referenceId);
}
