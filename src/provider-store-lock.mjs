// Persistent token-fenced lock shared by every lifecycle operation that can
// mutate the Harness profile/settings stores. A stale lock is reclaimed only
// while a serialized claim is held; malformed metadata fails closed.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

function safeToken(value) { return typeof value === 'string' && /^[A-Za-z0-9-]{16,128}$/u.test(value); }
function readOwner(file) {
  try {
    const owner = JSON.parse(readFileSync(file, 'utf8'));
    if (!owner || typeof owner !== 'object' || Array.isArray(owner) || !Number.isInteger(owner.pid) || owner.pid <= 0 || !safeToken(owner.token)) return { ok: false, malformed: true };
    return { ok: true, owner };
  } catch { return { ok: false, malformed: true }; }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

export async function acquireProviderStoreLock(file) {
  if (typeof file !== 'string' || !file.trim()) throw Object.assign(new Error('provider store lock path is required'), { code: 'PROVIDER_STORE_LOCK_UNAVAILABLE' });
  const lockFile = resolvePath(file);
  mkdirSync(dirname(lockFile), { recursive: true });
  const claimFile = `${lockFile}.claim`;
  const token = randomUUID();
  let claimed = false;
  try {
    try { mkdirSync(claimFile); claimed = true; }
    catch (error) { throw Object.assign(new Error('provider store lock is busy'), { code: error?.code === 'EEXIST' ? 'PROVIDER_STORE_LOCK_BUSY' : 'PROVIDER_STORE_LOCK_UNAVAILABLE' }); }
    while (true) {
      try {
        writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() }) + '\n', { flag: 'wx' });
        return {
          ok: true,
          token,
          release: async () => {
            const current = readOwner(lockFile);
            if (current.ok && current.owner.token === token) rmSync(lockFile, { force: true });
          },
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw Object.assign(new Error('provider store lock is unavailable'), { code: 'PROVIDER_STORE_LOCK_UNAVAILABLE' });
        const current = readOwner(lockFile);
        if (!current.ok) throw Object.assign(new Error('provider store lock metadata is invalid'), { code: 'PROVIDER_STORE_LOCK_BUSY' });
        if (processAlive(current.owner.pid)) throw Object.assign(new Error('provider store lock is busy'), { code: 'PROVIDER_STORE_LOCK_BUSY' });
        rmSync(lockFile, { force: true });
      }
    }
  } finally { if (claimed) rmSync(claimFile, { recursive: true, force: true }); }
}

export async function recoverProviderStoreLock(file, { confirm = false } = {}) {
  if (confirm !== true) return { ok: false, code: 'PROVIDER_STORE_LOCK_CONFIRM_REQUIRED' };
  if (typeof file !== 'string' || !file.trim()) return { ok: false, code: 'PROVIDER_STORE_LOCK_UNAVAILABLE' };
  const lockFile = resolvePath(file);
  const claimFile = `${lockFile}.claim`;
  try { mkdirSync(dirname(lockFile), { recursive: true }); mkdirSync(claimFile); }
  catch (error) { return { ok: false, code: error?.code === 'EEXIST' ? 'PROVIDER_STORE_LOCK_BUSY' : 'PROVIDER_STORE_LOCK_UNAVAILABLE' }; }
  try {
    if (!existsSync(lockFile)) return { ok: true, recovered: false };
    const current = readOwner(lockFile);
    if (current.ok && processAlive(current.owner.pid)) return { ok: false, code: 'PROVIDER_STORE_LOCK_BUSY' };
    rmSync(lockFile, { force: true });
    return { ok: true, recovered: true };
  } finally { rmSync(claimFile, { recursive: true, force: true }); }
}
