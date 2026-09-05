import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { homedir } from 'node:os';

import {
  readMaintenanceSession,
  readSupervisorHeartbeat,
  readSupervisorHeartbeatRecord,
} from '../supervisor/restart-request.mjs';
import {
  acquireWindowsSupervisorHandoffLock,
  releaseWindowsSupervisorHandoffLock,
  runWindowsSupervisorHandoff,
  windowsSupervisorHandoffJournalPath,
  windowsSupervisorHandoffLockPath,
} from './windows-supervisor-lifecycle.mjs';
import { readWindowsSupervisorAssets } from './windows-startup.mjs';

const HASH_RE = /^[a-f0-9]{64}$/u;
export const PENDING_RUNTIME_ACTIVATION = 'runtime-activation-pending';
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sameHash(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
}

export function validateSupervisorRuntime(runtime, { expectedCrewVersion = null, expectedDshVersion = null } = {}) {
  return !!runtime
    && text(runtime.runtime_id) !== null
    && runtime.service === 'dsh-crew-hub'
    && runtime.execution_plane === 'hub-3210'
    && runtime.profile === 'dsh-crew'
    && Number(runtime.listen_port) === 3210
    && Number(runtime.protocol_version) === 1
    && (!expectedCrewVersion || runtime.runtime_version === expectedCrewVersion)
    && (!expectedDshVersion || runtime.dsh_version === expectedDshVersion);
}

export function hashSupervisorHelper(file) {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return null; }
}

export function canonicalWindowsPowerShellPath({
  environment = process.env,
  exists = existsSync,
} = {}) {
  const systemRoot = text(environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR ?? environment.windir);
  if (!systemRoot || !win32.isAbsolute(systemRoot)) return null;
  const candidate = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return exists(candidate) ? candidate : null;
}

function samePath(left, right) {
  return typeof left === 'string'
    && typeof right === 'string'
    && left.replaceAll('/', '\\').toLowerCase() === right.replaceAll('/', '\\').toLowerCase();
}

export function runWindowsSupervisorControl(request, {
  controlScript,
  timeoutMs = 60_000,
  maxOutputBytes = 64 * 1024,
  spawnImpl = spawn,
  environment = process.env,
  exists = existsSync,
} = {}) {
  return new Promise((resolve) => {
    if (!text(controlScript)) {
      resolve({ ok: false, code: 'SUPERVISOR_CONTROL_SCRIPT_MISSING' });
      return;
    }
    const powerShell = canonicalWindowsPowerShellPath({ environment, exists });
    if (!powerShell) {
      resolve({ ok: false, code: 'SUPERVISOR_CONTROL_POWERSHELL_UNAVAILABLE' });
      return;
    }
    let child;
    try {
      child = spawnImpl(powerShell, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', controlScript,
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, code: 'SUPERVISOR_CONTROL_START_FAILED' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const append = (current, chunk) => {
      const next = current + String(chunk);
      if (Buffer.byteLength(next, 'utf8') > maxOutputBytes) {
        try { child.kill(); } catch {}
        finish({ ok: false, code: 'SUPERVISOR_CONTROL_OUTPUT_LIMIT' });
        return current;
      }
      return next;
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', () => finish({ ok: false, code: 'SUPERVISOR_CONTROL_START_FAILED' }));
    child.on('close', (code) => {
      if (settled) return;
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim()); } catch {}
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        finish({ ok: false, code: 'SUPERVISOR_CONTROL_RESPONSE_INVALID', detail: stderr.trim().slice(-300) || null });
        return;
      }
      finish(code === 0 && parsed.ok === true
        ? parsed
        : { ok: false, code: text(parsed.code) ?? 'SUPERVISOR_CONTROL_FAILED', error: text(parsed.error) ?? null });
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, code: 'SUPERVISOR_CONTROL_TIMEOUT' });
    }, timeoutMs);
    timer.unref?.();
    try { child.stdin.end(JSON.stringify(request)); } catch { finish({ ok: false, code: 'SUPERVISOR_CONTROL_STDIN_FAILED' }); }
  });
}

function portFree(port = 3210) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve({ ok: true, free: false }));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve({ ok: true, free: true }));
    });
  });
}

async function runtimeFromHub(fetchImpl = globalThis.fetch, timeoutMs = 3_000) {
  try {
    const response = await fetchImpl('http://127.0.0.1:3210/_dsh/dsh-crew/extension', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, Math.min(3_000, timeoutMs))),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.ok === true ? body.extension?.runtime ?? null : null;
  } catch { return null; }
}

