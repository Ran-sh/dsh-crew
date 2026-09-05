import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createSupervisorRequest,
  readRestartRequest,
  writeRestartResult,
  maintenanceRequestsDir,
  maintenanceResultsDir,
  maintenanceSessionFile,
} from '../src/supervisor/restart-request.mjs';
import { createCrewSupervisor } from '../src/install/npx-lifecycle.mjs';

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-maint-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const APProot = (home) => join(home, '.config', 'dsh-crew');

test('maintenance stop/start share one lease and identity across the stopped window', () => {
  const t = tempHome();
  try {
    const appRoot = APProot(t.dir);
    // Phase 1: stop request proves the LIVE identity.
    const stop = createSupervisorRequest({
      appRoot,
      operation: 'maintenance-stop',
      runtimeIdentity: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'rid-live' },
      reason: 'cohort migration',
    });
    assert.equal(stop.ok, true);
    const stopLease = stop.request.lease;
    assert.ok(stopLease.length > 0);
    assert.equal(stop.request.runtime_id, 'rid-live');
    // Supervisor would consume it; simulate the STOPPED result.
    writeRestartResult({ appRoot, request: stop.request, state: 'STOPPED', detail: { lease: stopLease, stopped_runtime_id: 'rid-live' } });
    // Phase 2: start reuses the SAME lease + proven identity (the process is
    // stopped by design and cannot re-prove itself).
    const start = createSupervisorRequest({
      appRoot,
      operation: 'maintenance-start',
      runtimeIdentity: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'rid-live' },
      lease: stopLease,
      extra: { expected_dsh_version: '0.1.2-rc.1' },
    });
    assert.equal(start.ok, true);
    assert.equal(start.request.lease, stopLease, 'stop and start share one lease');
    assert.equal(start.request.runtime_id, 'rid-live', 'start carries the stop-proven identity');
    assert.equal(start.request.operation, 'maintenance-start');
  } finally { t.cleanup(); }
});

test('maintenance requests land in the canonical supervisor dirs the launcher polls', () => {
  const t = tempHome();
  try {
    const appRoot = APProot(t.dir);
    const created = createSupervisorRequest({
      appRoot,
      operation: 'maintenance-stop',
      runtimeIdentity: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'rid-1' },
    });
    assert.equal(created.ok, true);
    // Exact canonical path: <appRoot>/supervisor/maintenance-requests/<id>.json
    const expected = join(appRoot, 'supervisor', 'maintenance-requests', `${created.request.request_id}.json`);
    assert.equal(created.file, expected);
    assert.equal(existsSync(expected), true);
    // No doubled supervisor/supervisor segment.
    assert.equal(created.file.includes(join('supervisor', 'supervisor')), false);
  } finally { t.cleanup(); }
});

test('maintenance request without runtime_id fails closed', () => {
  const t = tempHome();
  try {
    const created = createSupervisorRequest({
      appRoot: APProot(t.dir),
      operation: 'maintenance-start',
      runtimeIdentity: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: null },
      lease: 'some-lease',
    });
    assert.equal(created.ok, false);
    assert.equal(created.code, 'RUNTIME_IDENTITY_INCOMPLETE');
  } finally { t.cleanup(); }
});

test('maintenance requests and results live in separate dirs', () => {
  const t = tempHome();
  try {
    const appRoot = APProot(t.dir);
    assert.notEqual(maintenanceRequestsDir(appRoot), maintenanceResultsDir(appRoot));
    assert.ok(maintenanceRequestsDir(appRoot).endsWith('maintenance-requests'));
    assert.ok(maintenanceResultsDir(appRoot).endsWith('maintenance-results'));
  } finally { t.cleanup(); }
});

