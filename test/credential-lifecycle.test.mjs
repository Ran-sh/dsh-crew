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
  const result = await executeCredentialPurge({
    plan_id: 'tx-1', reference_id: 'crew-store:ref-1', ownership: 'crew-owned',
    purge_capability: 'eligible', irreversible: true, state: 'PLANNED', expected_revision: 'a'.repeat(64),
  }, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CREDENTIAL_PURGE_UNAVAILABLE');
});

test('credential purge execution rejects unsafe caller-supplied plans before adapter invocation', async () => {
  const base = { plan_id: 'tx-1', reference_id: 'crew-store:ref-1', irreversible: true, state: 'PLANNED', expected_revision: 'a'.repeat(64), purge_capability: 'eligible' };
  for (const plan of [
    { ...base, ownership: 'external' },
    { ...base, ownership: 'crew-owned', purge_capability: 'report-only' },
    { ...base, ownership: 'crew-owned', state: 'PURGED' },
    { ...base, ownership: 'crew-owned', expected_revision: 'stale' },
  ]) {
    let called = false;
    const result = await executeCredentialPurge(plan, { purge: async () => { called = true; }, verify: async () => ({ ok: true }) });
    assert.equal(result.ok, false);
    assert.equal(called, false);
    assert.match(result.code, /^CREDENTIAL_/);
  }
});

test('credential purge execution rechecks the reference revision before purging', async () => {
  const plan = { plan_id: 'tx-1', reference_id: 'crew-store:ref-1', ownership: 'crew-owned', purge_capability: 'eligible', irreversible: true, state: 'PLANNED', expected_revision: 'a'.repeat(64) };
  let called = false;
  const result = await executeCredentialPurge(plan, {
    recheck: async () => ({ ok: true, revision: 'b'.repeat(64), orphan: true, ownership: 'crew-owned', purge_capability: 'eligible' }),
    purge: async () => { called = true; }, verify: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CREDENTIAL_REFERENCE_CHANGED');
  assert.equal(called, false);
});
