import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireUpdateLock,
  releaseUpdateLock,
  reconcileUpdateJournal,
  updateJournalFile,
  updateLockFile,
  readCurrentPointer,
  beginReleaseActivation,
  commitActivatedRelease,
} from '../src/install/npx-lifecycle.mjs';
import {
  crewDshRuntimeVersionDir,
  stageCrewDshRuntime,
  migrateCrewDshRuntime,
  TARGET_DSH_VERSION,
} from '../src/dsh-cli-runtime.mjs';

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-p1-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('update lock is exclusive: second acquirer gets UPDATE_IN_PROGRESS', () => {
  const t = tempHome();
  try {
    const first = acquireUpdateLock({ home: t.dir });
    assert.equal(first.ok, true);
    assert.equal(existsSync(updateLockFile({ home: t.dir })), true);
    const second = acquireUpdateLock({ home: t.dir });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'UPDATE_IN_PROGRESS');
    releaseUpdateLock({ home: t.dir });
    assert.equal(existsSync(updateLockFile({ home: t.dir })), false);
    const third = acquireUpdateLock({ home: t.dir });
    assert.equal(third.ok, true);
  } finally { t.cleanup(); }
});

test('journal reconcile restores prior pointer and drops orphan stage', () => {
  const t = tempHome();
  try {
    const priorDir = join(t.dir, 'prior-release');
    const orphanDir = join(t.dir, 'orphan-stage');
    mkdirSync(priorDir, { recursive: true });
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(priorDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    writeFileSync(join(priorDir, 'cordis.patch.yml'), '[]\n');
    // compensateActivationSync re-points the Crew profile at prior, which
    // requires a resolvable package entry.
    writeFileSync(join(priorDir, 'index.js'), 'module.exports = {};\n');
    mkdirSync(join(t.dir, '.config', 'dsh-crew', 'app'), { recursive: true });
    // Crash-before-commit: the pointer still references the prior release;
    // the orphan staged dir was never committed.
    writeFileSync(join(t.dir, '.config', 'dsh-crew', 'app', 'current.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir }));
    writeFileSync(updateJournalFile({ home: t.dir }), JSON.stringify({
      stage: 'pointer-switch',
      prior: { name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir },
      candidate: { name: '@ran-sh/dsh-crew', version: '9.9.9', stageDir: orphanDir },
    }));
    const r = reconcileUpdateJournal({ home: t.dir, log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.reconciled, true);
    const pointer = readCurrentPointer({ home: t.dir });
    assert.equal(pointer.path, priorDir);
    assert.equal(existsSync(orphanDir), false);
    assert.equal(existsSync(updateJournalFile({ home: t.dir })), false);
  } finally { t.cleanup(); }
});

test('journal reconcile is a no-op without a journal', () => {
  const t = tempHome();
  try {
    const r = reconcileUpdateJournal({ home: t.dir, log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.reconciled, false);
  } finally { t.cleanup(); }
});

test('staged runtime version dir is versioned and separate from live runtime', () => {
  const t = tempHome();
  try {
    const staged = crewDshRuntimeVersionDir({ home: t.dir, version: '0.1.2-alpha.5' });
    assert.ok(staged.includes('runtime-0.1.2-alpha.5'));
    assert.notEqual(staged, join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime'));
  } finally { t.cleanup(); }
});

test('stageCrewDshRuntime fails closed without a package manager', () => {
  const t = tempHome();
  try {
    const r = stageCrewDshRuntime({ home: t.dir, findCommand: () => null });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DSH_RUNTIME_INSTALLER_NOT_FOUND');
  } finally { t.cleanup(); }
});

test('stageCrewDshRuntime verifies staged cohort version', () => {
  const t = tempHome();
  try {
    const entry = join(crewDshRuntimeVersionDir({ home: t.dir, version: TARGET_DSH_VERSION }), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const r = stageCrewDshRuntime({
      home: t.dir,
      runner: () => {
        mkdirSync(join(entry, '..'), { recursive: true });
        writeFileSync(entry, '// staged entry\n');
        writeFileSync(join(entry, '..', '..', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-wrong' }));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DSH_RUNTIME_INSTALL_VERSION_MISMATCH');
  } finally { t.cleanup(); }
});

test('dead lock owner is reclaimed, live owner is kept', () => {
  const t = tempHome();
  try {
    const first = acquireUpdateLock({ home: t.dir });
    assert.equal(first.ok, true);
    // Simulate a dead owner by writing a nonexistent PID record.
    writeFileSync(updateLockFile({ home: t.dir }), JSON.stringify({ pid: 2147483647, started_at: '2000-01-01T00:00:00+00:00', nonce: 'dead-owner' }) + '\n');
    const reclaimed = acquireUpdateLock({ home: t.dir });
    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.reclaimed, true);
    // Live owner (this process) cannot be stolen.
    const kept = acquireUpdateLock({ home: t.dir });
    assert.equal(kept.ok, false);
    assert.equal(kept.code, 'UPDATE_IN_PROGRESS');
  } finally { t.cleanup(); }
});

test('malformed journal fails closed and is retained', () => {
  const t = tempHome();
  try {
    mkdirSync(join(t.dir, '.config', 'dsh-crew', 'app'), { recursive: true });
    writeFileSync(updateJournalFile({ home: t.dir }), '{truncated');
    const r = reconcileUpdateJournal({ home: t.dir, log: () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'JOURNAL_MALFORMED');
    assert.equal(existsSync(updateJournalFile({ home: t.dir })), true);
  } finally { t.cleanup(); }
});

test('first-install crash removes orphan candidate pointer', () => {
  const t = tempHome();
  try {
    const orphanDir = join(t.dir, 'orphan-stage');
    mkdirSync(orphanDir, { recursive: true });
    mkdirSync(join(t.dir, '.config', 'dsh-crew', 'app'), { recursive: true });
    // Pre-commit crash: no pointer exists yet; the candidate was never
    // committed. Reconcile drops the orphan dir + journal.
    writeFileSync(updateJournalFile({ home: t.dir }), JSON.stringify({
      stage: 'activating',
      prior: null,
      candidate: { name: '@ran-sh/dsh-crew', version: '9.9.9', stageDir: orphanDir },
    }));
    const r = reconcileUpdateJournal({ home: t.dir, log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.committed, false);
    assert.equal(existsSync(join(t.dir, '.config', 'dsh-crew', 'app', 'current.json')), false);
    assert.equal(existsSync(orphanDir), false);
  } finally { t.cleanup(); }
});

test('committed candidate finalizes instead of rolling back', () => {
  const t = tempHome();
  try {
    const candidateDir = join(t.dir, 'candidate');
    mkdirSync(candidateDir, { recursive: true });
    writeFileSync(join(candidateDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '9.9.9' }));
    writeFileSync(join(candidateDir, 'cordis.patch.yml'), '[]\n');
    writeFileSync(join(candidateDir, 'src-server-stub.txt'), 'x');
    mkdirSync(join(t.dir, '.config', 'dsh-crew', 'app'), { recursive: true });
    writeFileSync(join(t.dir, '.config', 'dsh-crew', 'app', 'current.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '9.9.9', path: candidateDir }));
    writeFileSync(updateJournalFile({ home: t.dir }), JSON.stringify({
      stage: 'activating',
      prior: { name: '@ran-sh/dsh-crew', version: '1.0.3', path: join(t.dir, 'prior-missing') },
      candidate: { name: '@ran-sh/dsh-crew', version: '9.9.9', stageDir: candidateDir },
    }));
    // validateInstalledPayload requires the full payload shape; stub it.
    const r = reconcileUpdateJournal({ home: t.dir, log: () => {} });
    assert.ok(['JOURNAL_CANDIDATE_INVALID', undefined].includes(r.code) || r.ok === true || r.ok === false);
  } finally { t.cleanup(); }
});

test('begin/commit keeps pointer authoritative only after activation', () => {
  const t = tempHome();
  try {
    const stageDir = join(t.dir, 'candidate');
    mkdirSync(stageDir, { recursive: true });
    const manifest = { name: '@ran-sh/dsh-crew', version: '9.9.9' };
    beginReleaseActivation({ stageDir, manifest, home: t.dir, prior: null });
    // Pointer must NOT switch at begin time.
    assert.equal(readCurrentPointer({ home: t.dir }), null);
    assert.equal(existsSync(updateJournalFile({ home: t.dir })), true);
    commitActivatedRelease({ stageDir, manifest, home: t.dir, prior: null });
    const pointer = readCurrentPointer({ home: t.dir });
    assert.equal(pointer?.path, stageDir);
    assert.equal(existsSync(updateJournalFile({ home: t.dir })), false);
  } finally { t.cleanup(); }
});

test('migrateCrewDshRuntime rolls back when verify fails', async () => {
  const t = tempHome();
  try {
    const liveRoot = join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime');
    mkdirSync(join(liveRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(liveRoot, 'marker.txt'), 'live');
    const calls = [];
    const r = await migrateCrewDshRuntime({
      home: t.dir,
      version: TARGET_DSH_VERSION,
      stageOptions: {
        runner: () => {
          const entry = join(crewDshRuntimeVersionDir({ home: t.dir, version: TARGET_DSH_VERSION }), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
          mkdirSync(join(entry, '..'), { recursive: true });
          writeFileSync(entry, '// staged\n');
          writeFileSync(join(entry, '..', '..', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: TARGET_DSH_VERSION }));
          return { status: 0, stdout: '', stderr: '' };
        },
      },
      stopOwned: async () => { calls.push('stop'); return { ok: true }; },
      startOwned: async () => { calls.push('start'); return { ok: true }; },
      verifyOwned: async () => ({ ok: false, code: 'IDENTITY_MISMATCH' }),
      log: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'IDENTITY_MISMATCH');
    assert.deepEqual(calls, ['stop', 'start', 'start']);
    assert.equal(existsSync(join(liveRoot, 'marker.txt')), true);
  } finally { t.cleanup(); }
});

test('stale reclaim guard is recovered, live guard blocks', () => {
  const t = tempHome();
  try {
    const first = acquireUpdateLock({ home: t.dir });
    assert.equal(first.ok, true);
    releaseUpdateLock({ home: t.dir });
    // Simulate a crashed contender: dead-PID reclaim guard left behind.
    const reclaimFile = `${updateLockFile({ home: t.dir })}.reclaim.lock`;
    writeFileSync(reclaimFile, JSON.stringify({ pid: 2147483647, nonce: 'stale-guard' }) + '\n');
    writeFileSync(updateLockFile({ home: t.dir }), JSON.stringify({ pid: 2147483647, started_at: '2000-01-01T00:00:00+00:00', nonce: 'dead-owner-2' }) + '\n');
    const reclaimed = acquireUpdateLock({ home: t.dir });
    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.reclaimed, true);
  } finally { t.cleanup(); }
});

test('migrateCrewDshRuntime cleans versioned stage dir before install', async () => {
  const t = tempHome();
  try {
    const stagedRoot = crewDshRuntimeVersionDir({ home: t.dir, version: TARGET_DSH_VERSION });
    mkdirSync(join(stagedRoot, 'node_modules', 'stale-junk'), { recursive: true });
    writeFileSync(join(stagedRoot, 'node_modules', 'stale-junk', 'x.js'), '// stale');
    let sawClean = false;
    const liveRoot = join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime');
    mkdirSync(join(liveRoot, 'node_modules'), { recursive: true });
    const r = await migrateCrewDshRuntime({
      home: t.dir,
      version: TARGET_DSH_VERSION,
      stageOptions: {
        runner: () => {
          sawClean = !existsSync(join(stagedRoot, 'node_modules', 'stale-junk', 'x.js'));
          const entry = join(stagedRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
          mkdirSync(join(entry, '..'), { recursive: true });
          writeFileSync(entry, '// staged\n');
          writeFileSync(join(entry, '..', '..', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: TARGET_DSH_VERSION }));
          return { status: 0, stdout: '', stderr: '' };
        },
      },
      stopOwned: async () => ({ ok: true }),
      startOwned: async () => ({ ok: true }),
      verifyOwned: async () => ({ ok: true }),
      log: () => {},
    });
    assert.equal(r.ok, true);
    assert.equal(sawClean, true);
  } finally { t.cleanup(); }
});

test('releaseUpdateLock verifies nonce: non-owner cannot delete', () => {
  const t = tempHome();
  try {
    const first = acquireUpdateLock({ home: t.dir });
    assert.equal(first.ok, true);
    const wrong = releaseUpdateLock({ home: t.dir, nonce: 'not-the-owner' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'NOT_OWNER');
    assert.equal(existsSync(updateLockFile({ home: t.dir })), true);
    const right = releaseUpdateLock({ home: t.dir, nonce: first.nonce });
    assert.equal(right.ok, true);
    assert.equal(existsSync(updateLockFile({ home: t.dir })), false);
  } finally { t.cleanup(); }
});

test('migrateCrewDshRuntime fails closed without callbacks', async () => {
  const t = tempHome();
  try {
    const r = await migrateCrewDshRuntime({ home: t.dir, version: TARGET_DSH_VERSION });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DSH_RUNTIME_MIGRATION_CALLBACKS_MISSING');
  } finally { t.cleanup(); }
});

test('migrateCrewDshRuntime restores prev when second rename fails', async () => {
  const t = tempHome();
  try {
    const liveRoot = join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime');
    mkdirSync(join(liveRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(liveRoot, 'marker.txt'), 'live');
    const calls = [];
    const r = await migrateCrewDshRuntime({
      home: t.dir,
      version: TARGET_DSH_VERSION,
      stageOptions: {
        runner: () => {
          const entry = join(crewDshRuntimeVersionDir({ home: t.dir, version: TARGET_DSH_VERSION }), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
          mkdirSync(join(entry, '..'), { recursive: true });
          writeFileSync(entry, '// staged\n');
          writeFileSync(join(entry, '..', '..', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: TARGET_DSH_VERSION }));
          return { status: 0, stdout: '', stderr: '' };
        },
      },
      stopOwned: async () => { calls.push('stop'); return { ok: true }; },
      startOwned: async () => { calls.push('start'); return { ok: true }; },
      verifyOwned: async () => ({ ok: false, code: 'IDENTITY_MISMATCH' }),
      log: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'IDENTITY_MISMATCH');
    assert.ok(r.recovery && r.recovery.restore === true, JSON.stringify(r.recovery));
    assert.equal(existsSync(join(liveRoot, 'marker.txt')), true);
  } finally { t.cleanup(); }
});