test('maintenance client resumes start with an externally persisted lease and identity', async () => {
  const t = tempHome();
  try {
    const appRoot = APProot(t.dir);
    const requests = [];
    let clock = 1_000;
    const sleep = async () => {
      const directory = maintenanceRequestsDir(appRoot);
      if (!existsSync(directory)) return;
      for (const name of (await import('node:fs')).readdirSync(directory)) {
        const request = JSON.parse(readFileSync(join(directory, name), 'utf8'));
        if (requests.some((entry) => entry.request_id === request.request_id)) continue;
        requests.push(request);
        mkdirSync(maintenanceResultsDir(appRoot), { recursive: true });
        const result = {
          schema_version: 1,
          request_id: request.request_id,
          operation: request.operation,
          state: request.operation === 'maintenance-stop' ? 'STOPPED' : 'VERIFIED',
          lease: request.lease,
          runtime_id: request.runtime_id,
          detail: request.operation === 'maintenance-stop'
            ? { lease: request.lease, stopped_runtime_id: request.runtime_id }
            : { lease: request.lease, runtime_id: 'rid-new', runtime_version: '2.0.0', dsh_version: '0.1.2-rc.1' },
        };
        writeFileSync(join(maintenanceResultsDir(appRoot), name), JSON.stringify(result));
      }
      clock += 1;
    };
    const options = {
      home: t.dir,
      fetchImpl: async () => ({ ok: true, json: async () => ({
        ok: true,
        extension: { runtime: {
          runtime_id: 'rid-live',
          service: 'dsh-crew-hub',
          execution_plane: 'hub-3210',
          profile: 'dsh-crew',
          listen_port: 3210,
          protocol_version: 1,
        } },
      }) }),
      pollMs: 0,
      timeoutMs: 100,
      sleep,
      now: () => clock,
    };
    const stopClient = createCrewSupervisor(options);
    const stopped = await stopClient.stopOwnedBackend({ lease: 'lease-fixed', runtimeId: 'rid-live' });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.lease, 'lease-fixed');
    assert.equal(stopped.runtime_id, 'rid-live');

    const resumedClient = createCrewSupervisor(options);
    const started = await resumedClient.startOwnedBackend({
      lease: 'lease-fixed',
      runtimeId: 'rid-live',
      expectedCrewVersion: '2.0.0',
      expectedDshVersion: '0.1.2-rc.1',
    });
    assert.equal(started.ok, true);
    assert.equal(started.lease, 'lease-fixed');
    assert.equal(started.runtime_id, 'rid-live');
    assert.equal(requests[1].lease, requests[0].lease);
    assert.equal(requests[1].runtime_id, requests[0].runtime_id);
    assert.deepEqual(requests[1].extra, { expected_crew_version: '2.0.0', expected_dsh_version: '0.1.2-rc.1' });
  } finally { t.cleanup(); }
});

test('maintenance stop reuses an exact durable STOPPED session after a caller crash', async () => {
  const t = tempHome();
  try {
    const appRoot = APProot(t.dir);
    mkdirSync(join(appRoot, 'supervisor'), { recursive: true });
    writeFileSync(maintenanceSessionFile(appRoot), JSON.stringify({
      schema_version: 1,
      state: 'STOPPED',
      lease: 'lease-crash',
      runtime_id: 'runtime-old',
      request_id: 'already-stopped',
      stopped_at: 1_000,
    }));
    let fetched = false;
    const client = createCrewSupervisor({
      home: t.dir,
      fetchImpl: async () => { fetched = true; throw new Error('3210 is stopped'); },
      pollMs: 0,
      timeoutMs: 10,
    });
    assert.deepEqual(await client.stopOwnedBackend({ lease: 'lease-crash', runtimeId: 'runtime-old' }), {
      ok: true,
      state: 'STOPPED',
      lease: 'lease-crash',
      runtime_id: 'runtime-old',
      resumed: true,
      request_id: 'already-stopped',
    });
    assert.equal(fetched, false, 'a matching durable stop must not require the stopped runtime to answer');
  } finally { t.cleanup(); }
});

