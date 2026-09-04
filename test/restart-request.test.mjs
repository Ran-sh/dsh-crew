import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createRestartRequest,
  readRestartRequest,
  listRestartRequests,
  removeRestartRequest,
  writeRestartResult,
  readRestartResult,
  writeSupervisorHeartbeat,
  readSupervisorHeartbeat,
  readSupervisorHeartbeatRecord,
  supervisorStateRoot,
  heartbeatFile,
} from '../src/supervisor/restart-request.mjs';

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-restart-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('createRestartRequest writes a durable, identity-bound request', () => {
  const t = tempRoot();
  try {
    const created = createRestartRequest({
      appRoot: t.dir,
      runtimeIdentity: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'rid-1' },
      reason: 'vision toggle',
    });
    assert.equal(created.ok, true);
    assert.equal(created.request.runtime_id, 'rid-1');
    assert.ok(created.request.request_id.length > 0);
    assert.ok(created.request.expires_at > created.request.requested_at);
    const file = join(supervisorStateRoot(t.dir), 'restart-requests', `${created.request.request_id}.json`);
    assert.equal(existsSync(file), true, 'request file durable on disk');
    const reread = readRestartRequest(t.dir, created.request.request_id);
    assert.equal(reread?.operation, 'restart');
    assert.equal(reread?.runtime_id, 'rid-1');
  } finally { t.cleanup(); }
});

test('createRestartRequest fails closed without a runtime_id', () => {
  const t = tempRoot();
  try {
    const created = createRestartRequest({
      appRoot: t.dir,
      runtimeIdentity: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: null },
    });
    assert.equal(created.ok, false);
    assert.equal(created.code, 'RUNTIME_IDENTITY_INCOMPLETE');
    assert.equal(listRestartRequests(t.dir).length, 0);
  } finally { t.cleanup(); }
});

test('writeRestartResult + readRestartResult round-trip', () => {
  const t = tempRoot();
  try {
    const created = createRestartRequest({
      appRoot: t.dir,
      runtimeIdentity: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'rid-1' },
    });
    writeRestartResult({ appRoot: t.dir, request: created.request, state: 'VERIFIED', detail: { previous_runtime_id: 'rid-1', runtime_id: 'rid-2' } });
    const result = readRestartResult(t.dir, created.request.request_id);
    assert.equal(result?.state, 'VERIFIED');
    assert.equal(result?.detail?.runtime_id, 'rid-2');
    removeRestartRequest(t.dir, created.request.request_id);
    assert.equal(listRestartRequests(t.dir).length, 0);
  } finally { t.cleanup(); }
});

test('supervisor heartbeat freshness gate', () => {
  const t = tempRoot();
  try {
    
    const now = 1_000_000;
    // No heartbeat yet -> unavailable.
    assert.equal(readSupervisorHeartbeat(t.dir, { now }), null);
    writeSupervisorHeartbeat({
      appRoot: t.dir,
      pid: 4242,
      now,
      processStartedAtUtcTicks: '123',
      helperHash: 'a'.repeat(64),
      supervisorInstanceId: '11111111-1111-4111-8111-111111111111',
    });
    const fresh = readSupervisorHeartbeat(t.dir, { now: now + 5_000 });
    assert.equal(fresh?.pid, 4242);
    assert.equal(fresh.schema_version, 1);
    // Stale beyond tolerance -> unavailable.
    assert.equal(readSupervisorHeartbeat(t.dir, { now: now + 20_000 }), null);
    // Malformed -> unavailable.
    const hb = heartbeatFile(t.dir);
    rmSync(hb, { force: true });
    return;
  } finally { t.cleanup(); }
});

test('supervisor heartbeat without proven process ownership is unavailable', () => {
  const t = tempRoot();
  try {
    const now = 1_000_000;
    writeSupervisorHeartbeat({ appRoot: t.dir, pid: 4242, now, ownershipReady: false });
    assert.equal(readSupervisorHeartbeat(t.dir, { now: now + 1_000 }), null);
  } finally { t.cleanup(); }
});

