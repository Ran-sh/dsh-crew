import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHubRuntimeIdentity, HUB_COMPATIBILITY_CODES } from '../src/runtime-identity.mjs';
import { hubAvailable, hubStatus } from '../src/hub-client.mjs';

test('Hub client distinguishes compatible, stale, HTTP-error and unreachable states', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, ...getHubRuntimeIdentity() }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  let status = await hubStatus({ force: true });
  assert.equal(status.reachable, true);
  assert.equal(status.compatible, true);
  assert.equal(status.code, null);
  assert.equal(await hubAvailable(), true);

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, service: 'dsh-crew-hub' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  status = await hubStatus({ force: true });
  assert.equal(status.reachable, true);
  assert.equal(status.compatible, false);
  assert.equal(status.code, HUB_COMPATIBILITY_CODES.PROTOCOL_MISSING);
  assert.equal(await hubAvailable(), false);

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
  status = await hubStatus({ force: true });
  assert.equal(status.reachable, true);
  assert.equal(status.compatible, false);
  assert.equal(status.code, HUB_COMPATIBILITY_CODES.HTTP_ERROR);
  assert.equal(status.http_status, 503);

  globalThis.fetch = async () => { throw new Error('offline'); };
  status = await hubStatus({ force: true });
  assert.equal(status.reachable, false);
  assert.equal(status.compatible, false);
  assert.equal(status.code, HUB_COMPATIBILITY_CODES.UNREACHABLE);
});
