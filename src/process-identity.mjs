import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// A PID is not an identity. Windows and Linux both recycle them, so a lock
// record that carries only `pid` can describe a dead owner and a live stranger
// at the same time — and `process.kill(pid, 0)` cannot tell those apart, because
// the only question it answers is "does some process have this pid". That is
// precisely the question that made a stale lock look alive, so liveness needs a
// second field: the start time of the process. The Windows supervisor already
// proves its own identity with `StartTime.ToUniversalTime().Ticks`, and this is
// the same value read from Node.
//
// The probe is best-effort by construction. When the platform cannot answer,
// every caller falls back to its PID-only verdict rather than inventing one.

const cache = new Map();

export function processStartToken(pid, { probe = defaultProbe } = {}) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n < 1) return null;
  if (cache.has(n)) return cache.get(n);
  let token = null;
  try { token = probe(n); } catch { token = null; }
  if (typeof token !== 'string' || token === '') token = null;
  cache.set(n, token);
  return token;
}

export function resetProcessStartTokenCache() {
  cache.clear();
}

// 'same'      — the pid exists and it is provably still the recorded process.
// 'different' — the pid exists but belongs to a different process (recycled PID).
// 'unknown'   — no token on record, or the platform could not answer. Callers
//               must treat this as "cannot prove the owner is gone".
export function compareProcessToken(record, { probe = defaultProbe } = {}) {
  const recorded = record?.process_start_token ?? record?.processStartToken ?? null;
  if (typeof recorded !== 'string' || recorded === '') return 'unknown';
  const current = processStartToken(record?.pid, { probe });
  if (current === null) return 'unknown';
  return current === recorded ? 'same' : 'different';
}

function defaultProbe(pid) {
  if (process.platform === 'win32') return windowsStartToken(pid);
  if (process.platform === 'linux') return linuxStartToken(pid);
  return null;
}

function windowsStartToken(pid) {
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
  ], { timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const text = String(out ?? '').trim();
  return /^\d+$/.test(text) ? `win-ticks:${text}` : null;
}

// `/proc/<pid>/stat` field 22 (starttime) counts clock ticks since boot, so it
// is only unique *within* a boot. Pairing it with the boot id makes the token
// unique across reboots too, which matters because the lock file outlives them.
function linuxStartToken(pid) {
  let stat;
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const starttime = fields[19];
  if (!/^\d+$/.test(String(starttime ?? ''))) return null;
  let boot = '';
  try { boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { boot = ''; }
  return `linux-starttime:${boot}:${starttime}`;
}
