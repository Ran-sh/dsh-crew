import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireWindowsSupervisorHandoffLock,
  clearWindowsSupervisorHandoffJournal,
  readWindowsSupervisorHandoffJournal,
  runWindowsSupervisorHandoff,
  windowsSupervisorHandoffJournalPath,
  windowsSupervisorHandoffLockPath,
  writeWindowsSupervisorHandoffJournal,
} from '../src/install/windows-supervisor-lifecycle.mjs';

const OLD_HASH = 'a'.repeat(64);
const TARGET_HASH = 'b'.repeat(64);
const OLD = Object.freeze({
  pid: 101,
  process_started_at_utc_ticks: '638609500000000000',
  helper_hash: OLD_HASH,
});
const NEW = Object.freeze({
  pid: 202,
  process_started_at_utc_ticks: '638609500000000001',
  helper_hash: TARGET_HASH,
});
const TARGET = Object.freeze({
  helper_path: 'C:\\Program Files\\DSH Crew\\start-dsh-crew.ps1',
  helper_hash: TARGET_HASH,
  control_path: 'C:\\Program Files\\DSH Crew\\supervisor-control.ps1',
  control_hash: 'c'.repeat(64),
});

function temporaryAppRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-handoff-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function journal(overrides = {}) {
  return {
    schema_version: 1,
    handoff_id: 'handoff-1',
    phase: 'planned',
    lease: 'lease-1',
    runtime_id: 'runtime-old',
    old: { ...OLD },
    target: { ...TARGET },
    updated_at: 1_725_000_000_000,
    ...overrides,
  };
}

function successfulHooks({ appRoot, initial = 'legacy', eventLog = [] } = {}) {
  const state = { heartbeat: initial, stopCalls: 0, startCalls: 0, launchCalls: 0 };
  const phase = () => readWindowsSupervisorHandoffJournal({ appRoot }).journal?.phase ?? 'absent';
  const hooks = {
    acquireLock: async () => ({ ok: true, token: 'lock-1' }),
    releaseLock: async () => { eventLog.push('release-lock'); },
    classifyHeartbeat: async () => {
      eventLog.push(`classify:${state.heartbeat}`);
      if (state.heartbeat === 'legacy') {
        return { ok: true, classification: 'legacy', watcher: { ...OLD }, runtime_id: 'runtime-old' };
      }
      if (state.heartbeat === 'target-starting') {
        return { ok: true, classification: 'target-starting', watcher: { ...NEW }, runtime_id: null };
      }
      if (state.heartbeat === 'target-ready') {
        return { ok: true, classification: 'target-ready', watcher: { ...NEW }, runtime_id: 'runtime-new' };
      }
      return { ok: true, classification: 'absent', watcher: null, runtime_id: null };
    },
    verifyExactWatcher: async ({ expected }) => {
      eventLog.push(`verify-exact:${expected.pid}:${phase()}`);
      return { ok: true, watcher: { ...expected } };
    },
    maintenanceStop: async ({ lease, runtime_id }) => {
      state.stopCalls += 1;
      eventLog.push(`maintenance-stop:${phase()}`);
      return { ok: true, state: 'STOPPED', lease, runtime_id };
    },
    maintenanceStatus: async () => ({ ok: true, state: 'absent' }),
    verifyPortFree: async () => {
      eventLog.push(`port-free:${phase()}`);
      return { ok: true, free: true };
    },
    stopExactWatcher: async ({ expected }) => {
      eventLog.push(`stop-watcher:${phase()}`);
      state.heartbeat = 'absent';
      return { ok: true, watcher: { ...expected } };
    },
    launchTargetWatcher: async () => {
      state.launchCalls += 1;
      eventLog.push(`launch-target:${phase()}`);
      state.heartbeat = 'target-starting';
      return { ok: true, watcher: { ...NEW } };
    },
    maintenanceStart: async ({ lease, runtime_id }) => {
      state.startCalls += 1;
      eventLog.push(`maintenance-start:${phase()}`);
      state.heartbeat = 'target-ready';
      return { ok: true, state: 'VERIFIED', lease, runtime_id };
    },
    verifyReady: async () => {
      eventLog.push(`verify-ready:${phase()}`);
      return {
        ok: true,
        watcher: { ...NEW },
        runtime: { runtime_id: 'runtime-new', execution_plane: 'hub-3210', listen_port: 3210 },
      };
    },
  };
  return { hooks, state };
}