function watcherRequest(operation, target, expected = null, { allowHelperDrift = false } = {}) {
  return {
    operation,
    helper_path: target.helper_path,
    ...(expected ? { expected } : {}),
    ...(allowHelperDrift ? { allow_helper_drift: true } : {}),
    ...(operation === 'start' ? { helper_hash: target.helper_hash } : {}),
  };
}

export function createWindowsSupervisorHandoffHooks({
  appRoot = null,
  target,
  maintenanceClient,
  expectedCrewVersion = null,
  expectedDshVersion = null,
  readHeartbeatRecord = () => readSupervisorHeartbeatRecord(appRoot, { staleAfterMs: 30_000 }),
  readAuthoritativeHeartbeat = () => readSupervisorHeartbeat(appRoot, { staleAfterMs: 30_000 }),
  runControl,
  controlScript,
  fetchRuntime = ({ timeoutMs = 3_000 } = {}) => runtimeFromHub(globalThis.fetch, timeoutMs),
  verifyPortFree = ({ port }) => portFree(port),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  readyTimeoutMs = 90_000,
  heartbeatRecoveryAttempts = 180,
  heartbeatRecoveryPollMs = 500,
  now = Date.now,
} = {}) {
  const control = runControl ?? ((request) => runWindowsSupervisorControl(request, { controlScript }));

  const inspect = async (expected, { allowHelperDrift = false } = {}) => control(watcherRequest(
    'inspect', target, expected, { allowHelperDrift },
  ));
  const classifyHeartbeat = async ({
    expect_target: expectTarget = false,
    attempt = 0,
    deadline = null,
    live_runtime_seen: liveRuntimeSeen = false,
  } = {}) => {
    const cutoff = Number.isFinite(deadline) ? deadline : now() + readyTimeoutMs;
    const remaining = () => Math.max(0, cutoff - now());
    const fetchWithinBudget = async () => {
      const budget = remaining();
      return budget > 0 ? fetchRuntime({ timeoutMs: Math.min(3_000, budget) }) : null;
    };
    const retry = async (sawLive) => {
      const budget = remaining();
      if (attempt >= heartbeatRecoveryAttempts || budget <= 0) return null;
      await sleep(Math.min(heartbeatRecoveryPollMs, budget));
      return classifyHeartbeat({
        expect_target: expectTarget,
        attempt: attempt + 1,
        deadline: cutoff,
        live_runtime_seen: sawLive,
      });
    };
    const observed = readHeartbeatRecord();
    let runtime = null;
    if (!observed) {
      runtime = await fetchWithinBudget();
      const sawLive = liveRuntimeSeen || !!runtime?.runtime_id;
      if (sawLive || expectTarget) {
        const retried = await retry(sawLive);
        if (retried) return retried;
      }
      if (sawLive) return { ok: false, code: 'SUPERVISOR_HEARTBEAT_MISSING_WITH_LIVE_RUNTIME' };
      if (expectTarget) return { ok: false, code: 'SUPERVISOR_TARGET_HEARTBEAT_TIMEOUT' };
      return { ok: true, classification: 'absent', watcher: null, runtime_id: null };
    }
      const record = observed.record ?? {};
      const expected = {
        pid: record.pid,
        ...(record.process_started_at_utc_ticks ? { process_started_at_utc_ticks: String(record.process_started_at_utc_ticks) } : {}),
        ...(record.helper_hash ? { helper_hash: record.helper_hash } : {}),
      };
      const fullyAttestedStale = observed.state !== 'legacy-v1'
        && expected.process_started_at_utc_ticks
        && expected.helper_hash
        && !sameHash(expected.helper_hash, target.helper_hash);
      const inspected = await inspect(expected, { allowHelperDrift: fullyAttestedStale });
      if (inspected?.ok === false && inspected.code === 'PROCESS_NOT_FOUND') {
        if (expectTarget) {
          const retried = await retry(liveRuntimeSeen);
          if (retried) return retried;
        }
        runtime ??= await fetchWithinBudget();
        if (runtime?.runtime_id) {
          return { ok: false, code: 'SUPERVISOR_HEARTBEAT_PROCESS_MISSING_WITH_LIVE_RUNTIME' };
        }
        if (expectTarget) {
          return {
            ok: false,
            code: liveRuntimeSeen
              ? 'SUPERVISOR_HEARTBEAT_PROCESS_MISSING_WITH_LIVE_RUNTIME'
              : 'SUPERVISOR_TARGET_HEARTBEAT_TIMEOUT',
          };
        }
        return { ok: true, classification: 'absent', watcher: null, runtime_id: null };
      }
      if (inspected?.ok !== true || !inspected.watcher) return inspected ?? { ok: false, code: 'SUPERVISOR_WATCHER_UNVERIFIED' };
      runtime ??= await fetchWithinBudget();
      if (observed.state === 'legacy-v1') {
        return runtime?.runtime_id
          ? { ok: true, classification: 'legacy', watcher: inspected.watcher, runtime_id: runtime.runtime_id }
          : { ok: false, code: 'SUPERVISOR_RUNTIME_IDENTITY_UNAVAILABLE' };
      }
      const targetHash = sameHash(record.helper_hash, target.helper_hash);
      if (targetHash && observed.state === 'ready') {
        return runtime?.runtime_id
          ? { ok: true, classification: 'target-ready', watcher: inspected.watcher, runtime_id: runtime.runtime_id }
          : { ok: false, code: 'SUPERVISOR_RUNTIME_IDENTITY_UNAVAILABLE' };
      }
      if (targetHash) return { ok: true, classification: 'target-starting', watcher: inspected.watcher, runtime_id: runtime?.runtime_id ?? null };
      return runtime?.runtime_id
        ? { ok: true, classification: 'stale', watcher: inspected.watcher, runtime_id: runtime.runtime_id }
        : { ok: false, code: 'SUPERVISOR_RUNTIME_IDENTITY_UNAVAILABLE' };
  };
  return {
    classifyHeartbeat,
    verifyExactWatcher: async ({ expected, role }) => inspect(expected, {
      allowHelperDrift: role === 'old' && !sameHash(expected?.helper_hash, target.helper_hash),
    }),
    maintenanceStop: async ({ lease, runtime_id: runtimeId }) => maintenanceClient?.stopOwnedBackend?.({ lease, runtimeId })
      ?? { ok: false, code: 'SUPERVISOR_MAINTENANCE_UNAVAILABLE' },
    maintenanceStatus: async ({ lease, runtime_id: runtimeId }) => {
      const durable = readMaintenanceSession(appRoot);
      if (!durable.ok) return durable;
      if (durable.state === 'absent') return { ok: true, state: 'absent' };
      const session = durable.session;
      return session.lease === lease && session.runtime_id === runtimeId
        ? { ok: true, state: 'matching', lease, runtime_id: runtimeId, request_id: session.request_id }
        : { ok: true, state: 'conflict', lease: session.lease, runtime_id: session.runtime_id };
    },
    verifyPortFree,
    stopExactWatcher: async ({ expected }) => control(watcherRequest('stop', target, expected, {
      allowHelperDrift: !sameHash(expected?.helper_hash, target.helper_hash),
    })),
    launchTargetWatcher: async () => control(watcherRequest('start', target)),
    maintenanceStart: async ({ lease, runtime_id: runtimeId }) => maintenanceClient?.startOwnedBackend?.({
      lease,
      runtimeId,
      expectedCrewVersion,
      expectedDshVersion,
    }) ?? { ok: false, code: 'SUPERVISOR_MAINTENANCE_UNAVAILABLE' },
    verifyReady: async ({ previous_runtime_id: previousRuntimeId }) => {
      const deadline = now() + readyTimeoutMs;
      while (now() <= deadline) {
        const heartbeat = readAuthoritativeHeartbeat();
        if (heartbeat && sameHash(heartbeat.helper_hash, target.helper_hash)) {
          const exact = await inspect({
            pid: heartbeat.pid,
            process_started_at_utc_ticks: String(heartbeat.process_started_at_utc_ticks),
            helper_hash: heartbeat.helper_hash,
          });
          const runtime = await fetchRuntime({ timeoutMs: Math.max(1, Math.min(3_000, deadline - now())) });
          if (exact?.ok === true
            && exact.watcher
            && validateSupervisorRuntime(runtime, { expectedCrewVersion, expectedDshVersion })
            && (!previousRuntimeId || runtime.runtime_id !== previousRuntimeId)) {
            return { ok: true, watcher: exact.watcher, runtime };
          }
        }
        await sleep(500);
      }
      return { ok: false, code: 'SUPERVISOR_READY_TIMEOUT' };
    },
  };
}

