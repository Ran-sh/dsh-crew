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
} from '../src/supervisor/restart-request.mjs';

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
