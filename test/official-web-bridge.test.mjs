import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import {
  CREW_BRIDGE_PREFIX,
  CREW_BRIDGE_TARGET,
  createCrewSidecarSupervisor,
  isLoopbackAddress,
  isTrustedLocalRequest,
  proxyCrewRequest,
  registerOfficialWebBridge,
} from '../src/official-web-bridge.mjs';

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value = '') { this.body = Buffer.isBuffer(value) ? value : Buffer.from(value); },
  };
}

test('bridge is fixed to the loopback Crew backend and accepts loopback clients only', () => {
  assert.equal(CREW_BRIDGE_PREFIX, '/_dsh/dsh-crew');
  assert.equal(CREW_BRIDGE_TARGET, 'http://127.0.0.1:3210');
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(address), true);
  for (const address of ['10.0.0.2', '192.168.1.8', undefined]) assert.equal(isLoopbackAddress(address), false);
});

test('browser requests must use a local Host and a same-origin Origin', () => {
  const request = (headers = {}, remoteAddress = '127.0.0.1') => ({ socket: { remoteAddress }, headers });
  assert.equal(isTrustedLocalRequest(request({ host: '127.0.0.1:3080' })), true);
  assert.equal(isTrustedLocalRequest(request({ host: 'localhost:3080', origin: 'http://localhost:3080' })), true);
  assert.equal(isTrustedLocalRequest(request({ host: '[::1]:3080', origin: 'http://[::1]:3080' }, '::1')), true);
  assert.equal(isTrustedLocalRequest(request({ host: 'evil.example:3080' })), false);
  assert.equal(isTrustedLocalRequest(request({ host: '127.0.0.1:3080', origin: 'https://evil.example' })), false);
  assert.equal(isTrustedLocalRequest(request({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })), false);
});

test('proxy preserves the Crew path/query/body but strips hop-by-hop request headers', async () => {
  let upstream;
  const req = Readable.from([Buffer.from('{"role":"worker"}')]);
  Object.assign(req, {
    method: 'POST',
    url: '/_dsh/dsh-crew/spawn?wait=1',
    headers: {
      host: '127.0.0.1:3080',
      connection: 'keep-alive',
      'content-length': '17',
      'content-type': 'application/json',
      'x-request-id': 'safe-id',
    },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = responseRecorder();
  await proxyCrewRequest(req, res, {
    ensureBackend: async () => ({ ok: true }),
    fetchImpl: async (url, init) => {
      upstream = { url, init, body: Buffer.from(await init.body.arrayBuffer()).toString('utf8') };
      return new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json', connection: 'close' } });
    },
  });
  assert.equal(upstream.url, 'http://127.0.0.1:3210/_dsh/dsh-crew/spawn?wait=1');
  assert.equal(upstream.init.method, 'POST');
  assert.equal(upstream.body, '{"role":"worker"}');
  assert.equal(upstream.init.headers.host, undefined);
  assert.equal(upstream.init.headers.connection, undefined);
  assert.equal(upstream.init.headers['content-length'], undefined);
  assert.equal(upstream.init.headers['content-type'], 'application/json');
  assert.equal(res.status, 201);
  assert.equal(res.headers.connection, undefined);
  assert.equal(res.headers['x-dsh-crew-bridge'], '3080-to-3210');
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test('proxy rejects non-loopback callers and never leaks backend failure details', async () => {
  const deniedReq = Readable.from([]);
  Object.assign(deniedReq, { method: 'GET', url: `${CREW_BRIDGE_PREFIX}/ping`, headers: {}, socket: { remoteAddress: '10.1.2.3' } });
  const deniedRes = responseRecorder();
  let fetched = false;
  await proxyCrewRequest(deniedReq, deniedRes, { fetchImpl: async () => { fetched = true; } });
  assert.equal(deniedRes.status, 403);
  assert.equal(fetched, false);

  const failedReq = Readable.from([]);
  Object.assign(failedReq, { method: 'GET', url: `${CREW_BRIDGE_PREFIX}/ping`, headers: {}, socket: { remoteAddress: '::1' } });
  const failedRes = responseRecorder();
  await proxyCrewRequest(failedReq, failedRes, {
    ensureBackend: async () => { throw new Error('SECRET-INTERNAL-PATH'); },
    fetchImpl: async () => { throw new Error('SECRET-UPSTREAM-TOKEN'); },
  });
  assert.equal(failedRes.status, 503);
  assert.equal(failedRes.body.toString('utf8').includes('SECRET'), false);
  assert.deepEqual(JSON.parse(failedRes.body), { ok: false, code: 'CREW_BACKEND_UNAVAILABLE' });
});

test('proxy rejects a cross-site browser request before backend startup', async () => {
  const req = Readable.from([]);
  Object.assign(req, {
    method: 'POST',
    url: `${CREW_BRIDGE_PREFIX}/spawn`,
    headers: { host: '127.0.0.1:3080', origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = responseRecorder();
  let started = false;
  await proxyCrewRequest(req, res, { ensureBackend: async () => { started = true; return { ok: true }; } });
  assert.equal(res.status, 403);
  assert.equal(started, false);
  assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'LOCAL_SAME_ORIGIN_ONLY' });
});

test('sidecar supervisor coalesces concurrent starts and launches only the isolated profile', async () => {
  const home = 'C:\\Users\\test';
  const runtime = join(home, '.config', 'dsh-crew', 'harness', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const spawns = [];
  let healthChecks = 0;
  const supervisor = createCrewSidecarSupervisor({
    home,
    exists: (file) => file === runtime,
    healthCheck: async () => (++healthChecks > 2),
    spawnImpl: (command, args, options) => {
      spawns.push({ command, args, options });
      return { unref() {} };
    },
    wait: async () => {},
  });
  const [first, second] = await Promise.all([supervisor.ensure(), supervisor.ensure()]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.execPath);
  assert.deepEqual(spawns[0].args, [runtime, '--profile', 'dsh-crew', '--host', '127.0.0.1', '--port', '3210']);
  assert.equal(spawns[0].options.env.DSH_HOME, join(home, '.config', 'dsh-crew', 'harness'));
  assert.equal(spawns[0].options.windowsHide, true);
  assert.equal(spawns[0].options.detached, true);
});

test('official bridge registers a status endpoint and the Crew API prefix', () => {
  const registrations = [];
  const ctx = {
    inject(deps, setup) {
      assert.deepEqual(deps, ['webServer']);
      return setup({ webServer: { register(value) { registrations.push(value); return () => {}; } } });
    },
  };
  registerOfficialWebBridge(ctx, { ensureBackend: async () => ({ ok: true }) });
  assert.deepEqual(registrations.map(({ kind, path }) => ({ kind, path })), [
    { kind: 'exact', path: '/_dsh/dsh-crew/bridge-status' },
    { kind: 'prefix', path: CREW_BRIDGE_PREFIX },
  ]);
});
