import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import {
  createWindowsSupervisorHandoffHooks,
  convergeWindowsSupervisor,
  hashSupervisorHelper,
  reserveWindowsSupervisorConvergence,
  runWindowsSupervisorControl,
  windowsSupervisorConvergencePending,
  validateSupervisorRuntime,
} from '../src/install/windows-supervisor-adapter.mjs';
import { installWindowsStartup } from '../src/install/windows-startup.mjs';

const TARGET = {
  helper_path: 'C:\\Users\\tester\\.config\\dsh-crew\\launchers\\start-dsh-crew.ps1',
  helper_hash: 'b'.repeat(64),
  control_path: 'C:\\Users\\tester\\.config\\dsh-crew\\launchers\\supervisor-control.ps1',
  control_hash: 'c'.repeat(64),
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

test('adapter permits helper-file drift only for a fully attested stale watcher', async () => {
  const calls = [];
  const stale = { ...WATCHER, helper_hash: 'a'.repeat(64) };
  const hooks = createWindowsSupervisorHandoffHooks({
    target: TARGET,
    readHeartbeatRecord: () => ({ state: 'ready', record: stale }),
    runControl: async (request) => {
      calls.push(request);
      return { ok: true, operation: request.operation, watcher: stale };
    },
    fetchRuntime: async () => ({ runtime_id: 'runtime-old' }),
    maintenanceClient: {},
  });

  const observed = await hooks.classifyHeartbeat({ target: TARGET });
  assert.equal(observed.classification, 'stale');
  await hooks.verifyExactWatcher({ expected: stale, role: 'old' });
  await hooks.stopExactWatcher({ expected: stale });
  assert.deepEqual(calls.map((request) => request.allow_helper_drift), [true, true, true]);
  assert.equal(calls.every((request) => request.expected.process_started_at_utc_ticks === stale.process_started_at_utc_ticks), true);
});

test('adapter treats a proven dead heartbeat process as absent and leaves port proof to the state machine', async () => {
  const hooks = createWindowsSupervisorHandoffHooks({
    target: TARGET,
    readHeartbeatRecord: () => ({ state: 'ready', record: WATCHER }),
    runControl: async () => ({ ok: false, code: 'PROCESS_NOT_FOUND' }),
    fetchRuntime: async () => null,
    maintenanceClient: {},
  });
  assert.deepEqual(await hooks.classifyHeartbeat({ target: TARGET }), {
    ok: true,
    classification: 'absent',
    watcher: null,
    runtime_id: null,
  });
});

test('runtime verification accepts only the isolated 3210 identity and expected versions', () => {
  const runtime = {
    runtime_id: 'runtime-new', service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew',
    listen_port: 3210, protocol_version: 1, runtime_version: '2.0.0', dsh_version: '0.1.2-rc.1',
  };
  assert.equal(validateSupervisorRuntime(runtime, { expectedCrewVersion: '2.0.0', expectedDshVersion: '0.1.2-rc.1' }), true);
  assert.equal(validateSupervisorRuntime({ ...runtime, listen_port: 3080 }, { expectedCrewVersion: '2.0.0', expectedDshVersion: '0.1.2-rc.1' }), false);
  assert.equal(validateSupervisorRuntime({ ...runtime, service: 'other' }, { expectedCrewVersion: '2.0.0', expectedDshVersion: '0.1.2-rc.1' }), false);
  assert.equal(validateSupervisorRuntime({ ...runtime, runtime_version: 'old' }, { expectedCrewVersion: '2.0.0', expectedDshVersion: '0.1.2-rc.1' }), false);
  assert.equal(validateSupervisorRuntime({ ...runtime, dsh_version: 'wrong' }, { expectedCrewVersion: '2.0.0', expectedDshVersion: '0.1.2-rc.1' }), false);
});

test('convergence fails closed when release versions or installed helper provenance are incomplete', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-crew-adapter-'));
  const root = join(home, 'release');
  const installedHelper = join(home, '.config', 'dsh-crew', 'launchers', 'start-dsh-crew.ps1');
  try {
    mkdirSync(join(root, 'windows'), { recursive: true });
    mkdirSync(join(home, '.config', 'dsh-crew', 'launchers'), { recursive: true });
    writeFileSync(join(root, 'windows', 'supervisor-control.ps1'), '# control\n');
    writeFileSync(join(root, 'windows', 'start-dsh-crew.ps1'), '# release helper\n');
    writeFileSync(installedHelper, '# different helper\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '2.0.0' }));
    let controlled = false;
    const result = await convergeWindowsSupervisor({
      home,
      root,
      platform: 'win32',
      maintenanceClient: {},
      runControl: async () => { controlled = true; return { ok: false }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUPERVISOR_TARGET_UNAVAILABLE');
    assert.equal(controlled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('production convergence can reserve handoff ownership before the update lock is released', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-crew-adapter-reserve-'));
  const root = join(home, 'release');
  const helper = join(home, '.config', 'dsh-crew', 'launchers', 'start-dsh-crew.ps1');
  try {
    mkdirSync(join(root, 'windows'), { recursive: true });
    mkdirSync(join(home, '.config', 'dsh-crew', 'launchers'), { recursive: true });
    writeFileSync(join(root, 'windows', 'supervisor-control.ps1'), '# control\n');
    writeFileSync(join(root, 'windows', 'start-dsh-crew.ps1'), '# helper\n');
    writeFileSync(join(root, 'windows', 'start-dsh-crew.cmd'), '@echo off\r\n');
    writeFileSync(join(root, 'windows', 'start-dsh-crew.vbs'), 'Option Explicit\n__LAUNCHER__\n--watch\n');
    assert.equal(installWindowsStartup({ home, root, startupDir: join(home, 'Startup'), platform: 'win32' }).ok, true);
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: '@ran-sh/dsh-crew',
      version: '2.0.0',
      peerDependencies: { '@deepseek-ai/dsh': '0.1.2-rc.1' },
    }));
    const hash = hashSupervisorHelper(helper);
    const watcher = { pid: 123, process_started_at_utc_ticks: '638609500000000000', helper_hash: hash };
    const heartbeat = { ...watcher, ownership_ready: true };
    const runtime = {
      runtime_id: 'runtime-new', service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew',
      listen_port: 3210, protocol_version: 1, runtime_version: '2.0.0', dsh_version: '0.1.2-rc.1',
    };
    const reservation = reserveWindowsSupervisorConvergence({ home, root, platform: 'win32' });
    assert.equal(reservation.ok, true);
    assert.equal(windowsSupervisorConvergencePending({ home }), true);
    const result = await convergeWindowsSupervisor({
      home,
      root,
      platform: 'win32',
      reservation,
      maintenanceClient: {},
      readHeartbeatRecord: () => ({ state: 'ready', record: heartbeat }),
      readAuthoritativeHeartbeat: () => heartbeat,
      runControl: async () => ({ ok: true, watcher }),
      fetchRuntime: async () => runtime,
    });
    assert.equal(result.ok, true);
    assert.equal(result.idempotent, true);
    assert.equal(windowsSupervisorConvergencePending({ home }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('current Crew-owned supervisor assets can verify a legacy retained payload without control files', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-crew-adapter-legacy-'));
  const root = join(home, 'legacy-release');
  const supervisorRoot = join(home, 'current-launcher');
  const launchers = join(home, '.config', 'dsh-crew', 'launchers');
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(join(supervisorRoot, 'windows'), { recursive: true });
    mkdirSync(launchers, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: '@ran-sh/dsh-crew', version: '1.1.1', peerDependencies: { '@deepseek-ai/dsh': '0.1.2-rc.1' },
    }));
    const helperText = '# current helper\n';
    const controlText = '# current control\n';
    writeFileSync(join(supervisorRoot, 'windows', 'start-dsh-crew.ps1'), helperText);
    writeFileSync(join(supervisorRoot, 'windows', 'supervisor-control.ps1'), controlText);
    writeFileSync(join(supervisorRoot, 'windows', 'start-dsh-crew.cmd'), '@echo off\r\n');
    writeFileSync(join(supervisorRoot, 'windows', 'start-dsh-crew.vbs'), 'Option Explicit\n__LAUNCHER__\n--watch\n');
    assert.equal(installWindowsStartup({ home, root: supervisorRoot, startupDir: join(home, 'Startup'), platform: 'win32' }).ok, true);
    // A later global npm refresh changes its package root, but must not
    // reinterpret the already-reserved Crew-owned supervisor bundle.
    writeFileSync(join(supervisorRoot, 'windows', 'start-dsh-crew.ps1'), '# newer global helper\n');
    writeFileSync(join(supervisorRoot, 'windows', 'supervisor-control.ps1'), '# newer global control\n');
    const hash = hashSupervisorHelper(join(launchers, 'start-dsh-crew.ps1'));
    const watcher = { pid: 123, process_started_at_utc_ticks: '638609500000000000', helper_hash: hash };
    const heartbeat = { ...watcher, ownership_ready: true };
    const runtime = {
      runtime_id: 'legacy-runtime', service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew',
      listen_port: 3210, protocol_version: 1, runtime_version: '1.1.1', dsh_version: '0.1.2-rc.1',
    };
    const reservation = reserveWindowsSupervisorConvergence({ home, root, supervisorRoot, platform: 'win32' });
    assert.equal(reservation.ok, true, JSON.stringify(reservation));
    const result = await convergeWindowsSupervisor({
      home, root, supervisorRoot, platform: 'win32', reservation, maintenanceClient: {},
      readHeartbeatRecord: () => ({ state: 'ready', record: heartbeat }),
      readAuthoritativeHeartbeat: () => heartbeat,
      runControl: async () => ({ ok: true, watcher }),
      fetchRuntime: async () => runtime,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('supervisor control launches only the absolute canonical Windows PowerShell executable', async () => {
  let command = null;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.kill = () => {};
  child.stdin = {
    end: () => queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({ ok: true, operation: 'inspect', watcher: WATCHER }));
      child.emit('close', 0);
    }),
  };
  const result = await runWindowsSupervisorControl({ operation: 'inspect' }, {
    controlScript: 'C:\\Crew\\supervisor-control.ps1',
    environment: { SystemRoot: 'C:\\Windows' },
    exists: () => true,
    spawnImpl: (value) => { command = value; return child; },
  });
  assert.equal(result.ok, true);
  assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});
