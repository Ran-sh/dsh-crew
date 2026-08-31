import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markCredentialPurged, normalizeCredentialPurgeState } from '../src/credential-purge-state.mjs';

test('credential purge state is bounded, immutable, and secret-free', () => {
  const input = { schema_version: 1, purged: { 'env:OLD': { transaction_id: 'tx-old' } }, ignored: 'x' };
  const normalized = normalizeCredentialPurgeState(input);
  assert.deepEqual(normalized, { schema_version: 1, purged: { 'env:OLD': { transaction_id: 'tx-old' } } });
  const marked = markCredentialPurged(normalized, { reference_id: 'env:NEW', plan_id: 'tx-new', name_or_handle: 'NEW', secret: 'do-not-copy' });
  assert.deepEqual(marked.purged['env:NEW'], { transaction_id: 'tx-new' });
  assert.deepEqual(normalized, { schema_version: 1, purged: { 'env:OLD': { transaction_id: 'tx-old' } } });
  assert.equal(JSON.stringify(marked).includes('do-not-copy'), false);
});

test('credential purge state ignores malformed and unbounded records', () => {
  const state = normalizeCredentialPurgeState({ purged: { bad: 'x', 'env:OK': { transaction_id: 'tx' }, 'env:OTHER': { transaction_id: 7 } } });
  assert.deepEqual(state, { schema_version: 1, purged: { 'env:OK': { transaction_id: 'tx' } } });
});
