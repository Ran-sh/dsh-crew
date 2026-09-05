import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const WINDOWS_SUPERVISOR_HANDOFF_SCHEMA = 1;
export const WINDOWS_SUPERVISOR_HANDOFF_PHASES = Object.freeze([
  'planned',
  'backend-stopped',
  'old-watcher-stopped',
  'new-watcher-started',
  'verified',
]);

const HANDOFF_PHASE_SET = new Set(WINDOWS_SUPERVISOR_HANDOFF_PHASES);
const HASH_RE = /^[a-f0-9]{64}$/i;

function nonEmptyString(value, max = 32_768) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validHash(value) {
  return typeof value === 'string' && HASH_RE.test(value);
}

function normalizedHash(value) {
  return value.toLowerCase();
}

function normalizedWindowsPath(value) {
  return value.replaceAll('/', '\\').replace(/\\+$/u, '').toLowerCase();
}

function validProcessStart(value) {
  return typeof value === 'string' && /^\d+$/u.test(value) && value !== '0';
}

function validWatcher(value) {
  return value !== null
    && typeof value === 'object'
    && Number.isInteger(value.pid)
    && value.pid > 0
    && validProcessStart(value.process_started_at_utc_ticks)
    && validHash(value.helper_hash);
}

function normalizedWatcher(value) {
  return {
    pid: value.pid,
    process_started_at_utc_ticks: String(value.process_started_at_utc_ticks),
    helper_hash: normalizedHash(value.helper_hash),
  };
}

function validTarget(value) {
  return value !== null
    && typeof value === 'object'
    && nonEmptyString(value.helper_path)
    && validHash(value.helper_hash)
    && nonEmptyString(value.control_path)
    && validHash(value.control_hash);
}

function normalizedTarget(value) {
  return {
    helper_path: value.helper_path.trim(),
    helper_hash: normalizedHash(value.helper_hash),
    control_path: value.control_path.trim(),
    control_hash: normalizedHash(value.control_hash),
  };
}

function sameWatcher(left, right) {
  return validWatcher(left)
    && validWatcher(right)
    && left.pid === right.pid
    && String(left.process_started_at_utc_ticks) === String(right.process_started_at_utc_ticks)
    && normalizedHash(left.helper_hash) === normalizedHash(right.helper_hash);
}

function sameTarget(left, right) {
  return validTarget(left)
    && validTarget(right)
    && normalizedWindowsPath(left.helper_path) === normalizedWindowsPath(right.helper_path)
    && normalizedHash(left.helper_hash) === normalizedHash(right.helper_hash)
    && normalizedWindowsPath(left.control_path) === normalizedWindowsPath(right.control_path)
    && normalizedHash(left.control_hash) === normalizedHash(right.control_hash);
}

function validateJournal(journal) {
  if (journal === null || typeof journal !== 'object' || Array.isArray(journal)) return false;
  if (journal.schema_version !== WINDOWS_SUPERVISOR_HANDOFF_SCHEMA) return false;
  if (!nonEmptyString(journal.handoff_id, 512)) return false;
  if (!HANDOFF_PHASE_SET.has(journal.phase)) return false;
  if (!nonEmptyString(journal.lease, 512)) return false;
  if (!validTarget(journal.target)) return false;
  if (typeof journal.updated_at !== 'number' || !Number.isFinite(journal.updated_at) || journal.updated_at < 0) return false;
  if (journal.old === null) return journal.runtime_id === null;
  return validWatcher(journal.old) && nonEmptyString(journal.runtime_id, 2_048);
}

function journalFileFor({ appRoot, journalFile }) {
  if (nonEmptyString(journalFile)) return journalFile;
  return windowsSupervisorHandoffJournalPath(appRoot);
}

function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, file);
  } finally {
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
  }
}

export function windowsSupervisorHandoffJournalPath(appRoot) {
  if (!nonEmptyString(appRoot)) throw new TypeError('appRoot is required');
  return join(appRoot, 'supervisor', 'handoff.json');
}

export function windowsSupervisorHandoffLockPath(appRoot) {
  return `${windowsSupervisorHandoffJournalPath(appRoot)}.lock`;
}