function prepareWindowsSupervisorConvergence({ home, root, platform }) {
  if (platform !== 'win32') return { ok: true, skipped: true, reason: 'unsupported-platform' };
  const appRoot = join(home, '.config', 'dsh-crew');
  const assets = readWindowsSupervisorAssets({ home });
  if (!assets.ok || !HASH_RE.test(assets.helper_hash) || !HASH_RE.test(assets.control_hash)) {
    return { ok: false, code: 'SUPERVISOR_TARGET_UNAVAILABLE' };
  }
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch {}
  const expectedCrewVersion = text(manifest?.version);
  let expectedDshVersion = text(manifest?.dependencies?.['@deepseek-ai/dsh'] ?? manifest?.peerDependencies?.['@deepseek-ai/dsh']);
  if (!EXACT_VERSION_RE.test(expectedDshVersion ?? '')) {
    try {
      const cohort = JSON.parse(readFileSync(join(root, 'release-cohort.json'), 'utf8'));
      expectedDshVersion = text(cohort?.dsh_version);
    } catch { expectedDshVersion = null; }
  }
  if (manifest?.name !== '@ran-sh/dsh-crew'
    || !EXACT_VERSION_RE.test(expectedCrewVersion ?? '')
    || !EXACT_VERSION_RE.test(expectedDshVersion ?? '')) {
    return { ok: false, code: 'SUPERVISOR_TARGET_UNAVAILABLE' };
  }
  return {
    ok: true,
    home,
    root,
    appRoot,
    target: {
      helper_path: assets.helper_path,
      helper_hash: assets.helper_hash,
      control_path: assets.control_path,
      control_hash: assets.control_hash,
    },
    controlScript: assets.control_path,
    controlHash: assets.control_hash,
    expectedCrewVersion,
    expectedDshVersion,
  };
}