test('changed same-version content forces a new runtime even with a ready watcher', async () => {
  const temp = temporaryAppRoot();
  try {
    const { hooks, state } = successfulHooks({ appRoot: temp.dir, initial: 'target-ready' });
    let prematureReadinessChecks = 0;
    const verify = hooks.verifyReady;
    hooks.verifyReady = async (...args) => {
      if (!readWindowsSupervisorHandoffJournal({ appRoot: temp.dir }).journal) prematureReadinessChecks++;
      return verify(...args);
    };
    const classify = hooks.classifyHeartbeat;
    hooks.classifyHeartbeat = async (...args) => {
      const observed = await classify(...args);
      return state.stopCalls === 0 ? { ...observed, runtime_id: 'runtime-old' } : observed;
    };
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks, forceRestart: true });
    assert.equal(result.ok, true);
    assert.equal(state.stopCalls, 1);
    assert.equal(state.startCalls, 1);
    assert.equal(prematureReadinessChecks, 0, 'do not wait for old code to become the new code');
    assert.equal(result.runtime_id, 'runtime-new');
  } finally { temp.cleanup(); }
});

test('legacy watcher handoff persists every boundary before the next side effect', async () => {
  const temp = temporaryAppRoot();
  try {
    const events = [];
    const { hooks } = successfulHooks({ appRoot: temp.dir, eventLog: events });
    const result = await runWindowsSupervisorHandoff({
      appRoot: temp.dir,
      target: TARGET,
      hooks,
      now: () => 1_725_000_000_000,
      createHandoffId: () => 'handoff-1',
      createLease: () => 'lease-1',
    });

    assert.equal(result.ok, true);
    assert.equal(result.state, 'VERIFIED');
    assert.equal(existsSync(windowsSupervisorHandoffJournalPath(temp.dir)), false);
    assert.deepEqual(events, [
      'classify:legacy',
      'verify-exact:101:absent',
      'maintenance-stop:planned',
      'port-free:planned',
      'verify-exact:101:backend-stopped',
      'stop-watcher:backend-stopped',
      'classify:absent',
      'port-free:old-watcher-stopped',
      'launch-target:old-watcher-stopped',
      'classify:target-starting',
      'verify-exact:202:new-watcher-started',
      'maintenance-start:new-watcher-started',
      'verify-ready:new-watcher-started',
      'release-lock',
    ]);
  } finally {
    temp.cleanup();
  }
});

test('already-ready watcher with the target helper hash is an idempotent no-op', async () => {
  const temp = temporaryAppRoot();
  try {
    const events = [];
    const { hooks, state } = successfulHooks({ appRoot: temp.dir, initial: 'target-ready', eventLog: events });
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });

    assert.deepEqual(result, {
      ok: true,
      state: 'VERIFIED',
      idempotent: true,
      runtime_id: 'runtime-new',
      watcher: NEW,
    });
    assert.equal(state.stopCalls, 0);
    assert.equal(state.startCalls, 0);
    assert.equal(state.launchCalls, 0);
    assert.deepEqual(events, ['classify:target-ready', 'verify-ready:absent', 'release-lock']);
  } finally {
    temp.cleanup();
  }
});

test('an initially target-ready watcher still requires strict runtime verification', async () => {
  const temp = temporaryAppRoot();
  try {
    const { hooks } = successfulHooks({ appRoot: temp.dir, initial: 'target-ready' });
    hooks.verifyReady = async () => ({ ok: false, code: 'RUNTIME_VERSION_MISMATCH' });
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUPERVISOR_HANDOFF_READY_VERIFY_FAILED');
  } finally {
    temp.cleanup();
  }
});

test('a target-ready watcher with a stale runtime enters the durable restart transaction', async () => {
  const temp = temporaryAppRoot();
  try {
    const { hooks, state } = successfulHooks({ appRoot: temp.dir, initial: 'target-ready' });
    const classifyNormally = hooks.classifyHeartbeat;
    let classifications = 0;
    hooks.classifyHeartbeat = async (payload) => {
      classifications += 1;
      return classifications === 1
        ? { ok: true, classification: 'target-ready', watcher: { ...NEW }, runtime_id: 'runtime-old' }
        : classifyNormally(payload);
    };
    const verifyNormally = hooks.verifyReady;
    let verifies = 0;
    hooks.verifyReady = async (payload) => {
      verifies += 1;
      return verifies === 1
        ? { ok: false, code: 'RUNTIME_VERSION_MISMATCH' }
        : verifyNormally(payload);
    };
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(state.stopCalls, 1);
    assert.equal(state.startCalls, 1);
    assert.equal(state.launchCalls, 1);
    assert.equal(verifies, 2);
  } finally {
    temp.cleanup();
  }
});

