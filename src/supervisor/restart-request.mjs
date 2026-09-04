// Durable restart-request protocol between the Crew hub (3210) and the
// Windows Crew supervisor (launcher).
//
// The hub must NEVER spawn itself: self-spawn creates an ownership handoff
// window (port still held, PID reuse, no authority to judge the new
// process). Instead the hub writes a durable, self-describing restart
// request; the supervisor (the only process authority) polls, validates the
// request against its persisted ownership (PID + start time + live
// runtime_id), executes the restart, and writes a verified result.
//
// Directory layout (all under the Crew app root):
//   supervisor/restart-requests/<request-id>.json
//   supervisor/restart-results/<request-id>.json
//   supervisor/heartbeat.json
//   supervisor/ownership.json

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const RESTART_REQUEST_SCHEMA = 1;
export const RESTART_REQUEST_TTL_MS = 60_000;

export function supervisorStateRoot(appRoot) {
  return join(appRoot, 'supervisor');
}

export function restartRequestsDir(appRoot) {
  return join(supervisorStateRoot(appRoot), 'restart-requests');
}

export function restartResultsDir(appRoot) {
  return join(supervisorStateRoot(appRoot), 'restart-results');
}

export function heartbeatFile(appRoot) {
  return join(supervisorStateRoot(appRoot), 'heartbeat.json');
}

export function ownershipFile(appRoot) {
  return join(supervisorStateRoot(appRoot), 'ownership.json');
}

function writeFileAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content);
  try {
    renameSync(temp, file);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

/**
 * Create a durable restart request. The runtime identity is taken from the
 * CALLER's own live identity contract — never accepted from the HTTP caller —
 * so a stale or forged request cannot claim a runtime_id it does not hold.
 */
export function createRestartRequest({
  appRoot,
  runtimeIdentity,
  reason = null,
  now = Date.now(),
  ttlMs = RESTART_REQUEST_TTL_MS,
}) {
  return createSupervisorRequest({
    appRoot,
    operation: 'restart',
    runtimeIdentity,
    reason,
    now,
    ttlMs,
  });
}

/**
 * Create a durable supervisor request for maintenance transactions
 * (stop/start around a runtime-tree swap). The launcher-mediated npx flow
 * uses these instead of spawning/killing the 3210 itself: the launcher is
 * the only process authority. `lease` binds the stop and start phases of
 * one transaction; `extra` carries the expected versions for verification.
 */
export function createSupervisorRequest({
  appRoot,
  operation,
  runtimeIdentity,
  reason = null,
  lease = randomUUID(),
  extra = null,
  now = Date.now(),
  ttlMs = RESTART_REQUEST_TTL_MS,
}) {
  const request = {
    schema_version: RESTART_REQUEST_SCHEMA,
    request_id: randomUUID(),
    operation,
    execution_plane: runtimeIdentity?.execution_plane ?? 'hub-3210',
    profile: runtimeIdentity?.profile ?? 'dsh-crew',
    port: runtimeIdentity?.listen_port ?? 3210,
    runtime_id: runtimeIdentity?.runtime_id ?? null,
    lease,
    requested_at: now,
    expires_at: now + ttlMs,
    reason: reason ?? null,
    extra,
  };
  if (typeof request.runtime_id !== 'string' || request.runtime_id.length === 0) {
    return { ok: false, code: 'RUNTIME_IDENTITY_INCOMPLETE', error: 'cannot request supervisor action without a live runtime_id' };
  }
  const dir = operation.startsWith('maintenance-') ? maintenanceRequestsDir(appRoot) : restartRequestsDir(appRoot);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${request.request_id}.json`);
  writeFileAtomic(file, JSON.stringify(request, null, 2) + '\n');
  return { ok: true, request, file };
}

export function maintenanceRequestsDir(appRoot) {
  return join(supervisorStateRoot(appRoot), 'maintenance-requests');
}

export function maintenanceResultsDir(appRoot) {
  return join(supervisorStateRoot(appRoot), 'maintenance-results');
}

export function readRestartRequest(appRoot, requestId) {
  try {
    const parsed = JSON.parse(readFileSync(join(restartRequestsDir(appRoot), `${requestId}.json`), 'utf8'));
    if (parsed?.schema_version === RESTART_REQUEST_SCHEMA && parsed.request_id === requestId) return parsed;
  } catch { /* absent or malformed */ }
  return null;
}

export function listRestartRequests(appRoot) {
  const dir = restartRequestsDir(appRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try { return JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { return null; }
    })
    .filter(Boolean);
}

export function removeRestartRequest(appRoot, requestId) {
  try { rmSync(join(restartRequestsDir(appRoot), `${requestId}.json`), { force: true }); } catch {}
}

export function writeRestartResult({ appRoot, request, state, detail = null, now = Date.now() }) {
  const result = {
    schema_version: RESTART_REQUEST_SCHEMA,
    request_id: request.request_id,
    operation: request.operation,
    state,
    runtime_id: request.runtime_id,
    written_at: now,
    detail,
  };
  const file = join(restartResultsDir(appRoot), `${request.request_id}.json`);
  writeFileAtomic(file, JSON.stringify(result, null, 2) + '\n');
  return result;
}

export function readRestartResult(appRoot, requestId) {
  try {
    const parsed = JSON.parse(readFileSync(join(restartResultsDir(appRoot), `${requestId}.json`), 'utf8'));
    if (parsed?.schema_version === RESTART_REQUEST_SCHEMA && parsed.request_id === requestId) return parsed;
  } catch { /* absent */ }
  return null;
}

/** Observe a fresh heartbeat without granting it restart authority. */
export function readSupervisorHeartbeatRecord(appRoot, { now = Date.now(), staleAfterMs = 15_000 } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(heartbeatFile(appRoot), 'utf8'));
    if (parsed?.schema_version !== 1 || !Number.isInteger(parsed.pid) || parsed.pid < 1) return null;
    if (typeof parsed.last_seen !== 'number' || now - parsed.last_seen > staleAfterMs || parsed.last_seen - now > 5_000) return null;
    const hasOwnershipField = Object.hasOwn(parsed, 'ownership_ready');
    const state = !hasOwnershipField ? 'legacy-v1' : parsed.ownership_ready === true ? 'ready' : 'starting';
    return { state, record: { ...parsed, ownership_source: state } };
  } catch { return null; }
}

/** Return only an ownership-proven supervisor heartbeat. */
export function readSupervisorHeartbeat(appRoot, options = {}) {
  const observed = readSupervisorHeartbeatRecord(appRoot, options);
  return observed?.state === 'ready' ? observed.record : null;
}

export function writeSupervisorHeartbeat({ appRoot, pid, now = Date.now(), ownershipReady = true }) {
  const record = {
    schema_version: 1,
    supervisor_instance_id: randomUUID(),
    pid,
    ownership_ready: ownershipReady === true,
    last_seen: now,
    protocol_version: 1,
  };
  // Merge onto the previous record so the instance id is stable per watcher
  // run (the watcher rewrites this file every few seconds).
  try {
    const prev = JSON.parse(readFileSync(heartbeatFile(appRoot), 'utf8'));
    if (prev?.schema_version === 1) record.supervisor_instance_id = prev.supervisor_instance_id;
  } catch { /* first beat */ }
  writeFileAtomic(heartbeatFile(appRoot), JSON.stringify(record, null, 2) + '\n');
  return record;
}
