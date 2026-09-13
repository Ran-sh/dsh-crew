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

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IN_USE_DIRNAME = 'in-use';

// A claim file is `<pid>.json` or `<pid>-<nonce>.json`. The PID alone is not
// enough to identify a claim: two mounts inside one process would publish to the
// same pathname, and whichever disposed first would remove the other's
// protection. A claim is owned by the mount that wrote it, so it needs a name
// that says which one that was.
const CLAIM_NAME_RE = /^(\d+)(?:-[0-9a-f]+)?\.json$/;

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
    // The nonce makes this claim the property of this call. Clearing by PID would
    // let one mount remove a sibling mount's only protection.
    const nonce = randomBytes(8).toString('hex');
    const file = join(dir, `${pid}-${nonce}.json`);
    // Write then rename: a reader that lists the directory can otherwise see this
    // filename while its JSON is still empty or half-written, and an unparseable
    // claim is indistinguishable from a dead one.
    const pending = `${file}.tmp`;
    writeFileSync(pending, JSON.stringify({ pid, nonce, release: resolve(target), claimed_at: now }) + '\n');
    renameSync(pending, file);
    return file;
  } catch { return null; }
}

/** The unbranded per-PID claim path, as written by releases before claims were per-mount. */
export function releaseClaimFile({ home = homedir(), pid = process.pid } = {}) {
  return join(releaseInUseDir({ home }), `${pid}.json`);
}

export function releaseClaimInUse({ home = homedir(), pid = process.pid } = {}) {
  let names;
  try { names = readdirSync(releaseInUseDir({ home })); } catch { return false; }
  return names.some((name) => CLAIM_NAME_RE.exec(name)?.[1] === String(pid));
}

/**
 * Remove the claim whose handle `claimReleaseInUse` returned.
 *
 * A missing handle is not permission to remove something: without one there is
 * no way to know which claim this caller owns, and guessing by PID can remove a
 * sibling mount's protection. Legacy unbranded claims are removed by
 * `clearLegacyReleaseClaim`, which says so in its name.
 */
export function clearReleaseClaim({ file = null } = {}) {
  if (!file) return false;
  try { rmSync(file, { force: true }); return true; } catch { return false; }
}

/**
 * Remove the unbranded `<pid>.json` claim written by releases before claims were
 * per-mount. Separate from `clearReleaseClaim` because it can take a claim this
 * caller did not write, and that should never happen by falling through a
 * missing argument.
 */
export function clearLegacyReleaseClaim({ home = homedir(), pid = process.pid } = {}) {
  try { rmSync(releaseClaimFile({ home, pid }), { force: true }); return true; } catch { return false; }
}

/**
 * Releases currently held by a live process, plus whether that answer is
 * trustworthy.
 *
 * `reliable: false` means liveness could not be determined, so an empty `live`
 * list is not evidence that nothing is running. A caller that deletes releases
 * must treat unknown as "do not delete": reading an unreadable claim directory
 * as "no claims" is exactly how a release disappears from under a running Hub,
 * and the damage is to the process, not to the files.
 *
 * Nothing is deleted here. A claim is only ever a protection, so a reaper that
 * unlinks one has to be certain the object it inspected is still the object it
 * is removing — and it cannot be, because the pathname outlives the claim and a
 * process restarting with a reused PID publishes a new file at the same one.
 * Checking liveness and then unlinking is a check-then-act over a name, and
 * losing that race deletes a live process's protection. Stale files therefore
 * stay; a Hub clears its own claim on a clean shutdown, and one file per
 * hard-killed process is not worth a race over a safety mechanism.
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
  let unknown = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    // The filename carries the PID, and the name is complete before any content
    // exists — so a torn write still says whose claim it was, which is what
    // keeps one old unusable file from disabling pruning forever.
    const pidFromName = CLAIM_NAME_RE.exec(name) ? Number.parseInt(name, 10) : null;

    let parsed = null;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { parsed = null; }

    const wellFormed = parsed && typeof parsed === 'object'
      && Number.isInteger(parsed.pid) && parsed.pid > 0
      && typeof parsed.release === 'string' && parsed.release !== ''
      && parsed.pid === pidFromName;

    if (wellFormed) {
      // A well-formed claim for a process that is gone simply protects nothing;
      // it is inert, not a reason to distrust the rest.
      if (alive(parsed.pid)) live.push(resolve(parsed.release));
      continue;
    }

    // Anything else is not evidence of a dead process. Syntax that happens to
    // parse is not a schema: `{}` and `{"pid":123}` say nothing about liveness.
    // The filename is the only identity left, and a claim whose named process is
    // positively gone is inert for the same reason.
    if (pidFromName !== null && !alive(pidFromName)) continue;
    // No usable PID, or the PID may still be running. A reused PID is
    // indistinguishable from the original here, so this stays unknown rather
    // than guessing; that is a fail-closed condition, not a resolved one.
    unknown ??= `unusable claim: ${file}`;
  }
  if (unknown) return { live: [...new Set(live)], reliable: false, error: unknown };
  return { live: [...new Set(live)], reliable: true };
}

/** Releases currently held by a live process. See `releaseClaimsState`. */
export function liveReleaseClaims(opts = {}) {
  return releaseClaimsState(opts).live;
}
