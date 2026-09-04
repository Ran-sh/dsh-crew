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
    writeSupervisorHeartbeat({ appRoot: t.dir, pid: 4242, now });
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

test('malformed heartbeat file is treated as no supervisor', () => {
  const t = tempRoot();
  try {
    const hb = heartbeatFile(t.dir);
    mkdirSync(hb.replace(/[^/\\]+$/, ''), { recursive: true });
    writeFileSync(hb, '{ not json');
    assert.equal(readSupervisorHeartbeat(t.dir, { now: 1_000_000 }), null);
  } finally { t.cleanup(); }
});
