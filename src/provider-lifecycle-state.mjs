// Persistent, secret-free lifecycle intent for Harness provider management.
// Tombstones prevent an explicitly removed managed route from being re-seeded;
// transactions retain only bounded audit metadata needed for recovery.

import { classifyCredentialReference } from './credential-reference.mjs';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const STATES = new Set([
  'PLANNED', 'BLOCKED', 'APPLIED', 'RESTART_PENDING', 'VERIFYING',
  'VERIFIED', 'ROLLBACK_PENDING', 'ROLLED_BACK', 'FAILED',
]);

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function validRevision(value) {
  return typeof value === 'string' && REVISION_PATTERN.test(value);
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length >= 16 && value.length <= 64;
}

function normalizedCredentialRefs(value) {
  if (!Array.isArray(value)) return undefined;
  const refs = value.map((ref) => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
    const kind = typeof ref.kind === 'string' && ref.kind.trim() ? ref.kind.trim() : null;
    const name = typeof ref.name_or_handle === 'string' && ref.name_or_handle.trim() ? ref.name_or_handle.trim() : null;
    const ownership = typeof ref.ownership === 'string' && ref.ownership.trim() ? ref.ownership.trim() : null;
    const safeName = classifyCredentialReference(name, { kind }).value;
    return kind && safeName && ownership ? { kind, name_or_handle: safeName, ownership } : null;
  }).filter(Boolean).slice(0, 32);
  return refs;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedTransaction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!validId(value.provider_id) || typeof value.state !== 'string' || !STATES.has(value.state)) return null;
  const refs = normalizedCredentialRefs(value.credential_refs);
  return {
    provider_id: value.provider_id,
    state: value.state,
    ...(validTimestamp(value.updated_at) ? { updated_at: value.updated_at } : {}),
    ...(validRevision(value.expected_revision) ? { expected_revision: value.expected_revision } : {}),
    ...(refs === undefined ? {} : { credential_refs: refs }),
  };
}

/** Normalize persisted lifecycle metadata; unknown fields and secret values are discarded. */
export function normalizeProviderLifecycleState(input = {}) {
  const out = { schema_version: 1, tombstones: {}, transactions: {}, last_verified_revision: {} };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  if (input.tombstones && typeof input.tombstones === 'object' && !Array.isArray(input.tombstones)) {
    for (const [id, value] of Object.entries(input.tombstones)) if (validId(id) && value === 'absent') out.tombstones[id] = 'absent';
  }
  if (input.transactions && typeof input.transactions === 'object' && !Array.isArray(input.transactions)) {
    for (const [transactionId, value] of Object.entries(input.transactions)) {
      if (!validId(transactionId)) continue;
      const transaction = normalizedTransaction(value);
      if (transaction) out.transactions[transactionId] = transaction;
    }
  }
  if (input.last_verified_revision && typeof input.last_verified_revision === 'object' && !Array.isArray(input.last_verified_revision)) {
    for (const [id, revision] of Object.entries(input.last_verified_revision)) if (validId(id) && validRevision(revision)) out.last_verified_revision[id] = revision;
  }
  return out;
}

function requireProviderId(providerId) {
  if (!validId(providerId)) throw new TypeError('provider id must be a bounded identifier');
  return providerId;
}

export function markProviderTombstone(state, providerId) {
  const id = requireProviderId(providerId);
  const out = normalizeProviderLifecycleState(state);
  out.tombstones[id] = 'absent';
  return out;
}

export function clearProviderTombstone(state, providerId) {
  const id = requireProviderId(providerId);
  const out = normalizeProviderLifecycleState(state);
  delete out.tombstones[id];
  return out;
}

/** Record non-secret transaction metadata and credential reference names only. */
export function recordProviderTransaction(state, transaction = {}) {
  const transactionId = requireProviderId(transaction.transaction_id ?? transaction.plan_id);
  const normalized = normalizedTransaction(transaction);
  if (!normalized) throw new TypeError('provider transaction metadata is invalid');
  const out = normalizeProviderLifecycleState(state);
  out.transactions[transactionId] = clone(normalized);
  return out;
}