export function windowsSupervisorConvergencePending({ home = homedir() } = {}) {
  const appRoot = join(home, '.config', 'dsh-crew');
  return existsSync(windowsSupervisorHandoffJournalPath(appRoot))
    || existsSync(windowsSupervisorHandoffLockPath(appRoot));
}

export function reserveWindowsSupervisorConvergence({
  home = homedir(),
  root,
  platform = process.platform,
} = {}) {
  const prepared = prepareWindowsSupervisorConvergence({ home, root, platform });
  if (!prepared.ok || prepared.skipped) return prepared;
  const lock = acquireWindowsSupervisorHandoffLock({ appRoot: prepared.appRoot });
  return lock.ok ? { ...prepared, lock } : { ok: false, code: lock.code, error: lock.error ?? null };
}

export function releaseWindowsSupervisorConvergenceReservation(reservation) {
  if (!reservation?.lock) return { ok: false, code: 'SUPERVISOR_RESERVATION_INVALID' };
  return releaseWindowsSupervisorHandoffLock(reservation.lock);
}

export async function convergeWindowsSupervisor({
  home = homedir(),
  root,
  maintenanceClient,
  platform = process.platform,
  runControl,
  fetchRuntime,
  readHeartbeatRecord,
  readAuthoritativeHeartbeat,
  verifyPortFree,
  sleep,
  reservation = null,
} = {}) {
  const prepared = prepareWindowsSupervisorConvergence({ home, root, platform });
  if (!prepared.ok || prepared.skipped) {
    if (reservation?.lock) releaseWindowsSupervisorHandoffLock(reservation.lock);
    return prepared;
  }
  if (reservation && (!reservation.ok
    || !samePath(reservation.root, prepared.root)
    || !samePath(reservation.target?.helper_path, prepared.target.helper_path)
    || !sameHash(reservation.target?.helper_hash, prepared.target.helper_hash)
    || !samePath(reservation.target?.control_path, prepared.target.control_path)
    || !sameHash(reservation.target?.control_hash, prepared.target.control_hash)
    || reservation.expectedCrewVersion !== prepared.expectedCrewVersion
    || reservation.expectedDshVersion !== prepared.expectedDshVersion)) {
    if (reservation?.lock) releaseWindowsSupervisorHandoffLock(reservation.lock);
    return { ok: false, code: 'SUPERVISOR_RESERVATION_MISMATCH' };
  }
  const hooks = createWindowsSupervisorHandoffHooks({
    appRoot: prepared.appRoot,
    target: prepared.target,
    maintenanceClient,
    expectedCrewVersion: prepared.expectedCrewVersion,
    expectedDshVersion: prepared.expectedDshVersion,
    controlScript: prepared.controlScript,
    runControl,
    fetchRuntime,
    readHeartbeatRecord,
    readAuthoritativeHeartbeat,
    verifyPortFree,
    sleep,
  });
  return runWindowsSupervisorHandoff({
    appRoot: prepared.appRoot,
    target: prepared.target,
    hooks,
    preAcquiredLock: reservation?.lock ?? null,
    forceRestart: existsSync(join(root, PENDING_RUNTIME_ACTIVATION)),
  });
}
