import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHubRuntimeIdentity, HUB_COMPATIBILITY_CODES } from '../src/runtime-identity.mjs';
import { hubAvailable, hubStatus } from '../src/hub-client.mjs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function routeFetch(routes) {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    const handler = routes[path];
    if (handler instanceof Error) throw handler;
    if (typeof handler === 'function') return handler();
    if (handler) return handler;
    return json({ ok: false, error: 'not found' }, 404);
  };
}

test('Hub client separates compatible, legacy, HTTP-error and unreachable states', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = routeFetch({
    '/_dsh/dsh-crew/ping': json({ ok: true, service: 'dsh-crew-hub' }),
    '/_dsh/dsh-crew/runtime': json({ ok: true, ...getHubRuntimeIdentity() }),
  });
  let status = await hubStatus({ force: true });
  assert.equal(status.reachable, true);
  assert.equal(status.compatible, true);
  assert.equal(status.code, null);
  assert.equal(await hubAvailable(), true);

  globalThis.fetch = routeFetch({
    '/_dsh/dsh-crew/ping': json({ ok: true, service: 'dsh-crew-hub' }),
    // old Hub: runtime endpoint is absent
  });
  status = await hubStatus({ force: true });
  assert.equal(status.reachable, true);
  assert.equal(status.compatible, false);
  assert.equal(status.code, HUB_COMPATIBILITY_CODES.PROTOCOL_MISSING);
  assert.equal(status.endpoint, 'runtime');
  assert.equal(await hubAvailable(), false);

  globalThis.fetch = routeFetch({
    '/_dsh/dsh-crew/ping': json({ ok: true, service: 'dsh-crew-hub' }),
    '/_dsh/dsh-crew/runtime': json({ ok: false }, 503),
  });
  status = await hubStatus({ force: true });
  assert.equal(status.reachable, true);
  assert.equal(status.compatible, false);
  assert.equal(status.code, HUB_COMPATIBILITY_CODES.HTTP_ERROR);
  assert.equal(status.http_status, 503);
  assert.equal(status.endpoint, 'runtime');

  globalThis.fetch = async () => { throw new Error('offline'); };
  status = await hubStatus({ force: true });
  assert.equal(status.reachable, false);
  assert.equal(status.compatible, false);
  assert.equal(status.code, HUB_COMPATIBILITY_CODES.UNREACHABLE);
});

test('Hub client surfaces protocol/capability mismatches from runtime endpoint', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const current = getHubRuntimeIdentity();

  globalThis.fetch = routeFetch({
    '/_dsh/dsh-crew/ping': json({ ok: true, service: 'dsh-crew-hub' }),
    '/_dsh/dsh-crew/runtime': json({ ...current, protocol_version: current.protocol_version + 1 }),
  });
  let status = await hubStatus({ force: true });
  assert.equal(status.reachable, true);
  assert.equal(status.compatible, false);
  assert.equal(status.code, HUB_COMPATIBILITY_CODES.PROTOCOL_MISMATCH);

  globalThis.fetch = routeFetch({
    '/_dsh/dsh-crew/ping': json({ ok: true, service: 'dsh-crew-hub' }),
    '/_dsh/dsh-crew/runtime': json({ ...current, capabilities: ['jobs'] }),
  });
  status = await hubStatus({ force: true });
  assert.equal(status.reachable, true);
  assert.equal(status.compatible, false);
  assert.equal(status.code, HUB_COMPATIBILITY_CODES.CAPABILITY_MISSING);
  assert.ok(status.missing_capabilities.includes('roles'));
});