test('busy lock returns a stable contract without observing or mutating runtime state', async () => {
  const temp = temporaryAppRoot();
  try {
    let observed = false;
    const result = await runWindowsSupervisorHandoff({
      appRoot: temp.dir,
      target: TARGET,
      hooks: {
        acquireLock: async () => ({ ok: false, code: 'LOCK_HELD' }),
        classifyHeartbeat: async () => { observed = true; },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUPERVISOR_HANDOFF_BUSY');
    assert.equal(observed, false);
  } finally {
    temp.cleanup();
  }
});

test('journal helpers atomically round-trip valid state and refuse mismatched clear', () => {
  const temp = temporaryAppRoot();
  try {
    const written = writeWindowsSupervisorHandoffJournal({ appRoot: temp.dir, journal: journal() });
    assert.equal(written.ok, true);
    assert.deepEqual(readWindowsSupervisorHandoffJournal({ appRoot: temp.dir }), {
      ok: true,
      state: 'present',
      journal: journal(),
    });
    assert.equal(clearWindowsSupervisorHandoffJournal({ appRoot: temp.dir, handoffId: 'different' }).ok, false);
    assert.equal(existsSync(windowsSupervisorHandoffJournalPath(temp.dir)), true);
    assert.equal(clearWindowsSupervisorHandoffJournal({ appRoot: temp.dir, handoffId: 'handoff-1' }).ok, true);
    assert.equal(readWindowsSupervisorHandoffJournal({ appRoot: temp.dir }).state, 'absent');
  } finally {
    temp.cleanup();
  }
});

test('malformed journal fails closed before heartbeat classification', async () => {
  const temp = temporaryAppRoot();
  try {
    const file = windowsSupervisorHandoffJournalPath(temp.dir);
    mkdirSync(join(temp.dir, 'supervisor'), { recursive: true });
    writeFileSync(file, '{not-json', 'utf8');
    let observed = false;
    const { hooks } = successfulHooks({ appRoot: temp.dir });
    hooks.classifyHeartbeat = async () => { observed = true; return { ok: true, classification: 'absent' }; };
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUPERVISOR_HANDOFF_JOURNAL_MALFORMED');
    assert.equal(observed, false);
    assert.equal(existsSync(file), true, 'malformed evidence remains for diagnosis');
  } finally {
    temp.cleanup();
  }
});

test('journal target mismatch fails closed without invoking process hooks', async () => {
  const temp = temporaryAppRoot();
  try {
    writeWindowsSupervisorHandoffJournal({
      appRoot: temp.dir,
      journal: journal({ target: { ...TARGET, helper_hash: 'c'.repeat(64) } }),
    });
    let observed = false;
    const { hooks } = successfulHooks({ appRoot: temp.dir });
    hooks.classifyHeartbeat = async () => { observed = true; };
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUPERVISOR_HANDOFF_JOURNAL_IDENTITY_MISMATCH');
    assert.equal(observed, false);
    assert.equal(readWindowsSupervisorHandoffJournal({ appRoot: temp.dir }).journal.phase, 'planned');
  } finally {
    temp.cleanup();
  }
});

test('journal control hash drift fails closed before invoking process hooks', async () => {
  const temp = temporaryAppRoot();
  try {
    writeWindowsSupervisorHandoffJournal({
      appRoot: temp.dir,
      journal: journal({ target: { ...TARGET, control_hash: 'd'.repeat(64) } }),
    });
    let observed = false;
    const { hooks } = successfulHooks({ appRoot: temp.dir });
    hooks.classifyHeartbeat = async () => { observed = true; };
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUPERVISOR_HANDOFF_JOURNAL_IDENTITY_MISMATCH');
    assert.equal(observed, false);
  } finally {
    temp.cleanup();
  }
});

test('maintenance STOPPED receipt must match the durable lease and runtime identity', async () => {
  const temp = temporaryAppRoot();
  try {
    const { hooks } = successfulHooks({ appRoot: temp.dir });
    hooks.maintenanceStop = async ({ lease }) => ({
      ok: true,
      state: 'STOPPED',
      lease,
      runtime_id: 'wrong-runtime',
    });
    const result = await runWindowsSupervisorHandoff({
      appRoot: temp.dir,
      target: TARGET,
      hooks,
      createHandoffId: () => 'handoff-1',
      createLease: () => 'lease-1',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUPERVISOR_HANDOFF_STOP_RECEIPT_MISMATCH');
    assert.equal(readWindowsSupervisorHandoffJournal({ appRoot: temp.dir }).journal.phase, 'planned');
  } finally {
    temp.cleanup();
  }
});

test('planned handoff rebinds when the same exact watcher recovered a new runtime before STOPPED was durable', async () => {
  const temp = temporaryAppRoot();
  try {
    let runtimeId = 'runtime-old';
    let stops = 0;
    let leaseSequence = 0;
    const { hooks } = successfulHooks({ appRoot: temp.dir });
    const classifyNormally = hooks.classifyHeartbeat;
    hooks.classifyHeartbeat = async (payload) => stops < 2
      ? ({ ok: true, classification: 'legacy', watcher: { ...OLD }, runtime_id: runtimeId })
      : classifyNormally(payload);
    hooks.maintenanceStop = async ({ lease, runtime_id }) => {
      stops += 1;
      if (stops === 1) {
        runtimeId = 'runtime-recovered';
        return { ok: false, code: 'MAINTENANCE_IDENTITY_CHANGED' };
      }
      return { ok: true, state: 'STOPPED', lease, runtime_id };
    };
    const result = await runWindowsSupervisorHandoff({
      appRoot: temp.dir,
      target: TARGET,
      hooks,
      createLease: () => `lease-${++leaseSequence}`,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(stops, 2);
    assert.equal(leaseSequence, 2, 'the recovered runtime must get a fresh durable lease');
  } finally {
    temp.cleanup();
  }
});

test('exact-watcher mismatch fails closed and never stops an unproven PID', async () => {
  const temp = temporaryAppRoot();
  try {
    let stopped = false;
    const { hooks } = successfulHooks({ appRoot: temp.dir });
    hooks.verifyExactWatcher = async () => ({ ok: false, code: 'PID_REUSED' });
    hooks.stopExactWatcher = async () => { stopped = true; };
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUPERVISOR_HANDOFF_OLD_WATCHER_MISMATCH');
    assert.equal(stopped, false);
    assert.equal(readWindowsSupervisorHandoffJournal({ appRoot: temp.dir }).state, 'absent');
  } finally {
    temp.cleanup();
  }
});

test('exact watcher verification requires the hook to echo the full proven identity', async () => {
  const temp = temporaryAppRoot();
  try {
    let stopped = false;
    const { hooks } = successfulHooks({ appRoot: temp.dir });
    hooks.verifyExactWatcher = async () => ({ ok: true });
    hooks.stopExactWatcher = async () => { stopped = true; };
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUPERVISOR_HANDOFF_OLD_WATCHER_MISMATCH');
    assert.equal(stopped, false);
  } finally {
    temp.cleanup();
  }
});

test('watcher stop requires an exact identity receipt before advancing the durable phase', async () => {
  const temp = temporaryAppRoot();
  try {
    const { hooks } = successfulHooks({ appRoot: temp.dir });
    hooks.stopExactWatcher = async () => ({ ok: true, stopped: true });
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUPERVISOR_HANDOFF_WATCHER_STOP_FAILED');
    assert.equal(readWindowsSupervisorHandoffJournal({ appRoot: temp.dir }).journal.phase, 'backend-stopped');
  } finally {
    temp.cleanup();
  }
});

test('absent watcher launches fresh only when port freedom is proven', async () => {
  const blocked = temporaryAppRoot();
  const fresh = temporaryAppRoot();
  try {
    const blockedFixture = successfulHooks({ appRoot: blocked.dir, initial: 'absent' });
    blockedFixture.hooks.verifyPortFree = async () => ({ ok: true, free: false });
    const blockedResult = await runWindowsSupervisorHandoff({
      appRoot: blocked.dir,
      target: TARGET,
      hooks: blockedFixture.hooks,
    });
    assert.equal(blockedResult.code, 'SUPERVISOR_HANDOFF_PORT_NOT_FREE');
    assert.equal(blockedFixture.state.launchCalls, 0);
    assert.equal(readWindowsSupervisorHandoffJournal({ appRoot: blocked.dir }).state, 'absent');

    const events = [];
    const freshFixture = successfulHooks({ appRoot: fresh.dir, initial: 'absent', eventLog: events });
    const result = await runWindowsSupervisorHandoff({
      appRoot: fresh.dir,
      target: TARGET,
      hooks: freshFixture.hooks,
      createHandoffId: () => 'fresh-1',
      createLease: () => 'fresh-lease',
    });
    assert.equal(result.ok, true);
    assert.equal(result.fresh, true);
    assert.equal(freshFixture.state.stopCalls, 0);
    assert.equal(freshFixture.state.startCalls, 0);
    assert.equal(freshFixture.state.launchCalls, 1);
    assert.equal(existsSync(windowsSupervisorHandoffJournalPath(fresh.dir)), false);
    assert.deepEqual(events, [
      'classify:absent',
      'port-free:absent',
      'classify:absent',
      'port-free:old-watcher-stopped',
      'launch-target:old-watcher-stopped',
      'classify:target-starting',
      'verify-exact:202:new-watcher-started',
      'verify-ready:new-watcher-started',
      'release-lock',
    ]);
  } finally {
    blocked.cleanup();
    fresh.cleanup();
  }
});

test('each durable phase resumes without replaying completed destructive steps', async (t) => {
  const cases = [
    { phase: 'planned', stop: 1, watcherStop: 1, launch: 1, start: 1 },
    { phase: 'backend-stopped', stop: 0, watcherStop: 1, launch: 1, start: 1 },
    { phase: 'old-watcher-stopped', stop: 0, watcherStop: 0, launch: 1, start: 1 },
    { phase: 'new-watcher-started', stop: 0, watcherStop: 0, launch: 0, start: 1 },
    { phase: 'verified', stop: 0, watcherStop: 0, launch: 0, start: 0 },
  ];

  for (const scenario of cases) {
    await t.test(scenario.phase, async () => {
      const temp = temporaryAppRoot();
      try {
        writeWindowsSupervisorHandoffJournal({
          appRoot: temp.dir,
          journal: journal({ phase: scenario.phase }),
        });
        const initial = scenario.phase === 'planned' || scenario.phase === 'backend-stopped'
          ? 'legacy'
          : scenario.phase === 'old-watcher-stopped'
            ? 'absent'
            : 'target-starting';
        const counts = { watcherStop: 0 };
        const { hooks, state } = successfulHooks({ appRoot: temp.dir, initial });
        const stopExact = hooks.stopExactWatcher;
        hooks.stopExactWatcher = async (args) => {
          counts.watcherStop += 1;
          return stopExact(args);
        };
        const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
        assert.equal(result.ok, true);
        assert.equal(state.stopCalls, scenario.stop);
        assert.equal(counts.watcherStop, scenario.watcherStop);
        assert.equal(state.launchCalls, scenario.launch);
        assert.equal(state.startCalls, scenario.start);
        assert.equal(existsSync(windowsSupervisorHandoffJournalPath(temp.dir)), false);
      } finally {
        temp.cleanup();
      }
    });
  }
});

test('resume recognizes a target watcher launched just before a crash and does not launch twice', async () => {
  const temp = temporaryAppRoot();
  try {
    writeWindowsSupervisorHandoffJournal({
      appRoot: temp.dir,
      journal: journal({ phase: 'old-watcher-stopped' }),
    });
    const { hooks, state } = successfulHooks({ appRoot: temp.dir, initial: 'target-starting' });
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, true);
    assert.equal(state.launchCalls, 0);
    assert.equal(state.startCalls, 1);
  } finally {
    temp.cleanup();
  }
});

test('resume advances when the exact old watcher was killed before the phase checkpoint', async () => {
  const temp = temporaryAppRoot();
  try {
    writeWindowsSupervisorHandoffJournal({
      appRoot: temp.dir,
      journal: journal({ phase: 'backend-stopped' }),
    });
    const { hooks, state } = successfulHooks({ appRoot: temp.dir, initial: 'legacy' });
    let stopCalls = 0;
    hooks.verifyExactWatcher = async ({ expected, role }) => {
      if (role === 'old') {
        state.heartbeat = 'absent';
        return { ok: false, code: 'PROCESS_NOT_FOUND' };
      }
      return { ok: true, watcher: { ...expected } };
    };
    hooks.stopExactWatcher = async () => { stopCalls += 1; };
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(stopCalls, 0, 'an already-dead exact watcher must not be killed again');
    assert.equal(state.launchCalls, 1);
  } finally {
    temp.cleanup();
  }
});

test('default handoff lock reclaims a dead owner and resumes the durable journal', async () => {
  const temp = temporaryAppRoot();
  try {
    writeWindowsSupervisorHandoffJournal({
      appRoot: temp.dir,
      journal: journal({ phase: 'old-watcher-stopped', old: null, runtime_id: null }),
    });
    const lock = `${windowsSupervisorHandoffJournalPath(temp.dir)}.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({
      schema_version: 1,
      token: 'dead-owner',
      pid: 2147483647,
      acquired_at: 1,
    }));
    const { hooks } = successfulHooks({ appRoot: temp.dir, initial: 'absent' });
    delete hooks.acquireLock;
    delete hooks.releaseLock;
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, true);
    assert.equal(existsSync(lock), false);
  } finally {
    temp.cleanup();
  }
});

test('a lock reserved while another lifecycle lock is held transfers atomically into handoff execution', async () => {
  const temp = temporaryAppRoot();
  try {
    const reserved = acquireWindowsSupervisorHandoffLock({ appRoot: temp.dir });
    assert.equal(reserved.ok, true);
    assert.equal(existsSync(windowsSupervisorHandoffLockPath(temp.dir)), true);
    const { hooks } = successfulHooks({ appRoot: temp.dir, initial: 'absent' });
    delete hooks.acquireLock;
    delete hooks.releaseLock;
    const result = await runWindowsSupervisorHandoff({
      appRoot: temp.dir,
      target: TARGET,
      hooks,
      preAcquiredLock: reserved,
    });
    assert.equal(result.ok, true);
    assert.equal(existsSync(windowsSupervisorHandoffLockPath(temp.dir)), false);
  } finally {
    temp.cleanup();
  }
});

test('planned recovery accepts a replacement target watcher only after strict ready verification', async () => {
  const temp = temporaryAppRoot();
  try {
    writeWindowsSupervisorHandoffJournal({ appRoot: temp.dir, journal: journal({ phase: 'planned' }) });
    const { hooks, state } = successfulHooks({ appRoot: temp.dir, initial: 'target-ready' });
    hooks.verifyExactWatcher = async ({ expected, role }) => role === 'old'
      ? ({ ok: false, code: 'PROCESS_NOT_FOUND' })
      : ({ ok: true, watcher: { ...expected } });
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.runtime_id, 'runtime-new');
    assert.equal(state.stopCalls, 0);
    assert.equal(state.launchCalls, 0);
    assert.equal(existsSync(windowsSupervisorHandoffJournalPath(temp.dir)), false);
  } finally {
    temp.cleanup();
  }
});

test('planned recovery converts to a fresh launch only when old watcher, maintenance session, and port are absent', async () => {
  const temp = temporaryAppRoot();
  try {
    writeWindowsSupervisorHandoffJournal({ appRoot: temp.dir, journal: journal({ phase: 'planned' }) });
    const { hooks, state } = successfulHooks({ appRoot: temp.dir, initial: 'absent' });
    hooks.verifyExactWatcher = async ({ expected, role }) => role === 'old'
      ? ({ ok: false, code: 'PROCESS_NOT_FOUND' })
      : ({ ok: true, watcher: { ...expected } });
    hooks.maintenanceStatus = async () => ({ ok: true, state: 'absent' });
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.fresh, true);
    assert.equal(state.stopCalls, 0);
    assert.equal(state.startCalls, 0);
    assert.equal(state.launchCalls, 1);
  } finally {
    temp.cleanup();
  }
});

test('planned recovery preserves a matching durable STOPPED session when the old watcher is gone', async () => {
  const temp = temporaryAppRoot();
  try {
    writeWindowsSupervisorHandoffJournal({ appRoot: temp.dir, journal: journal({ phase: 'planned' }) });
    const { hooks, state } = successfulHooks({ appRoot: temp.dir, initial: 'absent' });
    hooks.verifyExactWatcher = async ({ expected, role }) => role === 'old'
      ? ({ ok: false, code: 'PROCESS_NOT_FOUND' })
      : ({ ok: true, watcher: { ...expected } });
    hooks.maintenanceStatus = async ({ lease, runtime_id }) => ({ ok: true, state: 'matching', lease, runtime_id });
    const result = await runWindowsSupervisorHandoff({ appRoot: temp.dir, target: TARGET, hooks });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(state.stopCalls, 0);
    assert.equal(state.startCalls, 1, 'the matching stopped lease must be consumed by maintenance-start');
    assert.equal(state.launchCalls, 1);
  } finally {
    temp.cleanup();
  }
});
