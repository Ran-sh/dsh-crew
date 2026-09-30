import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneCrewTempLogs } from '../src/log-prune.mjs';

// The %TEMP% diagnostics are the only post-mortem evidence for a hub that crashed
// before readiness, so pruning keeps the newest runs per family and never touches
// anything a live process may still be writing.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-log-prune-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeRun(dir, prefix, stamp, ageMs, now = Date.now()) {
  for (const suffix of ['.out.log', '.err.log']) {
    const file = join(dir, `${prefix}${stamp}${suffix}`);
    writeFileSync(file, `${stamp}${suffix}\n`);
    // utimesSync takes seconds since the epoch.
    const when = (now - ageMs) / 1000;
    utimesSync(file, when, when);
  }
}

test('keeps the newest runs per family and removes the rest with their err siblings', () => {
  const f = fixture();
  try {
    const now = Date.now();
    const minute = 60 * 1000;
    // Older than the recency guard, so the count bound is what decides.
    for (let index = 0; index < 6; index += 1) {
      writeRun(f.dir, 'dsh-crew-dsh-crew-3210-', `2026090${index}-000000000-${1000 + index}`, (6 - index) * 10 * minute, now);
    }
    writeRun(f.dir, 'dsh-crew-web-', '20260901-000000000-2000', 15 * minute, now);

    const result = pruneCrewTempLogs({ tempDir: f.dir, keepRuns: 3, now });
    assert.equal(result.ok, true);
    assert.equal(result.kept.length, 4, 'three hub runs plus the one frontend run');
    assert.ok(result.kept.includes('20260901-000000000-2000'), 'the single frontend run survives the count bound');
    assert.equal(existsSync(join(f.dir, 'dsh-crew-web-20260901-000000000-2000.out.log')), true);
    // The three oldest hub runs are gone, both halves each.
    for (const index of [0, 1, 2]) {
      const stamp = `2026090${index}-000000000-${1000 + index}`;
      assert.equal(existsSync(join(f.dir, `dsh-crew-dsh-crew-3210-${stamp}.out.log`)), false);
      assert.equal(existsSync(join(f.dir, `dsh-crew-dsh-crew-3210-${stamp}.err.log`)), false);
    }
  } finally { f.cleanup(); }
});

test('an old run is removed even when it is within the newest N, and a live one is never touched', () => {
  const f = fixture();
  try {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    writeRun(f.dir, 'dsh-crew-web-', 'old-run', 30 * day, now);
    writeRun(f.dir, 'dsh-crew-web-', 'live-run', 0, now);

    const result = pruneCrewTempLogs({ tempDir: f.dir, keepRuns: 10, maxAgeDays: 14, now });
    assert.equal(existsSync(join(f.dir, 'dsh-crew-web-old-run.out.log')), false, 'older than the age bound');
    assert.equal(existsSync(join(f.dir, 'dsh-crew-web-live-run.out.log')), true, 'the recency guard keeps a live file');
    assert.deepEqual(result.kept, ['live-run']);
  } finally { f.cleanup(); }
});

// Retention is per family. The hub-start pairs are the crash-before-readiness
// evidence and keep the policy's ten; the frontend families are launched far less
// often and keep the twenty they already had, so one family's bound is not silently
// imposed on the others. An explicit `keepRuns` is an operator override and applies
// to every family.
test('each family keeps its own bound unless the operator overrides them all', () => {
  const f = fixture();
  try {
    const now = Date.now();
    const minute = 60 * 1000;
    for (let index = 0; index < 12; index += 1) {
      const stamp = String(index).padStart(2, '0');
      writeRun(f.dir, 'dsh-crew-dsh-crew-3210-', `hub-${stamp}`, (index + 1) * 10 * minute, now);
      writeRun(f.dir, 'dsh-crew-web-', `web-${stamp}`, (index + 1) * 10 * minute, now);
    }

    const result = pruneCrewTempLogs({ tempDir: f.dir, now });
    assert.equal(result.kept.filter((stamp) => stamp.startsWith('hub-')).length, 10, 'the hub family keeps ten pairs');
    assert.equal(result.kept.filter((stamp) => stamp.startsWith('web-')).length, 12, 'the frontend family keeps all twelve, under its own bound of twenty');
    assert.equal(existsSync(join(f.dir, 'dsh-crew-dsh-crew-3210-hub-11.out.log')), false, 'the oldest hub pair is gone');
    assert.equal(existsSync(join(f.dir, 'dsh-crew-web-web-11.out.log')), true, 'while the same-aged frontend pair stays');

    const overridden = pruneCrewTempLogs({ tempDir: f.dir, keepRuns: 2, now });
    assert.equal(overridden.kept.filter((stamp) => stamp.startsWith('hub-')).length, 2);
    assert.equal(overridden.kept.filter((stamp) => stamp.startsWith('web-')).length, 2, 'an explicit keepRuns applies to every family');
  } finally { f.cleanup(); }
});

test('an unrelated temp file is never a candidate, and a missing directory is not an error', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'unrelated.log'), 'keep me\n');
    writeFileSync(join(f.dir, 'dsh-crew-launcher.log'), 'appended by the launcher\n');
    const result = pruneCrewTempLogs({ tempDir: f.dir, keepRuns: 1, now: Date.now() });
    assert.equal(existsSync(join(f.dir, 'unrelated.log')), true);
    assert.equal(existsSync(join(f.dir, 'dsh-crew-launcher.log')), true, 'the launcher log is appended, not per-run');
    assert.deepEqual(result.removed, []);

    const missing = pruneCrewTempLogs({ tempDir: join(f.dir, 'nope'), now: Date.now() });
    assert.equal(missing.ok, true);
    assert.deepEqual(missing.removed, []);
  } finally { f.cleanup(); }
});
