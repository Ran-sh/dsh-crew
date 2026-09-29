// Bound the Crew diagnostics that accumulate in %TEMP%: every hub start writes a
// new dsh-crew-dsh-crew-3210-<stamp>.out/.err.log pair, every desktop launch a
// dsh-crew-web-*, every official launch a dsh-official-web-*, and the launcher
// appends to dsh-crew-launcher.log forever. They are the only post-mortem evidence
// for a crash-before-readiness, so the rule keeps the most recent runs instead of
// deleting everything: per family, the newest `keep` runs survive, plus anything
// written within the recency guard (a running process owns its own log files).

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const DEFAULT_KEEP_RUNS = 20;
export const DEFAULT_MAX_AGE_DAYS = 14;
const RECENT_GUARD_MS = 5 * 60 * 1000;

const LOG_FAMILIES = [
  { prefix: 'dsh-crew-dsh-crew-3210-', suffix: '.out.log' },
  { prefix: 'dsh-crew-web-', suffix: '.out.log' },
  { prefix: 'dsh-official-web-', suffix: '.out.log' },
];

// `dsh-crew-<profile>-<port>-<stamp>.out.log` -> the stamp identifies one run, and
// its .err.log sibling must live or die with it.
function runStamp(fileName, family) {
  if (!fileName.startsWith(family.prefix) || !fileName.endsWith(family.suffix)) return null;
  const stamp = fileName.slice(family.prefix.length, fileName.length - family.suffix.length);
  return stamp || null;
}

export function pruneCrewTempLogs({ tempDir = tmpdir(), keepRuns = DEFAULT_KEEP_RUNS, maxAgeDays = DEFAULT_MAX_AGE_DAYS, now = Date.now() } = {}) {
  const keep = Number.isInteger(keepRuns) && keepRuns > 0 ? keepRuns : DEFAULT_KEEP_RUNS;
  const maxAgeMs = Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays * 24 * 60 * 60 * 1000 : DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let names;
  try { names = readdirSync(tempDir); } catch { return { ok: true, removed: [], kept: [], skipped: 'unreadable' }; }

  const removed = [];
  const kept = [];
  for (const family of LOG_FAMILIES) {
    const runs = new Map();
    for (const name of names) {
      const stamp = runStamp(name, family);
      if (!stamp) continue;
      const file = join(tempDir, name);
      let mtimeMs = 0;
      try { mtimeMs = statSync(file).mtimeMs; } catch { continue; }
      const run = runs.get(stamp) ?? { stamp, files: [], newest: 0 };
      run.files.push(name);
      run.newest = Math.max(run.newest, mtimeMs);
      runs.set(stamp, run);
    }
    const ordered = [...runs.values()].sort((left, right) => right.newest - left.newest);
    ordered.forEach((run, index) => {
      const tooOld = now - run.newest > maxAgeMs;
      const tooMany = index >= keep;
      const tooRecentToTouch = now - run.newest < RECENT_GUARD_MS;
      if ((tooOld || tooMany) && !tooRecentToTouch) {
        for (const name of run.files) removed.push(name);
        const errName = run.files[0].replace(/\.out\.log$/, '.err.log');
        if (names.includes(errName)) removed.push(errName);
      } else {
        kept.push(run.stamp);
      }
    });
  }
  for (const name of removed) {
    try { rmSync(join(tempDir, name), { force: true }); } catch { /* a locked file stays until the next pass */ }
  }
  return { ok: true, removed: [...new Set(removed)].sort(), kept: kept.sort() };
}
