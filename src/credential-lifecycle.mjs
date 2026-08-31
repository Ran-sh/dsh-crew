// Independent lifecycle planning for credential references. Actual purge is
// deliberately adapter-gated: provider deletion never implies credential
// deletion, and no default adapter reads or mutates secret stores.

import { createHash, randomUUID } from 'node:crypto';

export const CREDENTIAL_PURGE_STATES = Object.freeze([
  'PLANNED', 'REFERENCE_RECHECKED', 'PURGE_PENDING_CONFIRMATION', 'PURGED', 'VERIFIED', 'FAILED',
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;

function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function digest(value) { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }

export function planCredentialPurge({ inventory, referenceId, expectedRevision } = {}) {
  const id = text(referenceId);
  if (!id || !ID_PATTERN.test(id)) return { ok: false, code: 'CREDENTIAL_REFERENCE_INVALID' };
  const record = (Array.isArray(inventory?.records) ? inventory.records : []).find((entry) => entry?.reference_id === id);
  if (!record) return { ok: false, code: 'CREDENTIAL_REFERENCE_NOT_FOUND' };
  if (record.orphan !== true || Number(record.consumer_count) !== 0 || (record.consumers?.length ?? 0) !== 0) {
    return { ok: false, code: 'CREDENTIAL_REFERENCE_IN_USE' };
  }
  if (record.ownership !== 'crew-owned' || record.purge_capability !== 'eligible') {
    return { ok: false, code: 'CREDENTIAL_PURGE_NOT_ALLOWED' };
  }
  const revision = digest(record);
  if (expectedRevision !== undefined) {
    if (!REVISION_PATTERN.test(expectedRevision ?? '')) return { ok: false, code: 'CREDENTIAL_REFERENCE_REVISION_INVALID' };
    if (expectedRevision !== revision) return { ok: false, code: 'CREDENTIAL_REFERENCE_CHANGED' };
  }
  return {
    ok: true,
    plan: {
      plan_id: randomUUID(),
      reference_id: id,
      kind: text(record.kind),
      name_or_handle: text(record.name_or_handle),
      ownership: 'crew-owned',
      expected_revision: revision,
      state: 'PLANNED',
      irreversible: true,
    },
  };
}

export async function executeCredentialPurge(plan, hooks = {}) {
  if (!plan?.plan_id || !plan?.reference_id) return { ok: false, code: 'CREDENTIAL_PURGE_PLAN_INVALID' };
  if (plan.state !== 'PLANNED') return { ok: false, code: 'CREDENTIAL_PURGE_PLAN_STATE_INVALID' };
  if (plan.ownership !== 'crew-owned' || plan.purge_capability !== 'eligible') {
    return { ok: false, code: 'CREDENTIAL_PURGE_NOT_ALLOWED' };
  }
  if (plan.irreversible !== true) return { ok: false, code: 'CREDENTIAL_PURGE_PLAN_INVALID' };
  if (!REVISION_PATTERN.test(plan.expected_revision ?? '')) return { ok: false, code: 'CREDENTIAL_REFERENCE_REVISION_INVALID' };
  if (typeof hooks.recheck === 'function') {
    const current = await hooks.recheck(plan.reference_id);
    if (current?.ok !== true || current.revision !== plan.expected_revision || current.orphan !== true
      || current.ownership !== 'crew-owned' || current.purge_capability !== 'eligible') {
      return { ok: false, code: 'CREDENTIAL_REFERENCE_CHANGED' };
    }
  }
  if (typeof hooks.purge !== 'function' || typeof hooks.verify !== 'function') {
    return { ok: false, code: 'CREDENTIAL_PURGE_UNAVAILABLE', state: 'PURGE_PENDING_CONFIRMATION' };
  }
  try {
    await hooks.purge(plan);
    const verified = await hooks.verify(plan);
    if (verified?.ok !== true) return { ok: false, code: 'CREDENTIAL_PURGE_VERIFY_FAILED', state: 'PURGED' };
    return { ok: true, state: 'VERIFIED', reference_id: plan.reference_id, transaction_id: plan.plan_id };
  } catch (error) {
    return { ok: false, code: text(error?.code) ?? 'CREDENTIAL_PURGE_FAILED', state: 'FAILED' };
  }
}
