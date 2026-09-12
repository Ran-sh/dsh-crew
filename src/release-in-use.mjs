// Release liveness claims.
//
// A running Hub keeps executing the release it was started from, but it loads
// several modules lazily with a cache-busting query (`import('...?t=' + Date.now())`)
// so that a config edit is visible without a restart. Those lazy reads go to
// disk every time, which means deleting the release under a live process breaks
// it permanently: the routes that were already loaded keep working while
// everything behind a lazy import answers 500.
//
// Release retention keeps only the newest few, and it protected the *current*
// pointer — not the one a running process is actually executing. So a machine
// could be left with a Hub whose config routes were dead, and an update would
// not repair it because the damage is to the process, not the files.
//
// A process therefore records that it is using a release. Retention skips any
// release with a live claim. Liveness is decided by the pid, not by the file, so
// a process that dies without cleaning up cannot pin a release forever.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IN_USE_DIRNAME = 'in-use';

export function releaseInUseDir({ home = homedir() } = {}) {
  return join(home, '.config', 'dsh-crew', 'app', IN_USE_DIRNAME);
}

/** The release root that owns `moduleUrl`, or null when it is outside one. */
export function releaseRootFor(moduleUrl) {
  let path;
  try { path = fileURLToPath(moduleUrl); } catch { return null; }
  // <release>/src/<...> or <release>/src/hub/entry.mjs → walk up to the release root.
  let dir = dirname(path);
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(dir, 'package.json'))) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (pkg?.name === '@ran-sh/dsh-crew') return resolve(dir);
      } catch { /* not the payload manifest; keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/**
 * Record that this process is running `releasePath`. Best effort: failing to
 * claim must never stop the Hub from starting.
 *
 * A null return is a real degradation, not a footnote. Retention cannot see a
 * release that was never claimed, so an unclaimable release is one that a later
 * update may delete from under this process — the 500-answering routes this
 * module exists to prevent. Callers should surface it; `releaseClaimsState`
 * gives retention the matching fail-closed signal.
 */
export function claimReleaseInUse({ moduleUrl = import.meta.url, releasePath, home = homedir(), pid = process.pid, now = Date.now() } = {}) {
  try {
    const target = releasePath ?? releaseRootFor(moduleUrl);
    if (!target) return null;
    const dir = releaseInUseDir({ home });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${pid}.json`);
    writeFileSync(file, JSON.stringify({ pid, release: resolve(target), claimed_at: now }) + '\n');
    return file;
  } catch { return null; }
}

export function releaseClaimFile({ home = homedir(), pid = process.pid } = {}) {
  return join(releaseInUseDir({ home }), `${pid}.json`);
}

export function releaseClaimInUse({ home = homedir(), pid = process.pid } = {}) {
  const file = releaseClaimFile({ home, pid });
  return existsSync(file) || false;
}

export function clearReleaseClaim({ home = homedir(), pid = process.pid } = {}) {
  try { rmSync(releaseClaimFile({ home, pid }), { force: true }); return true; } catch { return false; }
}

/**
 * Releases currently held by a live process, plus whether that answer is
 * trustworthy.
 *
 * `reliable: false` means the claim directory could not be read, so an empty
 * `live` list is not evidence that nothing is running. A caller that deletes
 * releases must treat unknown as "do not delete": reading an unreadable claim
 * directory as "no claims" is exactly how a release disappears from under a
 * running Hub, and the damage is to the process, not to the files.
 *
 * Dead claims are removed as they are encountered, so the directory cannot
 * accumulate stale files.
 */
export function releaseClaimsState({ home = homedir(), alive = isAlive } = {}) {
  const dir = releaseInUseDir({ home });
  let names;
  try { names = readdirSync(dir); } catch (error) {
    // A directory that does not exist yet reliably holds no claims; any other
    // failure — permissions, a file where the directory should be — does not.
    if (error?.code === 'ENOENT') return { live: [], reliable: true };
    return { live: [], reliable: false, error: String(error?.message ?? error) };
  }
  const live = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    let record;
    try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { record = null; }
    if (record && Number.isInteger(record.pid) && typeof record.release === 'string' && alive(record.pid)) {
      live.push(resolve(record.release));
      continue;
    }
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
  }
  return { live: [...new Set(live)], reliable: true };
}

/** Releases currently held by a live process. See `releaseClaimsState`. */
export function liveReleaseClaims(opts = {}) {
  return releaseClaimsState(opts).live;
}