test('ownership flag without watcher identity and helper hash is not authoritative', () => {
  const t = tempRoot();
  try {
    const now = 1_000_000;
    const hb = heartbeatFile(t.dir);
    mkdirSync(hb.replace(/[^/\\]+$/, ''), { recursive: true });
    writeFileSync(hb, JSON.stringify({ schema_version: 1, pid: 4242, ownership_ready: true, last_seen: now, protocol_version: 1 }));
    assert.equal(readSupervisorHeartbeatRecord(t.dir, { now: now + 1_000 })?.state, 'starting');
    assert.equal(readSupervisorHeartbeat(t.dir, { now: now + 1_000 }), null);
  } finally { t.cleanup(); }
});

test('numeric process-start ticks are rejected because JSON cannot preserve Windows Int64 identity', () => {
  const t = tempRoot();
  try {
    const now = 1_000_000;
    const hb = heartbeatFile(t.dir);
    mkdirSync(hb.replace(/[^/\\]+$/, ''), { recursive: true });
    writeFileSync(hb, JSON.stringify({
      schema_version: 1,
      pid: 4242,
      process_started_at_utc_ticks: 638609500000000000,
      helper_hash: 'a'.repeat(64),
      supervisor_instance_id: '11111111-1111-4111-8111-111111111111',
      ownership_ready: true,
      last_seen: now,
      protocol_version: 1,
    }));
    assert.equal(readSupervisorHeartbeatRecord(t.dir, { now })?.state, 'starting');
    assert.equal(readSupervisorHeartbeat(t.dir, { now }), null);
  } finally { t.cleanup(); }
});

test('heartbeat instance identity is reused only for the exact same watcher lifetime and helper', () => {
  const t = tempRoot();
  try {
    const common = {
      appRoot: t.dir,
      pid: 4242,
      processStartedAtUtcTicks: '638609500000000000',
      helperHash: 'a'.repeat(64),
      now: 1_000,
    };
    const first = writeSupervisorHeartbeat({ ...common, supervisorInstanceId: 'instance-one' });
    const same = writeSupervisorHeartbeat({ ...common, now: 2_000 });
    const replacement = writeSupervisorHeartbeat({
      ...common,
      processStartedAtUtcTicks: '638609500000000001',
      now: 3_000,
    });
    assert.equal(first.supervisor_instance_id, 'instance-one');
    assert.equal(same.supervisor_instance_id, 'instance-one');
    assert.notEqual(replacement.supervisor_instance_id, 'instance-one');
  } finally { t.cleanup(); }
});

test('legacy v1 heartbeat is identifiable but never authoritative', () => {
  const t = tempRoot();
  try {
    const now = 1_000_000;
    const hb = heartbeatFile(t.dir);
    mkdirSync(hb.replace(/[^/\\]+$/, ''), { recursive: true });
    writeFileSync(hb, JSON.stringify({ schema_version: 1, pid: 4242, last_seen: now, protocol_version: 1 }));
    const legacy = readSupervisorHeartbeatRecord(t.dir, { now: now + 1_000 });
    assert.equal(legacy?.record?.pid, 4242);
    assert.equal(legacy?.state, 'legacy-v1');
    assert.equal(readSupervisorHeartbeat(t.dir, { now: now + 1_000 }), null);
  } finally { t.cleanup(); }
});

test('malformed heartbeat file is treated as no supervisor', () => {
  const t = tempRoot();
  try {
    const hb = heartbeatFile(t.dir);
    mkdirSync(hb.replace(/[^/\\]+$/, ''), { recursive: true });
    writeFileSync(hb, '{ not json');
    assert.equal(readSupervisorHeartbeat(t.dir, { now: 1_000_000 }), null);
  } finally { t.cleanup(); }
});
