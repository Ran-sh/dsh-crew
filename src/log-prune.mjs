// Bound the Crew diagnostics that accumulate in %TEMP%: every hub start writes a
// new dsh-crew-dsh-crew-3210-<stamp>.out/.err.log pair, every desktop launch a
// dsh-crew-web-*, every official launch a dsh-official-web-*, and the launcher
// appends to dsh-crew-launcher.log forever. They are the only post-mortem evidence
// for a crash-before-readiness, so the rule bounds them instead of deleting them all.
// A run survives when it is BOTH within its family's newest `keep` AND younger than
// the age bound; exceeding either one removes it, unless it was written within the
// recency guard (a running process owns its own log files). The newest `keep` runs
// therefore do not survive unconditionally — only a run that is also inside the age
// bound does, which is what keeps a burst of starts from filling the directory.

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const DEFAULT_KEEP_RUNS = 10;
export const DEFAULT_MAX_AGE_DAYS = 14;
const RECENT_GUARD_MS = 5 * 60 * 1000;

// Per family. The hub-start pairs are what a crash-before-readiness leaves behind,
// and ten of them are the post-mortem window the policy names; the frontend families
// are launched far less often and keep the retention they already had, so one
// family's bound is not silently imposed on the others. An explicit `keepRuns`
// still applies to every family: that is an operator stating how many runs to keep.
const LOG_FAMILIES = [
  { prefix: 'dsh-crew-dsh-crew-3210-', suffix: '.out.log', keep: 10 },
  { prefix: 'dsh-crew-web-', suffix: '.out.log', keep: 20 },
  { prefix: 'dsh-official-web-', suffix: '.out.log', keep: 20 },
].map((family) => ({
  ...family,
  // An `.err.log` whose `.out.log` sibling is gone (or was never written) is still a
  // Crew diagnostic, so each family recognizes its error files as prunable runs too.
  errStamp: (name) => name.startsWith(family.prefix) && name.endsWith('.err.log')
    ? name.slice(family.prefix.length, name.length - '.err.log'.length) || null
    : null,
}));

// `dsh-crew-<profile>-<port>-<stamp>.out.log` -> the stamp identifies one run, and
// its .err.log sibling must live or die with it.
function runStamp(fileName, family) {
  if (!fileName.startsWith(family.prefix) || !fileName.endsWith(family.suffix)) return null;
  const stamp = fileName.slice(family.prefix.length, fileName.length - family.suffix.length);
  return stamp || null;
}

export function pruneCrewTempLogs({ tempDir = tmpdir(), keepRuns = null, maxAgeDays = DEFAULT_MAX_AGE_DAYS, now = Date.now() } = {}) {
  // `keepRuns` is an explicit operator override for every family; without one each
  // family uses its own bound, so the default is "nothing was asked for" rather than
  // a number that would flatten them all to the hub's ten.
  const keepOverride = Number.isInteger(keepRuns) && keepRuns > 0 ? keepRuns : null;
  const maxAgeMs = Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays * 24 * 60 * 60 * 1000 : DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let names;
  try { names = readdirSync(tempDir); } catch { return { ok: true, removed: [], kept: [], skipped: 'unreadable' }; }

  const removed = [];
  const kept = [];
  for (const family of LOG_FAMILIES) {
    const runs = new Map();
    for (const name of names) {
      const stamp = runStamp(name, family);
      if (stamp) {
        const file = join(tempDir, name);
        let mtimeMs = 0;
        try { mtimeMs = statSync(file).mtimeMs; } catch { continue; }
        const run = runs.get(stamp) ?? { stamp, files: [], newest: 0 };
        run.files.push(name);
        run.newest = Math.max(run.newest, mtimeMs);
        runs.set(stamp, run);
        continue;
      }
      // An orphan `.err.log` (its `.out.log` sibling already pruned or never written)
      // is still a Crew diagnostic: prune it on its own stamp so a half-written run
      // cannot outlive every bound.
      const errStamp = family.errStamp(name);
      if (!errStamp) continue;
      const file = join(tempDir, name);
      let mtimeMs = 0;
      try { mtimeMs = statSync(file).mtimeMs; } catch { continue; }
      const run = runs.get(errStamp) ?? { stamp: errStamp, files: [], newest: 0 };
      run.files.push(name);
      run.newest = Math.max(run.newest, mtimeMs);
      runs.set(errStamp, run);
    }
    const ordered = [...runs.values()].sort((left, right) => right.newest - left.newest);
    const keep = keepOverride ?? family.keep;
    ordered.forEach((run, index) => {
      const tooOld = now - run.newest > maxAgeMs;
      const tooMany = index >= keep;
      const tooRecentToTouch = now - run.newest < RECENT_GUARD_MS;
      // Delete when EITHER bound is exceeded. The newest `keep` runs are what an
      // operator reads, and past that a run beyond the age bound is gone regardless
      // of its rank: keeping an eleventh run merely because it is only hours old
      // would let a burst of starts grow without bound, which is the growth this
      // bound exists to stop. A burst of eleven young runs still keeps ten.
      if ((tooOld || tooMany) && !tooRecentToTouch) {
        for (const name of run.files) removed.push(name);
      } else {
        kept.push(run.stamp);
      }
    });
  }
  // `removed` lists what is actually gone. A locked file (Windows holds a log open
  // while its process runs) is reported in `failed` instead of pretending a deletion
  // happened: the next pass tries again, and the operator is not told a number that
  // is not true.
  const failed = [];
  for (const name of [...new Set(removed)]) {
    try { rmSync(join(tempDir, name), { force: true }); } catch { failed.push(name); }
  }
  return {
    ok: failed.length === 0 ? true : 'partial',
    removed: removed.filter((name) => !failed.includes(name)).sort(),
    kept: kept.sort(),
    ...(failed.length ? { failed: failed.sort() } : {}),
  };
}