test('maintenance stop refuses a 3210 responder without the canonical Crew runtime identity', async () => {
  const t = tempHome();
  try {
    const client = createCrewSupervisor({
      home: t.dir,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          extension: { runtime: {
            runtime_id: 'runtime-impostor',
            service: 'other-service',
            execution_plane: 'hub-3210',
            profile: 'dsh-crew',
            listen_port: 3210,
            protocol_version: 1,
          } },
        }),
      }),
      pollMs: 0,
      timeoutMs: 10,
    });
    const result = await client.stopOwnedBackend({ lease: 'lease-1', runtimeId: 'runtime-impostor' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MAINTENANCE_IDENTITY_UNAVAILABLE');
    assert.equal(existsSync(maintenanceRequestsDir(APProot(t.dir))), false);
  } finally { t.cleanup(); }
});

test('maintenance identity discovery stays alive until a stalled response times out', async () => {
  const t = tempHome();
  try {
    const started = Date.now();
    let sawSignal = false;
    const client = createCrewSupervisor({
      home: t.dir,
      identityTimeoutMs: 20,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        sawSignal = init.signal instanceof AbortSignal;
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }),
    });
    const result = await client.stopOwnedBackend({ lease: 'lease-timeout', runtimeId: 'runtime-old' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'MAINTENANCE_IDENTITY_UNAVAILABLE');
    assert.equal(sawSignal, true);
    assert.equal(Date.now() - started < 1_000, true, 'identity discovery must not inherit an unbounded fetch timeout');
  } finally { t.cleanup(); }
});

test('maintenance client rejects forged result identity before accepting a terminal receipt', async (t) => {
  const variants = [
    ['schema', (request) => ({ schema_version: 2, request_id: request.request_id, operation: request.operation, lease: request.lease, runtime_id: request.runtime_id })],
    ['request-id', (request) => ({ schema_version: 1, request_id: 'wrong-request', operation: request.operation, lease: request.lease, runtime_id: request.runtime_id })],
    ['lease', (request) => ({ schema_version: 1, request_id: request.request_id, operation: request.operation, lease: 'wrong-lease', runtime_id: request.runtime_id })],
    ['operation', (request) => ({ schema_version: 1, request_id: request.request_id, operation: 'maintenance-start', lease: request.lease, runtime_id: request.runtime_id })],
  ];
  for (const [label, identity] of variants) {
    await t.test(label, async () => {
      const fixture = tempHome();
      try {
        const appRoot = APProot(fixture.dir);
        let clock = 1_000;
        const sleep = async () => {
          const requestDir = maintenanceRequestsDir(appRoot);
          const name = existsSync(requestDir) ? (await import('node:fs')).readdirSync(requestDir)[0] : null;
          if (!name) return;
          const request = JSON.parse(readFileSync(join(requestDir, name), 'utf8'));
          mkdirSync(maintenanceResultsDir(appRoot), { recursive: true });
          writeFileSync(join(maintenanceResultsDir(appRoot), name), JSON.stringify({
            ...identity(request),
            state: 'STOPPED',
          }));
          clock += 1;
        };
        const client = createCrewSupervisor({
          home: fixture.dir,
          fetchImpl: async () => ({ ok: true, json: async () => ({
            ok: true,
            extension: { runtime: {
              runtime_id: 'runtime-old', service: 'dsh-crew-hub', execution_plane: 'hub-3210',
              profile: 'dsh-crew', listen_port: 3210, protocol_version: 1,
            } },
          }) }),
          pollMs: 0,
          timeoutMs: 100,
          sleep,
          now: () => clock,
        });
        const result = await client.stopOwnedBackend({ lease: 'lease-good', runtimeId: 'runtime-old' });
        assert.equal(result.ok, false);
        assert.equal(result.code, 'MAINTENANCE_RESULT_IDENTITY_MISMATCH');
      } finally { fixture.cleanup(); }
    });
  }
});
