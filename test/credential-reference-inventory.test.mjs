import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCredentialReferenceInventory } from '../src/credential-reference-inventory.mjs';

test('credential reference inventory counts consumers and keeps shared references non-orphan', () => {
  const result = buildCredentialReferenceInventory({
    providers: [
      { id: 'opencode-go', credential_refs: [{ kind: 'env', name_or_handle: 'SHARED_KEY', ownership: 'external' }] },
      { id: 'opencode-muse', credential_refs: [{ kind: 'env', name_or_handle: 'SHARED_KEY', ownership: 'external' }] },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.records, [{
    reference_id: 'env:SHARED_KEY',
    kind: 'env',
    name_or_handle: 'SHARED_KEY',
    ownership: 'external',
    consumers: ['opencode-go', 'opencode-muse'],
    consumer_count: 2,
    orphan: false,
    purge_capability: 'report-only',
  }]);
});

test('credential reference inventory marks orphan Crew-owned refs as purge eligible', () => {
  const result = buildCredentialReferenceInventory({
    providers: [{ id: 'crew-only', credential_refs: [{ kind: 'crew-store', name_or_handle: 'ref-123', ownership: 'crew' }] }],
  });
  assert.deepEqual(result.records[0], {
    reference_id: 'crew-store:ref-123',
    kind: 'crew-store',
    name_or_handle: 'ref-123',
    ownership: 'crew-owned',
    consumers: ['crew-only'],
    consumer_count: 1,
    orphan: false,
    purge_capability: 'eligible-after-last-consumer',
  });
  const orphan = buildCredentialReferenceInventory({ providers: [] , additional_refs: [{ kind: 'crew-store', name_or_handle: 'ref-123', ownership: 'crew' }] });
  assert.equal(orphan.records[0].orphan, true);
  assert.equal(orphan.records[0].purge_capability, 'eligible');
});

test('credential reference inventory ignores malformed refs and never exposes values', () => {
  const result = buildCredentialReferenceInventory({
    providers: [{ id: 'p', credential_refs: [{ kind: 'env', name_or_handle: 'KEY', ownership: 'external' }, { kind: 'env', name_or_handle: 'secret-value' }] }],
    additional_refs: [{ kind: 'env', name_or_handle: '', ownership: 'external' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('credential reference inventory omits references already purged by the Crew store', () => {
  const result = buildCredentialReferenceInventory({
    additional_refs: [{ kind: 'env', name_or_handle: 'OLD_KEY', ownership: 'crew' }],
    purged_refs: ['env:OLD_KEY'],
  });
  assert.deepEqual(result.records, []);
});
