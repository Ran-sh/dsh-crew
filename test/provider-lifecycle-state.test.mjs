import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProviderLifecycleState,
  markProviderTombstone,
  clearProviderTombstone,
  recordProviderTransaction,
} from '../src/provider-lifecycle-state.mjs';

test('lifecycle state normalizes malformed input to a bounded schema', () => {
  const result = normalizeProviderLifecycleState({
    schema_version: 99,
    tombstones: { 'opencode-go': 'absent', bad: 'present', '': 'absent' },
    transactions: { tx1: { provider_id: 'opencode-go', state: 'VERIFIED' }, bad: 'raw' },
    last_verified_revision: { 'opencode-go': 'a'.repeat(64), bad: 'not-a-revision' },
  });
  assert.deepEqual(result, {
    schema_version: 1,
    tombstones: { 'opencode-go': 'absent' },
    transactions: { tx1: { provider_id: 'opencode-go', state: 'VERIFIED' } },
    last_verified_revision: { 'opencode-go': 'a'.repeat(64) },
  });
});

test('tombstone updates are immutable and clear symmetrically', () => {
  const initial = normalizeProviderLifecycleState();
  const marked = markProviderTombstone(initial, 'opencode-go');
  assert.deepEqual(initial.tombstones, {});
  assert.equal(marked.tombstones['opencode-go'], 'absent');
  const cleared = clearProviderTombstone(marked, 'opencode-go');
  assert.deepEqual(cleared.tombstones, {});
  assert.throws(() => markProviderTombstone(initial, ''), /provider id/);
});

test('transaction records are bounded and never retain credential values', () => {
  const state = normalizeProviderLifecycleState();
  const next = recordProviderTransaction(state, {
    transaction_id: 'tx-1', provider_id: 'opencode-go', state: 'VERIFIED',
    expected_revision: 'b'.repeat(64), credential_refs: [{ kind: 'env', name_or_handle: 'KEY', ownership: 'external', value: 'SECRET' }],
  });
  assert.deepEqual(next.transactions['tx-1'], {
    provider_id: 'opencode-go', state: 'VERIFIED', expected_revision: 'b'.repeat(64),
    credential_refs: [{ kind: 'env', name_or_handle: 'KEY', ownership: 'external' }],
  });
  assert.equal(JSON.stringify(next).includes('SECRET'), false);
});