export function readWindowsSupervisorHandoffJournal({ appRoot, journalFile } = {}) {
  let file;
  try {
    file = journalFileFor({ appRoot, journalFile });
  } catch (error) {
    return { ok: false, code: 'SUPERVISOR_HANDOFF_JOURNAL_PATH_INVALID', error: error.message, journal: null };
  }
  if (!existsSync(file)) return { ok: true, state: 'absent', journal: null };
  try {
    const journal = JSON.parse(readFileSync(file, 'utf8'));
    if (!validateJournal(journal)) {
      return { ok: false, code: 'SUPERVISOR_HANDOFF_JOURNAL_MALFORMED', error: 'handoff journal schema is invalid', journal: null };
    }
    return { ok: true, state: 'present', journal };
  } catch (error) {
    return { ok: false, code: 'SUPERVISOR_HANDOFF_JOURNAL_MALFORMED', error: error.message, journal: null };
  }
}

export function writeWindowsSupervisorHandoffJournal({ appRoot, journalFile, journal } = {}) {
  if (!validateJournal(journal)) {
    return { ok: false, code: 'SUPERVISOR_HANDOFF_JOURNAL_MALFORMED', error: 'refusing to persist an invalid handoff journal' };
  }
  let file;
  try {
    file = journalFileFor({ appRoot, journalFile });
    atomicWrite(file, `${JSON.stringify(journal, null, 2)}\n`);
    const reread = readWindowsSupervisorHandoffJournal({ appRoot, journalFile: file });
    if (!reread.ok || reread.state !== 'present' || reread.journal.handoff_id !== journal.handoff_id || reread.journal.phase !== journal.phase) {
      return { ok: false, code: 'SUPERVISOR_HANDOFF_JOURNAL_VERIFY_FAILED', error: 'handoff journal did not round-trip exactly' };
    }
    return { ok: true, file, journal: reread.journal };
  } catch (error) {
    return { ok: false, code: 'SUPERVISOR_HANDOFF_JOURNAL_WRITE_FAILED', error: error.message };
  }
}

export function clearWindowsSupervisorHandoffJournal({ appRoot, journalFile, handoffId } = {}) {
  const current = readWindowsSupervisorHandoffJournal({ appRoot, journalFile });
  if (!current.ok) return current;
  if (current.state === 'absent') return { ok: true, state: 'absent', idempotent: true };
  if (nonEmptyString(handoffId, 512) && current.journal.handoff_id !== handoffId) {
    return {
      ok: false,
      code: 'SUPERVISOR_HANDOFF_JOURNAL_IDENTITY_MISMATCH',
      error: 'refusing to clear a different handoff transaction',
    };
  }
  const file = journalFileFor({ appRoot, journalFile });
  try {
    rmSync(file, { force: true });
    if (existsSync(file)) {
      return { ok: false, code: 'SUPERVISOR_HANDOFF_JOURNAL_CLEAR_FAILED', error: 'handoff journal is still present' };
    }
    return { ok: true, state: 'cleared' };
  } catch (error) {
    return { ok: false, code: 'SUPERVISOR_HANDOFF_JOURNAL_CLEAR_FAILED', error: error.message };
  }
}

function defaultAcquireLock({ journalFile, now }) {
  const file = `${journalFile}.lock`;
  const token = randomUUID();
  const record = { schema_version: 1, token, pid: process.pid, acquired_at: now };
  const tryCreate = () => {
    const pending = `${file}.pending.${process.pid}.${randomUUID()}`;
    try {
      mkdirSync(pending);
      writeFileSync(join(pending, 'owner.json'), `${JSON.stringify(record)}\n`, { flag: 'wx' });
      renameSync(pending, file);
      return { ok: true, token, file };
    } catch (error) {
      try { rmSync(pending, { recursive: true, force: true }); } catch { /* best effort */ }
      return {
        ok: false,
        code: ['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code) ? 'LOCK_HELD' : 'LOCK_FAILED',
        error: error?.message,
        file,
      };
    }
  };
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = tryCreate();
    if (created.ok || created.code !== 'LOCK_HELD') return created;
    const reclaimed = reclaimDefaultLock({ file });
    if (!reclaimed.ok) return reclaimed;
  }
  return { ok: false, code: 'LOCK_HELD', file };
}

