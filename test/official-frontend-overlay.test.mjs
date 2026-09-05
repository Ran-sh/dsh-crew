import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { registerFrontend } from '../official-web-bridge/overlay-entry.mjs';

function setup(fetchImpl) {
  const routes = [];
  registerFrontend({ inject(_deps, setup) { return setup({ webServer: { register(route) { routes.push(route); return () => {}; } } }); } }, { fetchImpl });
  return routes;
}
function request(body = '', overrides = {}) {
  return Object.assign(Readable.from([Buffer.from(body)]), { method: 'GET', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } }, overrides);
}
function response() { return { status: null, value: null, writeHead(code) { this.status = code; }, end(body) { this.value = JSON.parse(body); } }; }
const identity = { ok: true, service: 'dsh-crew-hub', profile: 'dsh-crew', execution_plane: 'hub-3210', listen_port: 3210, protocol_version: 1 };

test('overlay exposes only quick settings/status and never runtime lifecycle', () => {
  assert.deepEqual(setup().map(r=>r.path), ['/_dsh/dsh-crew/bridge-status','/_dsh/dsh-crew/quick-config','/_dsh/dsh-crew/quick-status']);
});

test('overlay verifies backend identity and never forwards official authentication', async () => {
  const calls = [];
  const routes = setup(async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/runtime') ? identity : { ok: true, config: {} });
  });
  const res = response();
  await routes[1].handler(request('{"subagents_enabled":true}', { method:'POST', headers:{host:'127.0.0.1:3080',cookie:'private-session',authorization:'private-auth'} }), res);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'http://127.0.0.1:3210/_dsh/dsh-crew/quick-config');
  assert.equal(calls[1].options.headers.cookie, undefined);
  assert.equal(calls[1].options.headers.authorization, undefined);
});

test('overlay refuses foreign origins and a mismatched backend before configuration writes', async () => {
  let calls = 0;
  const routes = setup(async () => { calls++; return Response.json({ ...identity, profile: 'other' }); });
  const foreign = response();
  await routes[1].handler(request('', { headers:{host:'127.0.0.1:3080',origin:'https://example.invalid'} }), foreign);
  assert.equal(foreign.status, 403); assert.equal(calls, 0);
  const wrongBackend = response();
  await routes[1].handler(request('{}', {method:'POST'}), wrongBackend);
  assert.equal(wrongBackend.status, 503); assert.equal(calls, 1);
});
