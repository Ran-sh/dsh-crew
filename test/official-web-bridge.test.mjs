import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  CREW_BRIDGE_PREFIX,
  CREW_BRIDGE_TARGET,
  apply,
  createCrewSidecarSupervisor,
  defaultHealthCheck,
  defaultRuntimeIdentity,
  isLoopbackAddress,
  isTrustedLocalRequest,
  proxyCrewRequest,
  registerOfficialWebBridge,
  resolveCrewBridgeTarget,
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

test('production bridge ignores environment target overrides and stays on 3210', () => {
  assert.equal(resolveCrewBridgeTarget({ DSH_CREW_BRIDGE_TARGET: 'http://127.0.0.1:45678' }), CREW_BRIDGE_TARGET);
  for (const target of ['https://127.0.0.1:1', 'http://example.com:3210', 'http://0.0.0.0:3210/path']) {
    assert.equal(resolveCrewBridgeTarget({ DSH_CREW_BRIDGE_TARGET: target }), CREW_BRIDGE_TARGET);
  }
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
      'x-dsh-crew-ingress': 'spoofed',
    },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = responseRecorder();
  await proxyCrewRequest(req, res, {
    ensureBackend: async () => ({ ok: true }),
    fetchImpl: async (url, init) => {
      upstream = { url, init, body: Buffer.from(await init.body.arrayBuffer()).toString('utf8') };
      return new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json', connection: 'close', 'x-dsh-crew-ingress': 'spoofed-upstream' } });
    },
  });
  assert.equal(upstream.url, 'http://127.0.0.1:3210/_dsh/dsh-crew/spawn?wait=1');
  assert.equal(upstream.init.method, 'POST');
  assert.equal(upstream.body, '{"role":"worker"}');
  assert.equal(upstream.init.headers.host, undefined);
  assert.equal(upstream.init.headers.connection, undefined);
  assert.equal(upstream.init.headers['content-length'], undefined);
  assert.equal(upstream.init.headers['content-type'], 'application/json');
  assert.equal(upstream.init.headers['x-dsh-crew-bridge'], '3080-to-3210');
  assert.equal(upstream.init.headers['x-dsh-crew-execution-plane'], 'hub-3210');
  assert.equal(upstream.init.headers['x-dsh-crew-ingress'], 'official-3080');
  assert.equal(res.status, 201);
  assert.equal(res.headers.connection, undefined);
  assert.equal(res.headers['x-dsh-crew-bridge'], '3080-to-3210');
  assert.equal(res.headers['x-dsh-crew-ingress'], 'official-3080');
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test('proxy rejects non-loopback callers and never leaks backend failure details', async () => {
  const deniedReq = Readable.from([]);
  Object.assign(deniedReq, { method: 'GET', url: `${CREW_BRIDGE_PREFIX}/ping`, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '10.1.2.3' } });
  const deniedRes = responseRecorder();
  let fetched = false;
  await proxyCrewRequest(deniedReq, deniedRes, { fetchImpl: async () => { fetched = true; } });
  assert.equal(deniedRes.status, 403);
  assert.equal(fetched, false);

  const failedReq = Readable.from([]);
  Object.assign(failedReq, { method: 'GET', url: `${CREW_BRIDGE_PREFIX}/ping`, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '::1' } });
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

test('sidecar supervisor rejects an explicitly injected non-3210 target', () => {
  assert.throws(() => createCrewSidecarSupervisor({
    home: 'C:\\Users\\test', bridgeTarget: 'http://127.0.0.1:45678', exists: () => true,
  }), /fixed to the isolated 3210 Crew Hub/i);
});

test('sidecar supervisor never duplicates a still-running cold-start process after a timeout', async () => {
  const spawns = [];
  const child = { exitCode: null, unref() {} };
  const supervisor = createCrewSidecarSupervisor({
    home: 'C:\\Users\\test',
    exists: () => true,
    healthCheck: async () => false,
    spawnImpl: (...args) => { spawns.push(args); return child; },
    wait: async () => {},
    maxAttempts: 1,
  });
  assert.equal((await supervisor.ensure()).ok, false);
  assert.equal((await supervisor.ensure()).ok, false);
  assert.equal(spawns.length, 1);
});

test('sidecar health checks require the 3210 runtime handshake, not a generic ping', async () => {
  const valid = await defaultHealthCheck(async () => new Response(JSON.stringify({
    ok: true, execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1',
  }), { status: 200 }), CREW_BRIDGE_TARGET);
  assert.equal(valid, true);
  assert.deepEqual(await defaultRuntimeIdentity(async () => new Response(JSON.stringify({
    ok: true, execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1',
  }), { status: 200 }), CREW_BRIDGE_TARGET), {
    execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1',
  });
  const wrongProfile = await defaultHealthCheck(async () => new Response(JSON.stringify({
    ok: true, execution_plane: 'hub-3210', profile: 'web', listen_port: 3210, runtime_id: 'runtime-1',
  }), { status: 200 }), CREW_BRIDGE_TARGET);
  assert.equal(wrongProfile, false);
  const pingOnly = await defaultHealthCheck(async () => new Response('{"ok":true}', { status: 200 }), CREW_BRIDGE_TARGET);
  assert.equal(pingOnly, false);
});

test('sidecar supervisor restarts only the 3210 child it owns', async () => {
  const spawns = [];
  let healthy = false;
  const supervisor = createCrewSidecarSupervisor({
    home: 'C:\\Users\\test', exists: () => true,
    healthCheck: async () => healthy,
    spawnImpl: (...args) => {
      const listeners = new Map();
      const child = {
        killed: false, exitCode: null,
        once(name, callback) { listeners.set(name, callback); },
        unref() {},
        kill() { this.killed = true; this.exitCode = 0; healthy = false; listeners.get('exit')?.(0); return true; },
      };
      healthy = true;
      spawns.push({ args, child });
      return child;
    },
    wait: async () => {}, maxAttempts: 3,
  });
  assert.equal((await supervisor.ensure()).ok, true);
  const restarted = await supervisor.restartOwnedBackend();
  assert.equal(restarted.ok, true);
  assert.equal(restarted.restarted, true);
  assert.equal(spawns.length, 2);
  assert.equal(spawns[0].child.killed, true);
});

test('sidecar supervisor refuses to restart an unowned listener', async () => {
  const supervisor = createCrewSidecarSupervisor({
    home: 'C:\\Users\\test', exists: () => true,
    healthCheck: async () => true,
    spawnImpl: () => { throw new Error('must not spawn'); },
  });
  const result = await supervisor.restartOwnedBackend();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PORT_OWNERSHIP_CONFLICT');
});

test('sidecar supervisor refuses to adopt a healthy 3210 listener it did not spawn', async () => {
  const supervisor = createCrewSidecarSupervisor({
    home: 'C:\\Users\\test', exists: () => true,
    healthCheck: async () => true,
    spawnImpl: () => { throw new Error('must not spawn'); },
  });
  const result = await supervisor.ensure();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PORT_OWNERSHIP_CONFLICT');
});

test('sidecar supervisor refuses to adopt a persisted child without runtime_id', async () => {
  const ownershipFile = join(tmpdir(), `dsh-crew-supervisor-${process.pid}.json`);
  writeFileSync(ownershipFile, JSON.stringify({ schema_version: 1, pid: 4321, profile: 'dsh-crew', execution_plane: 'hub-3210', port: 3210 }));
  const killed = [];
  try {
    const supervisor = createCrewSidecarSupervisor({
      home: tmpdir(), ownershipFile, exists: () => true,
      healthCheck: async () => true,
      killImpl: (pid) => { killed.push(pid); },
      runtimeIdentity: async () => ({ execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-2' }),
      spawnImpl: () => { throw new Error('must not spawn'); },
      wait: async () => {}, maxAttempts: 3,
    });
    const adopted = await supervisor.ensure();
    assert.equal(adopted.ok, false);
    assert.equal(adopted.code, 'PORT_OWNERSHIP_CONFLICT');
    assert.deepEqual(killed, [], 'missing runtime_id must never authorize a kill');
  } finally {
    rmSync(ownershipFile, { force: true });
  }
});

test('sidecar supervisor refuses to adopt on runtime_id mismatch', async () => {
  const ownershipFile = join(tmpdir(), `dsh-crew-supervisor-${process.pid}.json`);
  writeFileSync(ownershipFile, JSON.stringify({ schema_version: 1, pid: 4321, profile: 'dsh-crew', execution_plane: 'hub-3210', port: 3210, runtime_id: 'runtime-1' }));
  const killed = [];
  try {
    const supervisor = createCrewSidecarSupervisor({
      home: tmpdir(), ownershipFile, exists: () => true,
      healthCheck: async () => true,
      killImpl: (pid) => { killed.push(pid); },
      runtimeIdentity: async () => ({ execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-2' }),
      spawnImpl: () => { throw new Error('must not spawn'); },
      wait: async () => {}, maxAttempts: 3,
    });
    const adopted = await supervisor.ensure();
    assert.equal(adopted.ok, false);
    assert.equal(adopted.code, 'PORT_OWNERSHIP_CONFLICT');
    assert.deepEqual(killed, [], 'mismatched runtime_id must never authorize a kill');
  } finally {
    rmSync(ownershipFile, { force: true });
  }
});

test('sidecar supervisor adopts its persisted healthy child after the 3080 process restarts', async () => {
  const ownershipFile = join(tmpdir(), `dsh-crew-supervisor-${process.pid}.json`);
  writeFileSync(ownershipFile, JSON.stringify({ schema_version: 1, pid: 4321, profile: 'dsh-crew', execution_plane: 'hub-3210', port: 3210, runtime_id: 'runtime-2' }));
  let healthy = true;
  const killed = [];
  const spawns = [];
  try {
    const supervisor = createCrewSidecarSupervisor({
      home: tmpdir(), ownershipFile, exists: () => true,
      healthCheck: async () => healthy,
      killImpl: (pid) => { killed.push(pid); healthy = false; },
      runtimeIdentity: async () => ({ execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: healthy ? 'runtime-2' : 'runtime-1' }),
      spawnImpl: (...args) => {
        const child = { pid: 9876, killed: false, exitCode: null, once() {}, unref() {}, kill() { this.killed = true; healthy = false; return true; } };
        spawns.push({ args, child });
        healthy = true;
        return child;
      },
      wait: async () => {}, maxAttempts: 3,
    });
    const adopted = await supervisor.ensure();
    assert.deepEqual(adopted, { ok: true, started: false, adopted: true, owned: true });
    const restarted = await supervisor.restartOwnedBackend();
    assert.equal(restarted.ok, true);
    assert.deepEqual(killed, [4321]);
    assert.equal(spawns.length, 1);
  } finally {
    rmSync(ownershipFile, { force: true });
  }
});

test('stopOwnedBackend never kills on null or mismatched ownership identity', async () => {
  for (const record of [
    { schema_version: 1, pid: 4321, profile: 'dsh-crew', execution_plane: 'hub-3210', port: 3210 },
    { schema_version: 1, pid: 4321, profile: 'dsh-crew', execution_plane: 'hub-3210', port: 3210, runtime_id: 'runtime-1' },
  ]) {
    const ownershipFile = join(tmpdir(), `dsh-crew-supervisor-${process.pid}.json`);
    writeFileSync(ownershipFile, JSON.stringify(record));
    const killed = [];
    try {
      const supervisor = createCrewSidecarSupervisor({
        home: tmpdir(), ownershipFile, exists: () => true,
        healthCheck: async () => true,
        killImpl: (pid) => { killed.push(pid); },
        runtimeIdentity: async () => ({ execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-2' }),
        spawnImpl: () => { throw new Error('must not spawn'); },
        wait: async () => {}, maxAttempts: 3,
      });
      const stopped = await supervisor.stopOwnedBackend();
      assert.equal(stopped.ok, false);
      assert.deepEqual(killed, [], 'null/mismatched identity must never kill');
    } finally {
      rmSync(ownershipFile, { force: true });
    }
  }
});

test('official bridge registers quick-status and the narrow quick allowlist', () => {
  const registrations = [];
  const ctx = {
    inject(deps, setup) {
      assert.deepEqual(deps, ['webServer']);
      return setup({ webServer: { register(value) { registrations.push(value); return () => {}; } } });
    },
  };
  registerOfficialWebBridge(ctx, { ensureBackend: async () => ({ ok: true }) });
  const paths = registrations.map(({ kind, path }) => `${kind}:${path}`);
  assert.deepEqual(paths, [
    'exact:/_dsh/dsh-crew/bridge-status',
    'exact:/_dsh/dsh-crew/supervisor/restart',
    'exact:/_dsh/dsh-crew/quick-config',
    'exact:/_dsh/dsh-crew/quick-status',
  ]);
  // NO prefix proxy: the full Crew API must not be reachable from 3080.
  assert.equal(registrations.some((entry) => entry.kind === 'prefix'), false);
  const response = responseRecorder();
  registrations[0].handler({
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
  }, response);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    mode: 'official-3080-quick-controls',
    surface: 'official-bridge',
    ui_role: 'quick-controls',
    execution_plane: 'hub-3210',
    listen_port: 3210,
    full_control_plane_url: 'http://127.0.0.1:3210/',
  });
});

test('bridge restart endpoint reports 410 Gone pointing at the 3210 control channel', async () => {
  const registrations = [];
  const ctx = { inject(_deps, setup) { return setup({ webServer: { register(value) { registrations.push(value); return () => {}; } } }); } };
  registerOfficialWebBridge(ctx, {});
  const handler = registrations.find((entry) => entry.path.endsWith('/supervisor/restart')).handler;
  const req = Readable.from([Buffer.from('{"confirm":true}')]);
  Object.assign(req, { method: 'POST', url: '/_dsh/dsh-crew/supervisor/restart', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } });
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.status, 410);
  const body = JSON.parse(res.body);
  assert.equal(body.code, 'SUPERVISOR_ENDPOINT_MOVED');
  assert.equal(body.control_plane, 'http://127.0.0.1:3210/');
});

test('Cordis apply registers the bridge without returning an invalid injected effect', async () => {
  const registrations = [];
  const ctx = {
    inject(_deps, setup) {
      return setup({ webServer: { register(value) { registrations.push(value); return () => {}; } } });
    },
  };
  assert.equal(await apply(ctx), undefined);
  assert.equal(registrations.length, 4);
});