export function acquireWindowsSupervisorHandoffLock({ appRoot, journalFile, now = Date.now() } = {}) {
  let file;
  try { file = journalFileFor({ appRoot, journalFile }); } catch (error) {
    return { ok: false, code: 'LOCK_FAILED', error: error.message };
  }
  return defaultAcquireLock({ journalFile: file, now: timestamp(now) });
}

function lockOwnerAlive(record) {
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function reclaimDefaultLock({ file }) {
  let current;
  try { current = JSON.parse(readFileSync(join(file, 'owner.json'), 'utf8')); } catch {
    return { ok: false, code: 'LOCK_FAILED', error: 'handoff lock is malformed', file };
  }
  if (!nonEmptyString(current?.token, 512) || lockOwnerAlive(current)) {
    return { ok: false, code: 'LOCK_HELD', file };
  }
  const quarantine = `${file}.stale.${process.pid}.${randomUUID()}`;
  try {
    // Directory rename is the atomic claim. Exactly one contender can move
    // the canonical lock; all others retry acquisition without ever deleting
    // a replacement owner's lock.
    renameSync(file, quarantine);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, reclaimed: false };
    return {
      ok: false,
      code: ['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code) ? 'LOCK_HELD' : 'LOCK_FAILED',
      error: error?.message,
      file,
    };
  }

  try {
    const claimed = JSON.parse(readFileSync(join(quarantine, 'owner.json'), 'utf8'));
    if (claimed?.token !== current.token || claimed?.pid !== current.pid) {
      return { ok: false, code: 'LOCK_FAILED', error: 'handoff lock identity changed during reclaim', file };
    }
    rmSync(quarantine, { recursive: true, force: true });
    return { ok: true, reclaimed: true };
  } catch (error) {
    return { ok: false, code: 'LOCK_FAILED', error: error?.message, file };
  }
}

function defaultReleaseLock({ lock }) {
  if (!lock?.file || !lock?.token) return { ok: false, code: 'LOCK_IDENTITY_INCOMPLETE' };
  const quarantine = `${lock.file}.release.${process.pid}.${randomUUID()}`;
  try {
    const record = JSON.parse(readFileSync(join(lock.file, 'owner.json'), 'utf8'));
    if (record?.token !== lock.token) return { ok: false, code: 'LOCK_IDENTITY_MISMATCH' };
    renameSync(lock.file, quarantine);
    const claimed = JSON.parse(readFileSync(join(quarantine, 'owner.json'), 'utf8'));
    if (claimed?.token !== lock.token) return { ok: false, code: 'LOCK_IDENTITY_MISMATCH' };
    rmSync(quarantine, { recursive: true, force: true });
    return { ok: !existsSync(lock.file) && !existsSync(quarantine) };
  } catch (error) {
    return { ok: false, code: 'LOCK_RELEASE_FAILED', error: error.message };
  }
}

export function releaseWindowsSupervisorHandoffLock(lock) {
  return defaultReleaseLock({ lock });
}

function validatePreAcquiredLock(lock, journalFile) {
  const expectedFile = `${journalFile}.lock`;
  if (!lock?.ok || !nonEmptyString(lock.token, 512) || !nonEmptyString(lock.file) || lock.file !== expectedFile) {
    return { ok: false, code: 'LOCK_FAILED', error: 'pre-acquired handoff lock identity is invalid' };
  }
  try {
    const record = JSON.parse(readFileSync(join(lock.file, 'owner.json'), 'utf8'));
    return record?.token === lock.token
      ? lock
      : { ok: false, code: 'LOCK_FAILED', error: 'pre-acquired handoff lock ownership changed' };
  } catch (error) {
    return { ok: false, code: 'LOCK_FAILED', error: error?.message };
  }
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Date.now();
}

function classificationOf(observed) {
  const value = observed?.classification ?? observed?.kind ?? null;
  if (value === 'ready-target' || value === 'current-ready') return 'target-ready';
  if (value === 'starting-target') return 'target-starting';
  return value;
}

function hookFailure(code, phase, result, fallback) {
  return {
    ok: false,
    code,
    phase,
    error: result?.error ?? fallback,
    detail: result?.detail ?? null,
  };
}

async function invokeHook(hooks, name, payload, phase) {
  if (typeof hooks?.[name] !== 'function') {
    return { ok: false, code: 'SUPERVISOR_HANDOFF_HOOK_MISSING', phase, error: `required hook ${name} is unavailable` };
  }
  try {
    return await hooks[name](payload);
  } catch (error) {
    return { ok: false, code: 'SUPERVISOR_HANDOFF_HOOK_FAILED', phase, hook: name, error: error?.message ?? String(error) };
  }
}

function exactWatcherVerified(result, expected) {
  if (result?.ok !== true) return false;
  const reported = result.watcher ?? result.identity ?? null;
  return sameWatcher(reported, expected);
}

function portIsFree(result) {
  return result === true || (result?.ok === true && result.free === true);
}

function receiptIdentity(result) {
  return {
    lease: result?.lease ?? result?.detail?.lease ?? null,
    runtime_id: result?.runtime_id
      ?? result?.detail?.runtime_id
      ?? result?.detail?.stopped_runtime_id
      ?? null,
  };
}

function matchingMaintenanceReceipt(result, journal, allowedStates) {
  if (result?.ok !== true || !allowedStates.has(result.state)) return false;
  const identity = receiptIdentity(result);
  return identity.lease === journal.lease && identity.runtime_id === journal.runtime_id;
}

function targetWatcherFrom(observed, target) {
  const watcher = observed?.watcher ?? observed?.identity ?? null;
  if (!validWatcher(watcher)) return null;
  if (normalizedHash(watcher.helper_hash) !== normalizedHash(target.helper_hash)) return null;
  return normalizedWatcher(watcher);
}

function readyContract(result, target, priorRuntimeId) {
  if (result?.ok !== true) return null;
  const watcher = targetWatcherFrom(result, target);
  const runtime = result.runtime ?? result;
  if (!watcher || !nonEmptyString(runtime?.runtime_id, 2_048)) return null;
  if (priorRuntimeId !== null && runtime.runtime_id === priorRuntimeId) return null;
  if (runtime.execution_plane !== undefined && runtime.execution_plane !== 'hub-3210') return null;
  if (runtime.listen_port !== undefined && runtime.listen_port !== 3210) return null;
  return { watcher, runtime_id: runtime.runtime_id };
}

function normalizedJournal(journal) {
  return {
    schema_version: WINDOWS_SUPERVISOR_HANDOFF_SCHEMA,
    handoff_id: journal.handoff_id,
    phase: journal.phase,
    lease: journal.lease,
    runtime_id: journal.runtime_id,
    old: journal.old === null ? null : normalizedWatcher(journal.old),
    target: normalizedTarget(journal.target),
    updated_at: journal.updated_at,
  };
}

/**
 * Crash-resumable orchestration for replacing a legacy Windows Crew watcher.
 * Every process/network action is injected. This module owns only the durable
 * journal, exact-identity checks around hook results, and phase progression.
 */
export async function runWindowsSupervisorHandoff({
  appRoot,
  journalFile,
  target,
  hooks = {},
  now = Date.now,
  createHandoffId = randomUUID,
  createLease = randomUUID,
  preAcquiredLock = null,
  forceRestart = false,
} = {}) {
  if (!validTarget(target)) {
    return { ok: false, code: 'SUPERVISOR_HANDOFF_TARGET_INVALID', error: 'target helper/control path and hash identity is incomplete' };
  }

  let file;
  try {
    file = journalFileFor({ appRoot, journalFile });
  } catch (error) {
    return { ok: false, code: 'SUPERVISOR_HANDOFF_JOURNAL_PATH_INVALID', error: error.message };
  }

  const acquire = preAcquiredLock
    ? validatePreAcquiredLock(preAcquiredLock, file)
    : typeof hooks.acquireLock === 'function'
      ? await invokeHook(hooks, 'acquireLock', { appRoot, journalFile: file }, 'lock')
      : defaultAcquireLock({ journalFile: file, now: timestamp(now) });
  if (acquire?.ok !== true) {
    return {
      ok: false,
      code: acquire?.code === 'LOCK_HELD' ? 'SUPERVISOR_HANDOFF_BUSY' : 'SUPERVISOR_HANDOFF_LOCK_FAILED',
      error: acquire?.error ?? 'another supervisor handoff owns the lock',
    };
  }

  const release = async () => {
    if (!preAcquiredLock && typeof hooks.releaseLock === 'function') {
      try { await hooks.releaseLock({ appRoot, journalFile: file, lock: acquire }); } catch { /* result already decided */ }
    } else {
      defaultReleaseLock({ lock: acquire });
    }
  };

  try {
    const stored = readWindowsSupervisorHandoffJournal({ appRoot, journalFile: file });
    if (!stored.ok) return stored;

    let current = stored.journal ? normalizedJournal(stored.journal) : null;
    let plannedWatcherAlreadyVerified = false;
    let finalReady = null;
    let fresh = current?.old === null;

    if (current && !sameTarget(current.target, target)) {
      return {
        ok: false,
        code: 'SUPERVISOR_HANDOFF_JOURNAL_IDENTITY_MISMATCH',
        phase: current.phase,
        error: 'durable handoff targets a different helper path or hash',
      };
    }

    const persist = (phase) => {
      current = normalizedJournal({ ...current, phase, updated_at: timestamp(now) });
      const written = writeWindowsSupervisorHandoffJournal({ appRoot, journalFile: file, journal: current });
      if (!written.ok) return written;
      current = normalizedJournal(written.journal);
      return { ok: true };
    };

    if (!current) {
      const observed = await invokeHook(hooks, 'classifyHeartbeat', { target: normalizedTarget(target) }, 'observe');
      if (observed?.ok !== true) {
        return hookFailure(observed?.code ?? 'SUPERVISOR_HANDOFF_HEARTBEAT_UNAVAILABLE', 'observe', observed, 'heartbeat classification failed');
      }
      let classification = classificationOf(observed);

      if (classification === 'target-ready') {
        const watcher = targetWatcherFrom(observed, target);
        if (!watcher || !nonEmptyString(observed.runtime_id, 2_048)) {
          return hookFailure('SUPERVISOR_HANDOFF_TARGET_IDENTITY_MISMATCH', 'observe', observed, 'ready watcher does not match the target helper identity');
        }
        const ready = await invokeHook(hooks, 'verifyReady', {
          handoff_id: null,
          target: normalizedTarget(target),
          previous_runtime_id: null,
        }, 'observe');
        const verified = readyContract(ready, target, null);
        if (verified && !forceRestart) {
          return { ok: true, state: 'VERIFIED', idempotent: true, runtime_id: verified.runtime_id, watcher: verified.watcher };
        }
        // The watcher/control generation is current but the owned 3210 may
        // still be running the previously activated payload. Reuse the exact
        // durable handoff transaction to stop/restart that runtime instead of
        // treating a safe, recoverable version skew as terminal.
        classification = 'stale';
      }

      if (classification === 'legacy' || classification === 'stale') {
        if (!validWatcher(observed.watcher) || !nonEmptyString(observed.runtime_id, 2_048)) {
          return hookFailure('SUPERVISOR_HANDOFF_OLD_WATCHER_MALFORMED', 'observe', observed, 'legacy watcher identity is incomplete');
        }
        const old = normalizedWatcher(observed.watcher);
        const exact = await invokeHook(hooks, 'verifyExactWatcher', { expected: old, role: 'old' }, 'observe');
        if (!exactWatcherVerified(exact, old)) {
          return hookFailure('SUPERVISOR_HANDOFF_OLD_WATCHER_MISMATCH', 'observe', exact, 'legacy watcher PID/start/hash could not be proven');
        }
        current = {
          schema_version: WINDOWS_SUPERVISOR_HANDOFF_SCHEMA,
          handoff_id: createHandoffId(),
          phase: 'planned',
          lease: createLease(),
          runtime_id: observed.runtime_id,
          old,
          target: normalizedTarget(target),
          updated_at: timestamp(now),
        };
        if (!validateJournal(current)) {
          return { ok: false, code: 'SUPERVISOR_HANDOFF_PLAN_INVALID', error: 'generated handoff plan is invalid' };
        }
        const written = writeWindowsSupervisorHandoffJournal({ appRoot, journalFile: file, journal: current });
        if (!written.ok) return written;
        current = normalizedJournal(written.journal);
        plannedWatcherAlreadyVerified = true;
      } else if (classification === 'absent') {
        const free = await invokeHook(hooks, 'verifyPortFree', { port: 3210 }, 'absent');
        if (!portIsFree(free)) {
          return hookFailure('SUPERVISOR_HANDOFF_PORT_NOT_FREE', 'absent', free, 'watcher is absent but port 3210 is not provably free');
        }
        fresh = true;
        current = {
          schema_version: WINDOWS_SUPERVISOR_HANDOFF_SCHEMA,
          handoff_id: createHandoffId(),
          phase: 'old-watcher-stopped',
          lease: createLease(),
          runtime_id: null,
          old: null,
          target: normalizedTarget(target),
          updated_at: timestamp(now),
        };
        const written = writeWindowsSupervisorHandoffJournal({ appRoot, journalFile: file, journal: current });
        if (!written.ok) return written;
        current = normalizedJournal(written.journal);
      } else {
        return hookFailure('SUPERVISOR_HANDOFF_HEARTBEAT_CONFLICT', 'observe', observed, `unsupported heartbeat classification: ${classification ?? 'missing'}`);
      }
    }

    for (let transitions = 0; transitions < 6; transitions += 1) {
      if (current.phase === 'verified') {
        const cleared = clearWindowsSupervisorHandoffJournal({ appRoot, journalFile: file, handoffId: current.handoff_id });
        if (!cleared.ok) return cleared;
        return {
          ok: true,
          state: 'VERIFIED',
          handoff_id: current.handoff_id,
          resumed: stored.state === 'present',
          ...(fresh ? { fresh: true } : {}),
          ...(finalReady ? { runtime_id: finalReady.runtime_id, watcher: finalReady.watcher } : {}),
        };
      }

      if (current.phase === 'planned') {
        if (!plannedWatcherAlreadyVerified) {
          const exact = await invokeHook(hooks, 'verifyExactWatcher', { expected: current.old, role: 'old' }, current.phase);
          if (!exactWatcherVerified(exact, current.old)) {
            if (exact?.code === 'PROCESS_NOT_FOUND') {
              const observed = await invokeHook(hooks, 'classifyHeartbeat', { target: current.target }, current.phase);
              if (observed?.ok !== true) {
                return hookFailure(observed?.code ?? 'SUPERVISOR_HANDOFF_HEARTBEAT_UNAVAILABLE', current.phase, observed, 'old watcher disappeared and replacement state is unavailable');
              }
              const classification = classificationOf(observed);
              if (classification === 'target-ready') {
                const ready = await invokeHook(hooks, 'verifyReady', {
                  handoff_id: current.handoff_id,
                  target: current.target,
                  previous_runtime_id: current.runtime_id,
                }, current.phase);
                finalReady = readyContract(ready, current.target, current.runtime_id);
                if (!finalReady) {
                  return hookFailure('SUPERVISOR_HANDOFF_READY_VERIFY_FAILED', current.phase, ready, 'replacement target watcher/runtime did not pass the strict contract');
                }
                const verified = persist('verified');
                if (!verified.ok) return verified;
                continue;
              }
              if (classification === 'target-starting') {
                const targetWatcher = targetWatcherFrom(observed, current.target);
                const targetExact = targetWatcher
                  ? await invokeHook(hooks, 'verifyExactWatcher', { expected: targetWatcher, role: 'target' }, current.phase)
                  : null;
                if (!targetWatcher || !exactWatcherVerified(targetExact, targetWatcher)) {
                  return hookFailure('SUPERVISOR_HANDOFF_TARGET_IDENTITY_MISMATCH', current.phase, targetExact ?? observed, 'replacement target watcher identity is not exact');
                }
                const launched = persist('new-watcher-started');
                if (!launched.ok) return launched;
                continue;
              }
              if (classification === 'absent') {
                const free = await invokeHook(hooks, 'verifyPortFree', { port: 3210 }, current.phase);
                if (!portIsFree(free)) {
                  return hookFailure('SUPERVISOR_HANDOFF_PORT_NOT_FREE', current.phase, free, 'old watcher is absent but port 3210 is not provably free');
                }
                const maintenance = await invokeHook(hooks, 'maintenanceStatus', {
                  lease: current.lease,
                  runtime_id: current.runtime_id,
                }, current.phase);
                if (maintenance?.ok !== true) {
                  return hookFailure(maintenance?.code ?? 'SUPERVISOR_HANDOFF_MAINTENANCE_STATUS_FAILED', current.phase, maintenance, 'maintenance session state is unavailable');
                }
                if (maintenance.state === 'matching'
                  && receiptIdentity(maintenance).lease === current.lease
                  && receiptIdentity(maintenance).runtime_id === current.runtime_id) {
                  const stopped = persist('backend-stopped');
                  if (!stopped.ok) return stopped;
                  continue;
                }
                if (maintenance.state === 'absent') {
                  current = normalizedJournal({
                    ...current,
                    lease: createLease(),
                    runtime_id: null,
                    old: null,
                    updated_at: timestamp(now),
                  });
                  fresh = true;
                  const absent = persist('old-watcher-stopped');
                  if (!absent.ok) return absent;
                  continue;
                }
                return hookFailure('SUPERVISOR_HANDOFF_MAINTENANCE_CONFLICT', current.phase, maintenance, 'an unrelated maintenance session owns the stopped window');
              }
            }
            return hookFailure('SUPERVISOR_HANDOFF_OLD_WATCHER_MISMATCH', current.phase, exact, 'planned legacy watcher is no longer exact');
          }
        }
        plannedWatcherAlreadyVerified = false;
        const stopped = await invokeHook(hooks, 'maintenanceStop', {
          handoff_id: current.handoff_id,
          lease: current.lease,
          runtime_id: current.runtime_id,
          old: current.old,
          target: current.target,
        }, current.phase);
        if (!matchingMaintenanceReceipt(stopped, current, new Set(['STOPPED']))) {
          if (stopped?.code === 'MAINTENANCE_IDENTITY_CHANGED') {
            const rebound = await invokeHook(hooks, 'classifyHeartbeat', { target: current.target }, current.phase);
            const classification = classificationOf(rebound);
            const reboundWatcher = rebound?.watcher ?? rebound?.identity ?? null;
            if (rebound?.ok === true
              && ['legacy', 'stale', 'target-ready'].includes(classification)
              && sameWatcher(reboundWatcher, current.old)
              && nonEmptyString(rebound.runtime_id, 2_048)
              && rebound.runtime_id !== current.runtime_id) {
              current = normalizedJournal({
                ...current,
                lease: createLease(),
                runtime_id: rebound.runtime_id,
                updated_at: timestamp(now),
              });
              const reboundPersisted = writeWindowsSupervisorHandoffJournal({ appRoot, journalFile: file, journal: current });
              if (!reboundPersisted.ok) return reboundPersisted;
              current = normalizedJournal(reboundPersisted.journal);
              continue;
            }
          }
          return hookFailure('SUPERVISOR_HANDOFF_STOP_RECEIPT_MISMATCH', current.phase, stopped, 'maintenance stop did not return the durable lease/runtime identity');
        }
        const free = await invokeHook(hooks, 'verifyPortFree', { port: 3210 }, current.phase);
        if (!portIsFree(free)) {
          return hookFailure('SUPERVISOR_HANDOFF_PORT_NOT_FREE', current.phase, free, 'maintenance stop did not leave port 3210 provably free');
        }
        const persisted = persist('backend-stopped');
        if (!persisted.ok) return persisted;
        continue;
      }

      if (current.phase === 'backend-stopped') {
        const exact = await invokeHook(hooks, 'verifyExactWatcher', { expected: current.old, role: 'old' }, current.phase);
        if (!exactWatcherVerified(exact, current.old)) {
          if (exact?.code === 'PROCESS_NOT_FOUND') {
            const free = await invokeHook(hooks, 'verifyPortFree', { port: 3210 }, current.phase);
            if (portIsFree(free)) {
              const persisted = persist('old-watcher-stopped');
              if (!persisted.ok) return persisted;
              continue;
            }
          }
          return hookFailure('SUPERVISOR_HANDOFF_OLD_WATCHER_MISMATCH', current.phase, exact, 'backend is stopped but watcher identity changed');
        }
        const stopped = await invokeHook(hooks, 'stopExactWatcher', { expected: current.old }, current.phase);
        if (stopped?.ok !== true || !sameWatcher(stopped.watcher, current.old)) {
          return hookFailure('SUPERVISOR_HANDOFF_WATCHER_STOP_FAILED', current.phase, stopped, 'exact legacy watcher was not stopped');
        }
        const persisted = persist('old-watcher-stopped');
        if (!persisted.ok) return persisted;
        continue;
      }

      if (current.phase === 'old-watcher-stopped') {
        const observed = await invokeHook(hooks, 'classifyHeartbeat', { target: current.target }, current.phase);
        if (observed?.ok !== true) {
          return hookFailure(observed?.code ?? 'SUPERVISOR_HANDOFF_HEARTBEAT_UNAVAILABLE', current.phase, observed, 'could not classify watcher after legacy stop');
        }
        const classification = classificationOf(observed);
        if (classification === 'absent') {
          const free = await invokeHook(hooks, 'verifyPortFree', { port: 3210 }, current.phase);
          if (!portIsFree(free)) {
            return hookFailure('SUPERVISOR_HANDOFF_PORT_NOT_FREE', current.phase, free, 'target launch requires a provably free port');
          }
          const launched = await invokeHook(hooks, 'launchTargetWatcher', { target: current.target }, current.phase);
          if (launched?.ok !== true || !targetWatcherFrom(launched, current.target)) {
            return hookFailure('SUPERVISOR_HANDOFF_TARGET_LAUNCH_FAILED', current.phase, launched, 'launched watcher does not match the target helper hash');
          }
        } else if ((classification === 'target-starting' || classification === 'target-ready') && targetWatcherFrom(observed, current.target)) {
          // A crash may happen after launch but before the phase write. The
          // exact target heartbeat is sufficient to advance without spawning
          // a second watcher.
        } else {
          return hookFailure('SUPERVISOR_HANDOFF_WATCHER_CONFLICT', current.phase, observed, 'an unexpected watcher owns the supervisor slot');
        }
        const persisted = persist('new-watcher-started');
        if (!persisted.ok) return persisted;
        continue;
      }

      if (current.phase === 'new-watcher-started') {
        const observed = await invokeHook(hooks, 'classifyHeartbeat', { target: current.target, expect_target: true }, current.phase);
        if (observed?.ok !== true) {
          return hookFailure(observed?.code ?? 'SUPERVISOR_HANDOFF_HEARTBEAT_UNAVAILABLE', current.phase, observed, 'target watcher heartbeat is unavailable');
        }
        const classification = classificationOf(observed);
        const watcher = targetWatcherFrom(observed, current.target);
        if (!watcher || (classification !== 'target-starting' && classification !== 'target-ready')) {
          return hookFailure('SUPERVISOR_HANDOFF_TARGET_IDENTITY_MISMATCH', current.phase, observed, 'new watcher heartbeat does not match the target helper');
        }
        const exact = await invokeHook(hooks, 'verifyExactWatcher', { expected: watcher, role: 'target' }, current.phase);
        if (!exactWatcherVerified(exact, watcher)) {
          return hookFailure('SUPERVISOR_HANDOFF_TARGET_IDENTITY_MISMATCH', current.phase, exact, 'target watcher PID/start/hash could not be proven');
        }

        if (current.old !== null && classification !== 'target-ready') {
          const started = await invokeHook(hooks, 'maintenanceStart', {
            handoff_id: current.handoff_id,
            lease: current.lease,
            runtime_id: current.runtime_id,
            target: current.target,
          }, current.phase);
          if (!matchingMaintenanceReceipt(started, current, new Set(['STARTED', 'VERIFIED']))) {
            return hookFailure('SUPERVISOR_HANDOFF_START_RECEIPT_MISMATCH', current.phase, started, 'maintenance start did not preserve the durable lease/runtime identity');
          }
        }

        const ready = await invokeHook(hooks, 'verifyReady', {
          handoff_id: current.handoff_id,
          target: current.target,
          previous_runtime_id: current.runtime_id,
        }, current.phase);
        finalReady = readyContract(ready, current.target, current.runtime_id);
        if (!finalReady) {
          return hookFailure('SUPERVISOR_HANDOFF_READY_VERIFY_FAILED', current.phase, ready, 'target watcher/runtime readiness contract did not verify');
        }
        const persisted = persist('verified');
        if (!persisted.ok) return persisted;
        continue;
      }

      return { ok: false, code: 'SUPERVISOR_HANDOFF_JOURNAL_MALFORMED', phase: current.phase, error: 'unknown durable phase' };
    }

    return { ok: false, code: 'SUPERVISOR_HANDOFF_TRANSITION_LIMIT', phase: current.phase, error: 'handoff did not converge' };
  } finally {
    await release();
  }
}
