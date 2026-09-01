import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCredentialReferenceInventory } from '../src/credential-reference-inventory.mjs';
import { markCredentialPurged, normalizeCredentialPurgeState, recordCredentialPurgeOutcome } from '../src/credential-purge-state.mjs';

test('credential purge state is bounded, immutable, and secret-free', () => {
  const input = { schema_version: 1, purged: { 'env:OLD': { transaction_id: 'tx-old' } }, ignored: 'x' };
  const normalized = normalizeCredentialPurgeState(input);
  assert.deepEqual(normalized, { schema_version: 1, purged: { 'env:OLD': { transaction_id: 'tx-old' } }, unverified: {} });
  const marked = markCredentialPurged(normalized, { reference_id: 'env:NEW', plan_id: 'tx-new', name_or_handle: 'NEW', secret: 'do-not-copy' });
  assert.deepEqual(marked.purged['env:NEW'], { transaction_id: 'tx-new' });
  assert.deepEqual(normalized, { schema_version: 1, purged: { 'env:OLD': { transaction_id: 'tx-old' } }, unverified: {} });
  assert.equal(JSON.stringify(marked).includes('do-not-copy'), false);
});

test('credential purge state ignores malformed and unbounded records', () => {
  const state = normalizeCredentialPurgeState({ purged: { bad: 'x', 'env:OK': { transaction_id: 'tx' }, 'env:OTHER': { transaction_id: 7 } } });
  assert.deepEqual(state, { schema_version: 1, purged: { 'env:OK': { transaction_id: 'tx' } }, unverified: {} });
});

test('PURGED verification failure stays visible while only VERIFIED suppresses inventory', () => {
  const plan = { reference_id: 'env:OLD_KEY', plan_id: 'tx-new' };
  const unverified = recordCredentialPurgeOutcome({}, plan, { state: 'PURGED' });
  assert.deepEqual(unverified.purged, {});
  assert.deepEqual(unverified.unverified['env:OLD_KEY'], { transaction_id: 'tx-new', state: 'PURGED' });
  const visible = buildCredentialReferenceInventory({
    additional_refs: [{ kind: 'env', name_or_handle: 'OLD_KEY', ownership: 'crew' }],
    purged_refs: Object.keys(unverified.purged),
  });
  assert.equal(visible.records.some((entry) => entry.reference_id === 'env:OLD_KEY'), true);

  const verified = recordCredentialPurgeOutcome(unverified, plan, { state: 'VERIFIED' });
  assert.deepEqual(verified.purged['env:OLD_KEY'], { transaction_id: 'tx-new' });
  assert.equal(verified.unverified['env:OLD_KEY'], undefined);
  const hidden = buildCredentialReferenceInventory({
    additional_refs: [{ kind: 'env', name_or_handle: 'OLD_KEY', ownership: 'crew' }],
    purged_refs: Object.keys(verified.purged),
  });
  assert.equal(hidden.records.some((entry) => entry.reference_id === 'env:OLD_KEY'), false);
});
