import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWindowsSupervisorHandoffHooks,
  validateSupervisorRuntime,
} from '../src/install/windows-supervisor-adapter.mjs';

const TARGET = {
  helper_path: 'C:\\Users\\tester\\.config\\dsh-crew\\launchers\\start-dsh-crew.ps1',
  helper_hash: 'b'.repeat(64),
};
const WATCHER = {
  pid: 123,
  process_started_at_utc_ticks: '638609500000000000',
  helper_hash: TARGET.helper_hash,
};

test('adapter classifies legacy heartbeat through exact process discovery', async () => {
  const calls = [];
  const hooks = createWindowsSupervisorHandoffHooks({
    target: TARGET,
    readHeartbeatRecord: () => ({ state: 'legacy-v1', record: { pid: WATCHER.pid } }),
    runControl: async (request) => {
      calls.push(request);
      return { ok: true, operation: 'inspect', watcher: WATCHER };
    },
    fetchRuntime: async () => ({
      runtime_id: 'runtime-old', execution_plane: 'hub-3210', profile: 'dsh-crew',
      listen_port: 3210, runtime_version: '1.1.1', dsh_version: '0.1.2-rc.1',
    }),
    maintenanceClient: {},
  });

  const observed = await hooks.classifyHeartbeat({ target: TARGET });
  assert.equal(observed.ok, true);
  assert.equal(observed.classification, 'legacy');
  assert.deepEqual(observed.watcher, WATCHER);
  assert.equal(observed.runtime_id, 'runtime-old');
  assert.deepEqual(calls, [{ operation: 'inspect', helper_path: TARGET.helper_path, expected: { pid: WATCHER.pid } }]);
});

test('adapter preserves the durable maintenance lease and expected versions', async () => {
  const calls = [];
  const maintenanceClient = {
    stopOwnedBackend: async (options) => { calls.push(['stop', options]); return { ok: true, state: 'STOPPED', lease: options.lease, runtime_id: options.runtimeId }; },
    startOwnedBackend: async (options) => { calls.push(['start', options]); return { ok: true, state: 'VERIFIED', lease: options.lease, runtime_id: options.runtimeId }; },
  };
  const hooks = createWindowsSupervisorHandoffHooks({
    target: TARGET,
    readHeartbeatRecord: () => null,
    runControl: async () => ({ ok: true, watcher: WATCHER }),
    fetchRuntime: async () => null,
    maintenanceClient,
    expectedCrewVersion: '2.0.0',
    expectedDshVersion: '0.1.2-rc.1',
  });

  await hooks.maintenanceStop({ lease: 'lease-1', runtime_id: 'runtime-old' });
  await hooks.maintenanceStart({ lease: 'lease-1', runtime_id: 'runtime-old' });
  assert.deepEqual(calls, [
    ['stop', { lease: 'lease-1', runtimeId: 'runtime-old' }],
    ['start', {
      lease: 'lease-1', runtimeId: 'runtime-old',
      expectedCrewVersion: '2.0.0', expectedDshVersion: '0.1.2-rc.1',
    }],
  ]);
});

test('runtime verification accepts only the isolated 3210 identity and expected versions', () => {
  const runtime = {
    runtime_id: 'runtime-new', execution_plane: 'hub-3210', profile: 'dsh-crew',
    listen_port: 3210, protocol_version: 1, runtime_version: '2.0.0', dsh_version: '0.1.2-rc.1',
  };
  assert.equal(validateSupervisorRuntime(runtime, { expectedCrewVersion: '2.0.0', expectedDshVersion: '0.1.2-rc.1' }), true);
  assert.equal(validateSupervisorRuntime({ ...runtime, listen_port: 3080 }, { expectedCrewVersion: '2.0.0', expectedDshVersion: '0.1.2-rc.1' }), false);
  assert.equal(validateSupervisorRuntime({ ...runtime, runtime_version: 'old' }, { expectedCrewVersion: '2.0.0', expectedDshVersion: '0.1.2-rc.1' }), false);
  assert.equal(validateSupervisorRuntime({ ...runtime, dsh_version: 'wrong' }, { expectedCrewVersion: '2.0.0', expectedDshVersion: '0.1.2-rc.1' }), false);
});
