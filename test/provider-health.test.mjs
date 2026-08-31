import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_HEALTH_STATES,
  classifyProviderError,
  createProviderHealthStore,
} from '../src/provider-health.mjs';

test('provider error classifier distinguishes credential, quota, rate, timeout and internal failures', () => {
  assert.equal(classifyProviderError({ code: 'MISSING_CREDENTIAL' }).state, 'credential-missing');
  assert.equal(classifyProviderError({ message: 'monthly account quota exhausted' }).state, 'quota-exhausted');
  assert.equal(classifyProviderError({ status: 429, message: 'too many requests' }).state, 'rate-limited');
  assert.equal(classifyProviderError({ name: 'TimeoutError' }).state, 'timeout');
  assert.equal(classifyProviderError({ status: 500 }).state, 'internal-error');
  assert.equal(classifyProviderError({ message: 'opaque upstream failure' }).state, 'internal-error');
  assert.deepEqual(Object.keys(classifyProviderError({ code: 'MISSING_CREDENTIAL', message: 'SECRET' })), ['state', 'reason_code']);
});

test('health store records callable state and newer failures override older success', () => {
  let now = 1_000;
  const store = createProviderHealthStore({ clock: () => now });
  assert.equal(store.get('opencode-muse', 'mimo-v2.5').state, 'unprobed');
  store.record('opencode-muse', 'mimo-v2.5', { ok: true, observed_at: 900 });
  assert.equal(store.get('opencode-muse', 'mimo-v2.5').state, 'callable');
  store.record('opencode-muse', 'mimo-v2.5', { error: { status: 500 }, observed_at: 1_000 });
  const current = store.get('opencode-muse', 'mimo-v2.5');
  assert.equal(current.state, 'internal-error');
  assert.equal(current.reason_code, 'PROVIDER_INTERNAL_ERROR');
  assert.equal(current.fresh, true);
  assert.equal('error' in current, false);
  now += 61_000;
  assert.equal(store.get('opencode-muse', 'mimo-v2.5').fresh, false);
});

test('health TTLs are bounded and stale records never remain callable', () => {
  let now = 10_000;
  const store = createProviderHealthStore({ clock: () => now });
  store.record('p', 'm', { error: { message: 'monthly quota exceeded' }, observed_at: now });
  const quota = store.get('p', 'm');
  assert.equal(quota.state, 'quota-exhausted');
  assert.ok(quota.expires_at > now);
  now = quota.expires_at + 1;
  const stale = store.get('p', 'm');
  assert.equal(stale.fresh, false);
  assert.equal(stale.state, 'unprobed');
  assert.deepEqual(PROVIDER_HEALTH_STATES, [
    'callable', 'credential-missing', 'quota-exhausted', 'rate-limited',
    'timeout', 'internal-error', 'disabled', 'not-configured', 'tombstoned', 'unprobed',
  ]);
});

test('older probe evidence cannot replace newer state and list is bounded', () => {
  const store = createProviderHealthStore({ clock: () => 100_000, maxEntries: 2 });
  store.record('p', 'm', { error: { status: 500 }, observed_at: 90_000 });
  store.record('p', 'm', { ok: true, observed_at: 80_000 });
  assert.equal(store.get('p', 'm').state, 'internal-error');
  store.record('p2', 'm', { ok: true, observed_at: 91_000 });
  store.record('p3', 'm', { ok: true, observed_at: 92_000 });
  assert.ok(store.list().length <= 2);
});
