import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCredentialPurge, executeCredentialPurge } from '../src/credential-lifecycle.mjs';

const inventory = {
  records: [{
    reference_id: 'crew-store:ref-1', kind: 'crew-store', name_or_handle: 'ref-1',
    ownership: 'crew-owned', consumers: [], consumer_count: 0, orphan: true, purge_capability: 'eligible',
  }],
};

test('credential purge plan requires an orphan Crew-owned reference', () => {
  const result = planCredentialPurge({ inventory, referenceId: 'crew-store:ref-1' });
  assert.equal(result.ok, true);
  assert.equal(result.plan.reference_id, 'crew-store:ref-1');
  assert.equal(result.plan.state, 'PLANNED');
  assert.match(result.plan.expected_revision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('credential purge plan refuses in-use, external, and unknown references', () => {
  for (const record of [
    { ...inventory.records[0], orphan: false, consumer_count: 1, consumers: ['p'] },
    { ...inventory.records[0], ownership: 'external' },
    { ...inventory.records[0], ownership: 'unknown' },
  ]) {
    const result = planCredentialPurge({ inventory: { records: [record] }, referenceId: record.reference_id });
    assert.equal(result.ok, false);
    assert.match(result.code, /^CREDENTIAL_/);
  }
});

test('credential purge plan rejects a stale reference revision', () => {
  const result = planCredentialPurge({ inventory, referenceId: 'crew-store:ref-1', expectedRevision: 'a'.repeat(64) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CREDENTIAL_REFERENCE_CHANGED');
});

test('credential purge execution fails closed without an explicit adapter', async () => {
  const result = await executeCredentialPurge({ plan_id: 'tx-1', reference_id: 'crew-store:ref-1' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CREDENTIAL_PURGE_UNAVAILABLE');
});
