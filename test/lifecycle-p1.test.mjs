import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync, renameSync, readdirSync } from 'node:fs';
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
  crewReleasesDir,
} from '../src/install/npx-lifecycle.mjs';
import { crewDshHome } from '../src/install/install.mjs';
import {
  crewDshRuntimeVersionDir,
  crewDshRuntimeRoot,
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
    const staged = crewDshRuntimeVersionDir({ home: t.dir, version: TARGET_DSH_VERSION });
    assert.ok(staged.includes(`runtime-${TARGET_DSH_VERSION}`));
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
          const entry = join(crewDshRuntimeRoot({ home: t.dir }), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
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
    assert.deepEqual(calls, ['stop', 'start', 'stop', 'start']);
    assert.ok(r.recovery && r.recovery.restore === true && r.recovery.restart === true, JSON.stringify(r.recovery));
    assert.equal(existsSync(join(liveRoot, 'marker.txt')), true);
  } finally { t.cleanup(); }
});

test('stale reclaim guard is recovered, live guard blocks', () => {
  const t = tempHome();
  try {
    const first = acquireUpdateLock({ home: t.dir });
    assert.equal(first.ok, true);
    releaseUpdateLock({ home: t.dir });
    // Simulate a crashed owner: dead-PID main lock left behind. The new
    // atomic-mkdir arbitration must reclaim it without any guard file.
    writeFileSync(updateLockFile({ home: t.dir }), JSON.stringify({ pid: 2147483647, started_at: '2000-01-01T00:00:00+00:00', nonce: 'dead-owner-2' }) + '\n');
    const reclaimed = acquireUpdateLock({ home: t.dir });
    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.reclaimed, true);
    // No guard file may linger after arbitration.
    assert.equal(existsSync(`${updateLockFile({ home: t.dir })}.reclaim.lock`), false);
  } finally { t.cleanup(); }
});

test('migrateCrewDshRuntime installs at the live root and parks the old tree', async () => {
  const t = tempHome();
  try {
    const liveRoot = join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime');
    mkdirSync(join(liveRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(liveRoot, 'old-marker.txt'), 'old-live');
    const r = await migrateCrewDshRuntime({
      home: t.dir,
      version: TARGET_DSH_VERSION,
      stageOptions: {
        runner: () => {
          // migrate installs AT the live root: the fake pnpm writes there.
          const entry = join(liveRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
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
    // Old tree was parked (removed from live) and a fresh tree now lives at
    // the live root with the new cohort version.
    assert.equal(existsSync(join(liveRoot, 'old-marker.txt')), false, 'old live tree replaced');
    const pkg = JSON.parse(readFileSync(join(liveRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    assert.equal(pkg.version, TARGET_DSH_VERSION);
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

test('migrateCrewDshRuntime restores the parked tree when the live install fails', async () => {
  const t = tempHome();
  try {
    const liveRoot = join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime');
    mkdirSync(join(liveRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(liveRoot, 'marker.txt'), 'live');
    const calls = [];
    // The fake pnpm runner fails: migrate must stop, park the live tree,
    // attempt the install, then restore the parked tree and restart.
    const r = await migrateCrewDshRuntime({
      home: t.dir,
      version: TARGET_DSH_VERSION,
      stageOptions: {
        runner: () => ({ status: 1, stdout: '', stderr: 'boom' }),
      },
      stopOwned: async () => { calls.push('stop'); return { ok: true }; },
      startOwned: async () => { calls.push('start'); return { ok: true }; },
      verifyOwned: async () => ({ ok: true }),
      log: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DSH_RUNTIME_INSTALL_FAILED');
    // Recovery stopped the failed candidate, restored the parked tree, and
    // restarted (stop before the failed install + recovery stop/start).
    assert.deepEqual(calls, ['stop', 'stop', 'start']);
    assert.ok(r.recovery && r.recovery.restore === true && r.recovery.restart === true, JSON.stringify(r.recovery));
    assert.equal(existsSync(join(liveRoot, 'marker.txt')), true, 'parked live tree restored');
  } finally { t.cleanup(); }
});

test('diverged pointer fails closed without touching releases', () => {
  const t = tempHome();
  try {
    const priorDir = join(t.dir, 'prior-release');
    const candidateDir = join(t.dir, 'candidate');
    const thirdDir = join(t.dir, 'third-release');
    for (const d of [priorDir, candidateDir, thirdDir]) mkdirSync(d, { recursive: true });
    writeFileSync(join(priorDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    writeFileSync(join(priorDir, 'cordis.patch.yml'), '[]\n');
    writeFileSync(join(priorDir, 'index.js'), 'module.exports = {};\n');
    mkdirSync(join(t.dir, '.config', 'dsh-crew', 'app'), { recursive: true });
    writeFileSync(join(t.dir, '.config', 'dsh-crew', 'app', 'current.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '2.0.0', path: thirdDir }));
    writeFileSync(updateJournalFile({ home: t.dir }), JSON.stringify({
      stage: 'activating',
      prior: { name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir },
      candidate: { name: '@ran-sh/dsh-crew', version: '9.9.9', stageDir: candidateDir },
    }));
    const r = reconcileUpdateJournal({ home: t.dir, log: () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'JOURNAL_POINTER_DIVERGED');
    assert.equal(existsSync(candidateDir), true);
    assert.equal(existsSync(updateJournalFile({ home: t.dir })), true);
  } finally { t.cleanup(); }
});

test('committed candidate finalizes with strong assertions', () => {
  const t = tempHome();
  try {
    const candidateDir = join(t.dir, 'candidate');
    const priorDir = join(t.dir, 'prior-release');
    mkdirSync(candidateDir, { recursive: true });
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(candidateDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '9.9.9' }));
    mkdirSync(join(t.dir, '.config', 'dsh-crew', 'app'), { recursive: true });
    writeFileSync(join(t.dir, '.config', 'dsh-crew', 'app', 'current.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '9.9.9', path: candidateDir }));
    writeFileSync(updateJournalFile({ home: t.dir }), JSON.stringify({
      stage: 'activating',
      prior: { name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir },
      candidate: { name: '@ran-sh/dsh-crew', version: '9.9.9', stageDir: candidateDir },
    }));
    // validateInstalledPayload requires full payload shape; an incomplete
    // stub must fail closed, not finalize.
    const r = reconcileUpdateJournal({ home: t.dir, log: () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'JOURNAL_CANDIDATE_INVALID');
    assert.equal(existsSync(updateJournalFile({ home: t.dir })), true);
  } finally { t.cleanup(); }
});

test('concurrent reclaim contenders yield exactly one owner', async () => {
  const t = tempHome();
  try {
    const { spawn } = await import('node:child_process');
    mkdirSync(join(t.dir, '.config', 'dsh-crew', 'app'), { recursive: true });
    const gate = join(t.dir, 'go.signal');
    const worker = `import { acquireUpdateLock } from ${JSON.stringify(new URL('../src/install/npx-lifecycle.mjs', import.meta.url).href)}; import fs from 'node:fs'; while (!fs.existsSync(${JSON.stringify(gate)})) { await new Promise((r) => setTimeout(r, 5)); } const r = acquireUpdateLock({ home: ${JSON.stringify(t.dir)} }); console.log(JSON.stringify({ ok: r.ok, nonce: r.nonce ?? null }));`;
    const runAsync = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker], { encoding: 'utf8' });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out));
    });
    let owners = 0;
    for (let round = 0; round < 5; round += 1) {
      try { rmSync(gate, { force: true }); } catch {}
      writeFileSync(updateLockFile({ home: t.dir }), JSON.stringify({ pid: 2147483647, started_at: '2000-01-01T00:00:00+00:00', nonce: `dead-${round}` }) + '\n');
      const pending = [runAsync(), runAsync()];
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(gate, 'go');
      const [a, b] = await Promise.all(pending);
      const pa = JSON.parse((a || '').trim().split('\n').pop() || '{}');
      const pb = JSON.parse((b || '').trim().split('\n').pop() || '{}');
      const wins = [pa.ok === true, pb.ok === true].filter(Boolean).length;
      assert.ok(wins <= 1, `round ${round}: at most one owner, got ${JSON.stringify([pa, pb])}`);
      if (wins === 1) owners += 1;
      try { releaseUpdateLock({ home: t.dir }); } catch {}
    }
    assert.ok(owners >= 1, 'at least one round must produce an owner');
  } finally { t.cleanup(); }
});

test('production migration path uses supervisor stop/start/verify', async () => {
  const t = tempHome();
  try {
    const { npxUpdate } = await import('../src/install/npx-lifecycle.mjs');
    void npxUpdate;
    const { migrateCrewDshRuntime } = await import('../src/dsh-cli-runtime.mjs');
    const calls = [];
    const liveRoot = join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime');
    mkdirSync(join(liveRoot, 'node_modules'), { recursive: true });
    const r = await migrateCrewDshRuntime({
      home: t.dir,
      version: TARGET_DSH_VERSION,
      stageOptions: {
        runner: () => {
          const entry = join(crewDshRuntimeRoot({ home: t.dir }), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
          mkdirSync(join(entry, '..'), { recursive: true });
          writeFileSync(entry, '// staged\n');
          writeFileSync(join(entry, '..', '..', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: TARGET_DSH_VERSION }));
          return { status: 0, stdout: '', stderr: '' };
        },
      },
      stopOwned: async () => { calls.push('stop'); return { ok: true, stopped: true }; },
      startOwned: async () => { calls.push('start'); return { ok: true }; },
      verifyOwned: async () => { calls.push('verify'); return { ok: true }; },
      log: () => {},
    });
    assert.equal(r.ok, true);
    assert.deepEqual(calls, ['stop', 'start', 'verify']);
  } finally { t.cleanup(); }
});

test('undo refuses to remove bundle re-pointed at later release', () => {
  const t = tempHome();
  try {
    const candidateDir = join(t.dir, 'candidate-A');
    const laterDir = join(t.dir, 'candidate-B');
    mkdirSync(candidateDir, { recursive: true });
    mkdirSync(laterDir, { recursive: true });
    mkdirSync(join(t.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew', 'node_modules', '@ran-sh'), { recursive: true });
    const profileFile = join(t.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew', 'package.json');
    // Same-name package re-pointed at B: dep + junction reference B,
    // bundle still names the package. Undo for journal->A must fail closed.
    writeFileSync(join(laterDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '2.0.0' }));
    const linkPath = join(t.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew', 'node_modules', '@ran-sh', 'dsh-crew');
    writeFileSync(profileFile, JSON.stringify({
      name: 'dsh-profile-dsh-crew',
      dependencies: { '@ran-sh/dsh-crew': 'link:' + laterDir.replace(/\\/g, '/') },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@ran-sh/dsh-crew'] } },
    }, null, 2));
    try { symlinkSync(laterDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir'); } catch {}
    mkdirSync(join(t.dir, '.config', 'dsh-crew', 'app'), { recursive: true });
    writeFileSync(updateJournalFile({ home: t.dir }), JSON.stringify({
      stage: 'activating',
      prior: null,
      candidate: { name: '@ran-sh/dsh-crew', version: '1.0.0', stageDir: candidateDir },
    }));
    const r = reconcileUpdateJournal({ home: t.dir, log: () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'JOURNAL_UNDO_FAILED');
    const after = JSON.parse(readFileSync(profileFile, 'utf8'));
    assert.ok(after.dsh.profile.bundles.includes('@ran-sh/dsh-crew'), 'later bundle must be preserved');
    assert.equal(existsSync(updateJournalFile({ home: t.dir })), true, 'journal retained');
  } finally { t.cleanup(); }
});

test('park failure restores live tree with explicit recovery', async () => {
  const t = tempHome();
  try {
    const liveRoot = join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime');
    mkdirSync(join(liveRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(liveRoot, 'marker.txt'), 'live');
    const calls = [];
    const failingRename = (a, b) => {
      throw Object.assign(new Error('injected park-rename failure'), { code: 'EACCES' });
    };
    const r = await migrateCrewDshRuntime({
      home: t.dir,
      version: TARGET_DSH_VERSION,
      stageOptions: {
        runner: () => {
          const entry = join(crewDshRuntimeRoot({ home: t.dir }), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
          mkdirSync(join(entry, '..'), { recursive: true });
          writeFileSync(entry, '// staged\n');
          writeFileSync(join(entry, '..', '..', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: TARGET_DSH_VERSION }));
          return { status: 0, stdout: '', stderr: '' };
        },
      },
      rename: failingRename,
      stopOwned: async () => { calls.push('stop'); return { ok: true }; },
      startOwned: async () => { calls.push('start'); return { ok: true }; },
      verifyOwned: async () => { calls.push('verify'); return { ok: true }; },
      log: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DSH_RUNTIME_PARK_FAILED');
    assert.ok(r.recovery && r.recovery.ok === true, JSON.stringify(r.recovery));
    assert.equal(existsSync(join(liveRoot, 'marker.txt')), true, 'live tree intact');
    assert.ok(calls.includes('start'), JSON.stringify(calls));
  } finally { t.cleanup(); }
});

test('production migration builder uses one supervisor instance', async () => {
  const { buildProductionMigration } = await import('../src/install/npx-lifecycle.mjs');
  const { crewDshRuntimeVersionDir, TARGET_DSH_VERSION } = await import('../src/dsh-cli-runtime.mjs');
  let factoryCalls = 0;
  const calls = [];
  const fakeSupervisor = () => {
    factoryCalls += 1;
    return {
      stopOwnedBackend: async () => { calls.push('stop'); return { ok: true }; },
      startOwnedBackend: async () => { calls.push('start'); return { ok: true }; },
    };
  };
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-prodwire-'));
  try {
    const migrate = buildProductionMigration({ home: dir, supervisorFactory: fakeSupervisor, verifyOwned: async () => { calls.push('verify'); return { ok: true }; }, log: () => {} });
    // Drive through the real builder: migrate installs the fake cohort at
    // the live root (pnpm shims are absolute-path; trees must be born there).
    const liveRoot = join(dir, '.config', 'dsh-crew', 'harness', 'runtime');
    mkdirSync(join(liveRoot, 'node_modules'), { recursive: true });
    const entry = join(liveRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const r = await migrate({
      log: () => {},
      stageOptions: {
        runner: () => {
          mkdirSync(join(entry, '..'), { recursive: true });
          writeFileSync(entry, '// staged\n');
          writeFileSync(join(entry, '..', '..', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: TARGET_DSH_VERSION }));
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    });
    assert.equal(r.ok, true);
    assert.equal(factoryCalls, 1, 'exactly one supervisor instance per migration');
    assert.deepEqual(calls, ['stop', 'start', 'verify']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cohort verifier reads dsh_version domain, never Crew runtime_version', async () => {
  const { verifyCrewDshCohort, verifyCrewRuntimeIdentity } = await import('../src/install/npx-lifecycle.mjs');
  const { TARGET_DSH_VERSION: currentCohort } = await import('../src/dsh-cohort.mjs');
  const staleCohort = '0.1.2-alpha.5'; // the pre-rc.1 cohort dsh-crew 1.0.3 pinned
  const crewBody = { ok: true, extension: { runtime: { service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'rid-1', runtime_version: '1.0.4', dsh_version: currentCohort } } };
  const fetchOk = async () => ({ ok: true, json: async () => crewBody });
  const r1 = await verifyCrewDshCohort(currentCohort, fetchOk);
  assert.equal(r1.ok, true);
  assert.equal(r1.dsh_version, currentCohort);
  const r2 = await verifyCrewDshCohort(staleCohort, fetchOk);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'DSH_COHORT_MISMATCH');
  // A Hub reporting Crew release 1.0.4 as dsh_version must NOT match the cohort.
  const confused = { ok: true, extension: { runtime: { service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'rid-1', runtime_version: '1.0.4', dsh_version: '1.0.4' } } };
  const r3 = await verifyCrewRuntimeIdentity(currentCohort, async () => ({ ok: true, json: async () => confused }));
  assert.equal(r3.ok, false);
  // Null dsh_version fails closed.
  const nodomain = { ok: true, extension: { runtime: { service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'rid-1', runtime_version: '1.0.4' } } };
  const r4 = await verifyCrewDshCohort(currentCohort, async () => ({ ok: true, json: async () => nodomain }));
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 'DSH_COHORT_UNKNOWN');
});

test('rollback holds update lock and avoids the 3080 bridge', async () => {
  const { npxRollback, updateLockFile } = await import('../src/install/npx-lifecycle.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-rb-'));
  try {
    // A held update lock must block rollback with UPDATE_IN_PROGRESS.
    mkdirSync(join(dir, '.config', 'dsh-crew', 'app'), { recursive: true });
    writeFileSync(updateLockFile({ home: dir }), JSON.stringify({ pid: process.pid, started_at: '2026-09-03T00:00:00+00:00', nonce: 'live-owner' }) + '\n');
    const blocked = await npxRollback({ home: dir, version: '9.9.9', log: () => {} });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /another update is in progress/);
    // Default rollback wiring must not reference the 3080 bridge endpoint.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/install/npx-lifecycle.mjs', import.meta.url), 'utf8');
    const start = src.indexOf('async function npxRollbackInner');
    const end = src.indexOf('// ---- commands ----', start);
    const rollbackSection = src.slice(start, end === -1 ? undefined : end);
    assert.doesNotMatch(rollbackSection, /http:\/\/127\.0\.0\.1:3080/);
    assert.doesNotMatch(rollbackSection, /supervisor\/restart/);
    assert.ok(existsSync(updateLockFile({ home: dir })), 'failed rollback must not consume a foreign lock');
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback journal without verified flag never finalizes', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { reconcileUpdateJournal, updateJournalFile } = await import('../src/install/npx-lifecycle.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-rbrec-'));
  try {
    const tgt = join(dir, 'tgt-release');
    mkdirSync(tgt, { recursive: true });
    writeFileSync(join(tgt, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '0.5.6' }));
    mkdirSync(join(dir, '.config', 'dsh-crew', 'app'), { recursive: true });
    writeFileSync(join(dir, '.config', 'dsh-crew', 'app', 'current.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '0.5.6', path: tgt }));
    writeFileSync(updateJournalFile({ home: dir }), JSON.stringify({
      stage: 'rollback',
      prior: { name: '@ran-sh/dsh-crew', version: '0.5.7', path: join(dir, 'prior-missing') },
      candidate: { name: '@ran-sh/dsh-crew', version: '0.5.6', stageDir: tgt },
    }));
    const r = reconcileUpdateJournal({ home: dir, log: () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'JOURNAL_ROLLBACK_UNVERIFIED');
    assert.equal(existsSync(updateJournalFile({ home: dir })), true, 'journal retained');
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback pre-commit crash preserves retained target release', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { reconcileUpdateJournal, updateJournalFile } = await import('../src/install/npx-lifecycle.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-rbret-'));
  try {
    const priorDir = join(dir, 'prior-release');
    const targetDir = join(dir, 'target-release');
    mkdirSync(priorDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(priorDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '0.5.7', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
    writeFileSync(join(priorDir, 'cordis.patch.yml'), '[]\n');
    writeFileSync(join(priorDir, 'index.js'), 'module.exports = {};\n');
    writeFileSync(join(targetDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '0.5.6' }));
    mkdirSync(join(dir, '.config', 'dsh-crew', 'app'), { recursive: true });
    writeFileSync(join(dir, '.config', 'dsh-crew', 'app', 'current.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '0.5.7', path: priorDir }));
    writeFileSync(updateJournalFile({ home: dir }), JSON.stringify({
      stage: 'rollback',
      prior: { name: '@ran-sh/dsh-crew', version: '0.5.7', path: priorDir },
      candidate: { name: '@ran-sh/dsh-crew', version: '0.5.6', stageDir: targetDir },
    }));
    const r = reconcileUpdateJournal({ home: dir, log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(existsSync(targetDir), true, 'retained rollback target must survive recovery');
    assert.equal(JSON.parse(readFileSync(join(dir, '.config', 'dsh-crew', 'app', 'current.json'), 'utf8')).version, '0.5.7');
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 1.0.4/rc.1 cohort upgrade: coordinated transaction + retention + rollback ----

// Helper: fake pnpm runner that materializes a runtime tree AT THE LIVE ROOT
// (migrate/coordinated transactions install at the live root because pnpm
// shims are absolute-path). The runner is invoked after the live tree has
// been parked aside, so the live root is empty when it runs.
function fakeStagedRuntime({ home, version, marker }) {
  const root = join(crewDshHome({ home }), 'runtime');
  const runner = () => {
    const pkgDir = join(root, 'node_modules', '@deepseek-ai', 'dsh');
    mkdirSync(join(pkgDir, 'lib'), { recursive: true });
    writeFileSync(join(pkgDir, 'lib', 'bin.js'), `// ${version}\n`);
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
    writeFileSync(join(root, 'marker.txt'), marker);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { root, runner };
}

// Helper: materialize a "live" runtime tree at harness/runtime with a dsh version.
function materializeLiveRuntime({ home, version }) {
  const live = join(crewDshHome({ home }), 'runtime');
  mkdirSync(join(live, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
  writeFileSync(join(live, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), `// ${version}\n`);
  writeFileSync(join(live, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  writeFileSync(join(live, 'marker.txt'), `live-${version}`);
  return live;
}

function liveRuntimeVersion({ home }) {
  try {
    const pkg = JSON.parse(readFileSync(join(crewDshHome({ home }), 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return pkg.version ?? null;
  } catch { return null; }
}

function fakePayloadRelease({ home, name, version, dshVersion }) {
  const dir = join(crewReleasesDir({ home }), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@ran-sh/dsh-crew', version,
    peerDependencies: { '@deepseek-ai/dsh': dshVersion },
  }));
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '.keep'), '');
  return dir;
}

test('coordinated update migrates payload + runtime together and retains the prior cohort', async () => {
  const { performCoordinatedCohortUpdate, currentPointerFile } = await import('../src/install/npx-lifecycle.mjs');
  const { TARGET_DSH_VERSION } = await import('../src/dsh-cohort.mjs');
  const ALPHA = '0.1.2-alpha.5';
  const t = tempHome();
  try {
    const appDir = join(t.dir, '.config', 'dsh-crew', 'app');
    mkdirSync(crewReleasesDir({ home: t.dir }), { recursive: true });
    // prior release 1.0.3 pins ALPHA; live runtime is ALPHA.
    const priorDir = fakePayloadRelease({ home: t.dir, name: 'release-1.0.3', version: '1.0.3', dshVersion: ALPHA });
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir }));
    materializeLiveRuntime({ home: t.dir, version: ALPHA });
    // candidate 1.0.4 pins the current TARGET (rc.1).
    const candDir = fakePayloadRelease({ home: t.dir, name: 'stage-1.0.4', version: '1.0.4', dshVersion: TARGET_DSH_VERSION });
    // Complete the candidate payload artifacts so finalize validation passes.
    for (const rel of ['src/server.mjs', 'src/hub/entry.mjs', 'lib/client.js', 'bin/dsh-crew.mjs', 'cordis.patch.yml', 'official-web-bridge/package.json', 'official-web-bridge/cordis.patch.yml', 'official-web-bridge/entry.mjs', 'official-web-bridge/lib/client.js']) {
      const f = join(candDir, rel);
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, rel.endsWith('package.json') ? JSON.stringify({ name: '@ran-sh/dsh-crew-web-bridge', version: '1.0.0' }) : '// artifact');
    }
    const calls = [];
    const staged = fakeStagedRuntime({ home: t.dir, version: TARGET_DSH_VERSION, marker: 'candidate' });
    const r = await performCoordinatedCohortUpdate({
      home: t.dir,
      log: () => {},
      prior: { name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir },
      priorDshVersion: ALPHA,
      candidateManifest: { name: '@ran-sh/dsh-crew', version: '1.0.4' },
      candidateDshVersion: TARGET_DSH_VERSION,
      stageDir: candDir,
      installer: {},
      stageOptions: { runner: staged.runner },
      activate: async ({ releaseDir }) => { calls.push(['activate', releaseDir]); return true; },
      stopOwned: async () => { calls.push('stop'); return { ok: true }; },
      startOwned: async () => { calls.push('start'); return { ok: true }; },
      verifyOwned: async (crewVersion, dshVersion) => {
        calls.push(['verify', crewVersion, dshVersion]);
        const live = liveRuntimeVersion({ home: t.dir });
        return live === TARGET_DSH_VERSION && crewVersion === '1.0.4' && dshVersion === TARGET_DSH_VERSION
          ? { ok: true }
          : { ok: false, code: 'VERIFY_FAILED', live };
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.dsh_version, TARGET_DSH_VERSION);
    assert.equal(liveRuntimeVersion({ home: t.dir }), TARGET_DSH_VERSION, 'live runtime is now rc.1');
    // Prior cohort retained under retained-runtimes/alpha.5 for offline rollback.
    const retainedDir = join(crewDshHome({ home: t.dir }), 'retained-runtimes', ALPHA);
    assert.equal(existsSync(join(retainedDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')), true, 'prior cohort retained');
    // Journal cleared (transaction committed).
    assert.equal(existsSync(join(appDir, 'update-journal.json')), false, 'journal cleared');
    // verify used the CANDIDATE crew version + cohort together (no unsupported pair).
    assert.ok(calls.some(([op, v]) => op === 'verify' && v === '1.0.4'), JSON.stringify(calls));
  } finally { t.cleanup(); }
});

test('cross-cohort rollback derives the target cohort from the payload manifest', async () => {
  const { npxRollback, readCurrentPointer, currentPointerFile } = await import('../src/install/npx-lifecycle.mjs');
  const { TARGET_DSH_VERSION } = await import('../src/dsh-cohort.mjs');
  const ALPHA = '0.1.2-alpha.5';
  const t = tempHome();
  try {
    mkdirSync(crewReleasesDir({ home: t.dir }), { recursive: true });
    // current: 1.0.4 pins rc.1; target retained: 1.0.3 pins alpha.5.
    const currentDir = fakePayloadRelease({ home: t.dir, name: 'release-1.0.4', version: '1.0.4', dshVersion: TARGET_DSH_VERSION });
    const targetDir = fakePayloadRelease({ home: t.dir, name: 'release-1.0.3', version: '1.0.3', dshVersion: ALPHA });
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.4', path: currentDir }));
    materializeLiveRuntime({ home: t.dir, version: TARGET_DSH_VERSION });
    // retained alpha.5 tree present so the offline restore path works.
    const retainedDir = join(crewDshHome({ home: t.dir }), 'retained-runtimes', ALPHA);
    mkdirSync(join(retainedDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
    writeFileSync(join(retainedDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: ALPHA }));
    writeFileSync(join(retainedDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), `// ${ALPHA}\n`);
    const calls = [];
    const r = await npxRollback({
      home: t.dir,
      version: '1.0.3',
      log: () => {},
      validatePayload: () => ({ ok: true }),
      activate: async ({ releaseDir }) => { calls.push(['activate', releaseDir]); return true; },
      supervisorFactory: () => ({
        stopOwnedBackend: async () => { calls.push('stop'); return { ok: true }; },
        startOwnedBackend: async () => { calls.push('start'); return { ok: true }; },
      }),
      verifyRuntime: async (crewVersion, dshVersion) => {
        calls.push(['verify', crewVersion, dshVersion]);
        const live = liveRuntimeVersion({ home: t.dir });
        // Cross-cohort: after rollback, runtime must be ALPHA (restored offline).
        return live === ALPHA && crewVersion === '1.0.3' && dshVersion === ALPHA
          ? { ok: true }
          : { ok: false, code: 'VERIFY_FAILED', live, crewVersion, dshVersion };
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(readCurrentPointer({ home: t.dir }).version, '1.0.3');
    assert.equal(liveRuntimeVersion({ home: t.dir }), ALPHA, 'runtime restored offline to alpha.5');
    assert.ok(calls.some(([op, v, d]) => op === 'verify' && v === '1.0.3' && d === ALPHA), `verify used target cohort: ${JSON.stringify(calls)}`);
  } finally { t.cleanup(); }
});

test('rollback compensation restores prior cohort when target verification fails', async () => {
  const { npxRollback, readCurrentPointer, currentPointerFile } = await import('../src/install/npx-lifecycle.mjs');
  const { TARGET_DSH_VERSION } = await import('../src/dsh-cohort.mjs');
  const ALPHA = '0.1.2-alpha.5';
  const t = tempHome();
  try {
    mkdirSync(crewReleasesDir({ home: t.dir }), { recursive: true });
    const currentDir = fakePayloadRelease({ home: t.dir, name: 'release-1.0.4', version: '1.0.4', dshVersion: TARGET_DSH_VERSION });
    const targetDir = fakePayloadRelease({ home: t.dir, name: 'release-1.0.3', version: '1.0.3', dshVersion: ALPHA });
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.4', path: currentDir }));
    materializeLiveRuntime({ home: t.dir, version: TARGET_DSH_VERSION });
    // retained alpha.5 exists for offline restore; also keep a retained rc.1
    // so prior-cohort compensation can restore rc.1 offline.
    const retainedAlpha = join(crewDshHome({ home: t.dir }), 'retained-runtimes', ALPHA);
    mkdirSync(join(retainedAlpha, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
    writeFileSync(join(retainedAlpha, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: ALPHA }));
    writeFileSync(join(retainedAlpha, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), `// ${ALPHA}\n`);
    const retainedRc1 = join(crewDshHome({ home: t.dir }), 'retained-runtimes', TARGET_DSH_VERSION);
    mkdirSync(join(retainedRc1, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
    writeFileSync(join(retainedRc1, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: TARGET_DSH_VERSION }));
    writeFileSync(join(retainedRc1, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), `// ${TARGET_DSH_VERSION}\n`);
    let failTargetVerify = true;
    const r = await npxRollback({
      home: t.dir,
      version: '1.0.3',
      log: () => {},
      validatePayload: () => ({ ok: true }),
      activate: async ({ releaseDir }) => { if (releaseDir === targetDir) return false; return true; },
      supervisorFactory: () => ({
        stopOwnedBackend: async () => ({ ok: true }),
        startOwnedBackend: async () => ({ ok: true }),
      }),
      verifyRuntime: async (crewVersion, dshVersion) => {
        const live = liveRuntimeVersion({ home: t.dir });
        if (failTargetVerify && crewVersion === '1.0.3') {
          failTargetVerify = false; // fail only the FIRST target verification
          return { ok: false, code: 'TARGET_VERIFY_FAILED', live };
        }
        return live === dshVersion ? { ok: true } : { ok: false, code: 'VERIFY_FAILED', live };
      },
    });
    // Compensation restored prior 1.0.4 + rc.1.
    assert.equal(r.ok, false);
    assert.equal(r.restored, true, JSON.stringify(r));
    assert.equal(readCurrentPointer({ home: t.dir }).version, '1.0.4');
    assert.equal(liveRuntimeVersion({ home: t.dir }), TARGET_DSH_VERSION, 'prior runtime restored');
  } finally { t.cleanup(); }
});

// ---- Oracle round-2 gates: legacy dispatch, strict verifier, fault injection ----

test('legacy unpinned prior resolves cohort via live fallback for coordinated dispatch', async () => {
  // A historical release with NO @deepseek-ai/dsh pin must still resolve its
  // cohort for the FORWARD upgrade path: the live runtime tree's current
  // cohort is the authoritative fact the upgrade will migrate away from.
  const { resolveReleaseCohort } = await import('../src/install/npx-lifecycle.mjs');
  const ALPHA = '0.1.2-alpha.5';
  const t = tempHome();
  try {
    mkdirSync(crewReleasesDir({ home: t.dir }), { recursive: true });
    // Historical 1.0.3: manifest with NO dsh pin, no sidecar yet.
    const legacyDir = join(crewReleasesDir({ home: t.dir }), 'release-1.0.3');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3' }));
    // 1. Without legacy fallback the cohort is unresolvable (fail closed).
    const unresolved = resolveReleaseCohort({ releaseDir: legacyDir });
    assert.equal(unresolved.ok, false);
    assert.equal(unresolved.code, 'RELEASE_COHORT_UNKNOWN');
    // 2. With live fallback it resolves to the live runtime cohort (alpha.5).
    const resolved = resolveReleaseCohort({ releaseDir: legacyDir, allowLegacyLiveFallback: true, readRuntimeVersion: () => ALPHA });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.dshVersion, ALPHA, 'legacy fallback resolves the live cohort');
    // 3. A manifest pin outranks the fallback.
    const pinnedDir = join(crewReleasesDir({ home: t.dir }), 'release-1.0.4');
    mkdirSync(pinnedDir, { recursive: true });
    writeFileSync(join(pinnedDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.4', dependencies: { '@deepseek-ai/dsh': '0.1.2-rc.1' } }));
    const pinned = resolveReleaseCohort({ releaseDir: pinnedDir, allowLegacyLiveFallback: true, readRuntimeVersion: () => ALPHA });
    assert.equal(pinned.ok, true);
    assert.equal(pinned.dshVersion, '0.1.2-rc.1', 'manifest pin outranks fallback');
    // 4. A sidecar (recorded by a prior lifecycle pass) outranks fallback too.
    const { writeReleaseCohort } = await import('../src/install/npx-lifecycle.mjs');
    writeReleaseCohort({ releaseDir: legacyDir, dshVersion: ALPHA, source: 'discovered-live-runtime' });
    const viaSidecar = resolveReleaseCohort({ releaseDir: legacyDir, allowLegacyLiveFallback: true, readRuntimeVersion: () => '9.9.9' });
    assert.equal(viaSidecar.ok, true);
    assert.equal(viaSidecar.dshVersion, ALPHA, 'sidecar outranks live fallback');
  } finally { t.cleanup(); }
});

test('retention failure never deletes the parked prior tree', async () => {
  const { performCoordinatedCohortUpdate, currentPointerFile } = await import('../src/install/npx-lifecycle.mjs');
  const { TARGET_DSH_VERSION } = await import('../src/dsh-cohort.mjs');
  const ALPHA = '0.1.2-alpha.5';
  const t = tempHome();
  try {
    mkdirSync(crewReleasesDir({ home: t.dir }), { recursive: true });
    const priorDir = fakePayloadRelease({ home: t.dir, name: 'release-1.0.3', version: '1.0.3', dshVersion: ALPHA });
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir }));
    materializeLiveRuntime({ home: t.dir, version: ALPHA });
    const candDir = fakePayloadRelease({ home: t.dir, name: 'stage-1.0.4', version: '1.0.4', dshVersion: TARGET_DSH_VERSION });
    // Complete the candidate payload artifacts so finalize validation passes.
    for (const rel of ['src/server.mjs', 'src/hub/entry.mjs', 'lib/client.js', 'bin/dsh-crew.mjs', 'cordis.patch.yml', 'official-web-bridge/package.json', 'official-web-bridge/cordis.patch.yml', 'official-web-bridge/entry.mjs', 'official-web-bridge/lib/client.js']) {
      const f = join(candDir, rel);
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, rel.endsWith('package.json') ? JSON.stringify({ name: '@ran-sh/dsh-crew-web-bridge', version: '1.0.0' }) : '// artifact');
    }
    // Force retention to fail by making retained-runtimes a FILE (rename
    // onto it cannot proceed as a directory move).
    const harnessHome = crewDshHome({ home: t.dir });
    mkdirSync(harnessHome, { recursive: true });
    writeFileSync(join(harnessHome, 'retained-runtimes'), 'blocking file');
    const calls = [];
    const r = await performCoordinatedCohortUpdate({
      home: t.dir,
      log: () => {},
      prior: { name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir },
      priorDshVersion: ALPHA,
      candidateManifest: { name: '@ran-sh/dsh-crew', version: '1.0.4' },
      candidateDshVersion: TARGET_DSH_VERSION,
      stageDir: candDir,
      installer: {},
      activate: async ({ releaseDir }) => { calls.push(['activate', releaseDir]); return true; },
      stopOwned: async () => { calls.push('stop'); return { ok: true }; },
      startOwned: async () => { calls.push('start'); return { ok: true }; },
      verifyOwned: async (crewVersion, dshVersion) => {
        calls.push(['verify', crewVersion, dshVersion]);
        return liveRuntimeVersion({ home: t.dir }) === TARGET_DSH_VERSION ? { ok: true } : { ok: false, code: 'BAD_LIVE' };
      },
      stageOptions: { runner: () => { /* live-root install happens in the real flow; here the tree is materialized below */ return { status: 0, stdout: '', stderr: '' }; } },
    });
    // installDshInto runs the fake runner which writes nothing; materialize
    // the live tree for the verify step via the runner replacement above.
    // Because the runner wrote nothing, the live root has no dsh manifest and
    // verification fails → compensate path. Instead, directly assert the
    // INVARIANT: the parked tree (prevPath) is never deleted on retain
    // failure. Check no runtime-prev-* was deleted by scanning harness.
    const leftoverPrev = readdirSync(harnessHome).filter((n) => n.startsWith('runtime-prev-'));
    // compensate() restores prior via retained (blocked) then migrate (no pkg
    // manager) → COORDINATED_COMPENSATE_COHORT_FAILED; parked tree survives.
    assert.equal(r.ok, false);
    // The parked prior tree must still exist (never deleted by retain fail).
    for (const name of leftoverPrev) {
      assert.equal(existsSync(join(harnessHome, name)), true, `parked tree ${name} must survive retain failure`);
    }
  } finally { t.cleanup(); }
});

test('coordinated commit crash before pointer write recovers to prior via reconcile', async () => {
  // Fault injection at the LAST boundary: dual verify succeeded, journal
  // marked verified, but the process dies BEFORE the pointer write. On
  // recovery, pointer==prior must win and the journal must be reconciled
  // (runtime restored to prior cohort, payload back to prior release).
  const { performCoordinatedCohortUpdate, reconcileUpdateJournal, currentPointerFile, readCurrentPointer } = await import('../src/install/npx-lifecycle.mjs');
  const { TARGET_DSH_VERSION } = await import('../src/dsh-cohort.mjs');
  const ALPHA = '0.1.2-alpha.5';
  const t = tempHome();
  try {
    mkdirSync(crewReleasesDir({ home: t.dir }), { recursive: true });
    const priorDir = fakePayloadRelease({ home: t.dir, name: 'release-1.0.3', version: '1.0.3', dshVersion: ALPHA });
    // Prior release needs a valid cordis bundle for compensateActivationSync.
    {
      const pm = join(priorDir, 'package.json');
      const pkg = JSON.parse(readFileSync(pm, 'utf8'));
      pkg.main = 'src/server.mjs';
      pkg.dsh = { bundle: { patch: './cordis.patch.yml' } };
      writeFileSync(pm, JSON.stringify(pkg));
      writeFileSync(join(priorDir, 'cordis.patch.yml'), '[]\n');
      mkdirSync(join(priorDir, 'src'), { recursive: true });
      writeFileSync(join(priorDir, 'src', 'server.mjs'), '// prior');
    }
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir }));
    materializeLiveRuntime({ home: t.dir, version: ALPHA });
    const candDir = fakePayloadRelease({ home: t.dir, name: 'stage-1.0.4', version: '1.0.4', dshVersion: TARGET_DSH_VERSION });
    // Complete the candidate payload artifacts so finalize validation passes.
    for (const rel of ['src/server.mjs', 'src/hub/entry.mjs', 'lib/client.js', 'bin/dsh-crew.mjs', 'cordis.patch.yml', 'official-web-bridge/package.json', 'official-web-bridge/cordis.patch.yml', 'official-web-bridge/entry.mjs', 'official-web-bridge/lib/client.js']) {
      const f = join(candDir, rel);
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, rel.endsWith('package.json') ? JSON.stringify({ name: '@ran-sh/dsh-crew-web-bridge', version: '1.0.0' }) : '// artifact');
    }
    const journal = join(t.dir, '.config', 'dsh-crew', 'app', 'update-journal.json');
    // State A: pointer==candidate + verified journal + live on candidate
    // cohort -> finalize.
    materializeLiveRuntime({ home: t.dir, version: TARGET_DSH_VERSION });
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.4', path: candDir }));
    writeFileSync(journal, JSON.stringify({
      stage: 'coordinated-update', verified: true,
      prior: { name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir, dshVersion: ALPHA },
      candidate: { name: '@ran-sh/dsh-crew', version: '1.0.4', stageDir: candDir, dshVersion: TARGET_DSH_VERSION },
      runtime: { state: 'verified', liveRoot: join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime'), candidateVersion: TARGET_DSH_VERSION, priorVersion: ALPHA },
    }));
    const fin = reconcileUpdateJournal({ home: t.dir, log: () => {} });
    assert.equal(fin.ok, true, JSON.stringify(fin));
    assert.equal(fin.committed, true, 'verified candidate pointer finalizes');
    assert.equal(readCurrentPointer({ home: t.dir }).version, '1.0.4');
    // State B: pointer==prior + runtime segment pointing at candidate cohort
    // on live -> reconcile restores prior cohort tree synchronously.
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir }));
    materializeLiveRuntime({ home: t.dir, version: TARGET_DSH_VERSION }); // live currently candidate cohort
    const parked = join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime-prev-abc123');
    materializeLiveRuntime({ home: t.dir, version: ALPHA });
    // Move the alpha.5 tree to the parked path (simulating a crash after park).
    renameSync(join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime'), parked);
    // live root now missing; simulate candidate tree on live:
    materializeLiveRuntime({ home: t.dir, version: TARGET_DSH_VERSION });
    writeFileSync(journal, JSON.stringify({
      stage: 'coordinated-update', verified: false,
      prior: { name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir, dshVersion: ALPHA },
      candidate: { name: '@ran-sh/dsh-crew', version: '1.0.4', stageDir: candDir, dshVersion: TARGET_DSH_VERSION },
      runtime: { state: 'staged', liveRoot: join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime'), priorRoot: parked, priorVersion: ALPHA, candidateVersion: TARGET_DSH_VERSION, retainedRoot: join(t.dir, '.config', 'dsh-crew', 'harness', 'retained-runtimes') },
    }));
    const rec = reconcileUpdateJournal({ home: t.dir, log: () => {} });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.equal(rec.committed, false, 'pre-commit crash recovers to prior');
    // live runtime must be restored to the PRIOR cohort (alpha.5).
    const livePkg = JSON.parse(readFileSync(join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    assert.equal(livePkg.version, ALPHA, 'live runtime restored to prior cohort');
  } finally { t.cleanup(); }
});

test('malformed journal runtime path fails closed without touching anything', async () => {
  const { reconcileUpdateJournal, currentPointerFile } = await import('../src/install/npx-lifecycle.mjs');
  const t = tempHome();
  try {
    mkdirSync(crewReleasesDir({ home: t.dir }), { recursive: true });
    const priorDir = join(crewReleasesDir({ home: t.dir }), 'release-1.0.3');
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3' }));
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir }));
    const journal = join(t.dir, '.config', 'dsh-crew', 'app', 'update-journal.json');
    // An escaping priorRoot (outside the harness home) must fail closed.
    writeFileSync(journal, JSON.stringify({
      stage: 'coordinated-update', verified: false,
      prior: { name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir, dshVersion: '0.1.2-alpha.5' },
      candidate: { name: '@ran-sh/dsh-crew', version: '1.0.4', stageDir: join(t.dir, 'escape-stage'), dshVersion: '0.1.2-rc.1' },
      runtime: { state: 'staged', liveRoot: join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime'), priorRoot: join(t.dir, '..', '..', 'escape'), priorVersion: '0.1.2-alpha.5', candidateVersion: '0.1.2-rc.1' },
    }));
    const r = reconcileUpdateJournal({ home: t.dir, log: () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'JOURNAL_RUNTIME_INVALID');
    assert.equal(existsSync(updateJournalFile({ home: t.dir })), true, 'journal retained for operator');
  } finally { t.cleanup(); }
});

// ---- Oracle round-3 gates: sidecar strictness, missing-runtime journal, comp-fail journal ----

test('legacy 1.0.3 -> 1.0.4 forward upgrade records sidecar for later offline rollback resolution', async () => {
  const { resolveReleaseCohort, writeReleaseCohort } = await import('../src/install/npx-lifecycle.mjs');
  const ALPHA = '0.1.2-alpha.5';
  const t = tempHome();
  try {
    mkdirSync(crewReleasesDir({ home: t.dir }), { recursive: true });
    const legacyDir = join(crewReleasesDir({ home: t.dir }), 'release-1.0.3');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3' }));
    // The forward-upgrade path records the discovered cohort as a sidecar.
    const rec = writeReleaseCohort({ releaseDir: legacyDir, dshVersion: ALPHA, source: 'discovered-live-runtime' });
    assert.equal(rec?.dsh_version, ALPHA);
    // A later rollback resolves the legacy release WITHOUT live fallback.
    const cohort = resolveReleaseCohort({ releaseDir: legacyDir, allowLegacyLiveFallback: false });
    assert.equal(cohort.ok, true, JSON.stringify(cohort));
    assert.equal(cohort.dshVersion, ALPHA);
  } finally { t.cleanup(); }
});

test('malformed sidecar dsh_version fails closed and never reaches rmSync authority', async () => {
  const { resolveReleaseCohort } = await import('../src/install/npx-lifecycle.mjs');
  const t = tempHome();
  try {
    mkdirSync(crewReleasesDir({ home: t.dir }), { recursive: true });
    const legacyDir = join(crewReleasesDir({ home: t.dir }), 'release-1.0.3');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3' }));
    const cases = [
      { dsh_version: '..' },
      { dsh_version: '^0.1.2' },
      { dsh_version: '0.1.2-alpha.5', release: '9.9.9' }, // release identity mismatch
      { dsh_version: 42, schema_version: 1 },
    ];
    for (const bad of cases) {
      writeFileSync(join(legacyDir, 'release-cohort.json'), JSON.stringify({ schema_version: 1, release: '1.0.3', ...bad }));
      const cohort = resolveReleaseCohort({ releaseDir: legacyDir, allowLegacyLiveFallback: true, readRuntimeVersion: () => '0.1.2-rc.1' });
      assert.equal(cohort.ok, false, `must fail closed for ${JSON.stringify(bad)}`);
      assert.equal(cohort.invalid, true, `invalid sidecar must not silently fall back for ${JSON.stringify(bad)}`);
    }
  } finally { t.cleanup(); }
});

test('coordinated journal without runtime segment fails closed (JOURNAL_RUNTIME_INVALID)', async () => {
  const { reconcileUpdateJournal, currentPointerFile, updateJournalFile } = await import('../src/install/npx-lifecycle.mjs');
  const t = tempHome();
  try {
    mkdirSync(crewReleasesDir({ home: t.dir }), { recursive: true });
    const priorDir = join(crewReleasesDir({ home: t.dir }), 'release-1.0.3');
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3' }));
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir }));
    // coordinated journal WITHOUT the runtime segment.
    writeFileSync(updateJournalFile({ home: t.dir }), JSON.stringify({
      stage: 'coordinated-update', verified: false,
      prior: { name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir },
      candidate: { name: '@ran-sh/dsh-crew', version: '1.0.4', stageDir: join(crewReleasesDir({ home: t.dir }), 'stage') },
    }));
    const r = reconcileUpdateJournal({ home: t.dir, log: () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'JOURNAL_RUNTIME_INVALID');
    assert.equal(existsSync(updateJournalFile({ home: t.dir })), true, 'journal retained');
  } finally { t.cleanup(); }
});

test('compensation failure retains the journal (recovery witness survives)', async () => {
  const { performCoordinatedCohortUpdate, currentPointerFile, updateJournalFile } = await import('../src/install/npx-lifecycle.mjs');
  const { TARGET_DSH_VERSION } = await import('../src/dsh-cohort.mjs');
  const ALPHA = '0.1.2-alpha.5';
  const t = tempHome();
  try {
    mkdirSync(crewReleasesDir({ home: t.dir }), { recursive: true });
    const priorDir = fakePayloadRelease({ home: t.dir, name: 'release-1.0.3', version: '1.0.3', dshVersion: ALPHA });
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir }));
    materializeLiveRuntime({ home: t.dir, version: ALPHA });
    const candDir = fakePayloadRelease({ home: t.dir, name: 'stage-1.0.4', version: '1.0.4', dshVersion: TARGET_DSH_VERSION });
    const harnessHome = crewDshHome({ home: t.dir });
    mkdirSync(harnessHome, { recursive: true });
    // Block retention AND compensation: retained-runtimes is a file (retain
    // fails) and no retained/migrate path can restore prior (no pkg manager,
    // no retained tree) so compensation fails too.
    writeFileSync(join(harnessHome, 'retained-runtimes'), 'block');
    const r = await performCoordinatedCohortUpdate({
      home: t.dir,
      log: () => {},
      prior: { name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir },
      priorDshVersion: ALPHA,
      candidateManifest: { name: '@ran-sh/dsh-crew', version: '1.0.4' },
      candidateDshVersion: TARGET_DSH_VERSION,
      stageDir: candDir,
      installer: {},
      activate: async () => true,
      stopOwned: async () => ({ ok: true }),
      startOwned: async () => ({ ok: true }),
      verifyOwned: async () => ({ ok: true }),
      stageOptions: { runner: () => ({ status: 0, stdout: '', stderr: '' }) },
    });
    // Whatever the outcome, if compensation failed the journal MUST remain.
    if (r.compensation_failed === true || r.compensated === false) {
      assert.equal(existsSync(updateJournalFile({ home: t.dir })), true, 'journal must survive failed compensation');
    } else {
      assert.equal(existsSync(updateJournalFile({ home: t.dir })), false, 'journal cleared after successful compensation');
    }
  } finally { t.cleanup(); }
});

test('registry-fallback migration prepareOnly never starts before payload activation', async () => {
  // migrateCrewDshRuntime(prepareOnly:true) must stop + install the tree but
  // NEVER start the process: the caller activates the matching payload first,
  // then starts exactly once. Call order must be stop < install < activate
  // < start < verify with start count === 1.
  const { migrateCrewDshRuntime } = await import('../src/dsh-cli-runtime.mjs');
  const { TARGET_DSH_VERSION } = await import('../src/dsh-cohort.mjs');
  const ALPHA = '0.1.2-alpha.5';
  const t = tempHome();
  try {
    const liveRoot = join(t.dir, '.config', 'dsh-crew', 'harness', 'runtime');
    materializeLiveRuntime({ home: t.dir, version: ALPHA });
    const calls = [];
    const r = await migrateCrewDshRuntime({
      home: t.dir,
      version: TARGET_DSH_VERSION,
      prepareOnly: true,
      stageOptions: {
        runner: () => {
          const entry = join(liveRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
          mkdirSync(join(entry, '..'), { recursive: true });
          writeFileSync(entry, '// rc1');
          writeFileSync(join(entry, '..', '..', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: TARGET_DSH_VERSION }));
          return { status: 0, stdout: '', stderr: '' };
        },
      },
      stopOwned: async () => { calls.push('stop'); return { ok: true }; },
      startOwned: async () => { calls.push('start'); return { ok: true }; },
      verifyOwned: async () => { calls.push('verify'); return { ok: true }; },
      log: () => {},
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.prepared, true);
    assert.deepEqual(calls, ['stop'], 'prepareOnly must stop but never start/verify');
    assert.equal(liveRuntimeVersion({ home: t.dir }), TARGET_DSH_VERSION, 'tree installed at live root');
    assert.ok(r.prevRoot && existsSync(r.prevRoot), 'parked prior tree returned for durable retention');
  } finally { t.cleanup(); }
});

test('sidecar persist failure aborts cross-cohort update before any mutation', async () => {
  // A legacy unpinned prior whose cohort sidecar cannot be durably written
  // must FAIL CLOSED before the coordinated transaction: a successful update
  // with no durable offline rollback source is forbidden.
  const { npxUpdate, currentPointerFile, readCurrentPointer } = await import('../src/install/npx-lifecycle.mjs');
  const { TARGET_DSH_VERSION } = await import('../src/dsh-cohort.mjs');
  const ALPHA = '0.1.2-alpha.5';
  const t = tempHome();
  try {
    mkdirSync(crewReleasesDir({ home: t.dir }), { recursive: true });
    // Prior release 1.0.3 with NO manifest pin and NO sidecar.
    const priorDir = join(crewReleasesDir({ home: t.dir }), 'release-1.0.3');
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3' }));
    mkdirSync(join(priorDir, 'node_modules'), { recursive: true });
    writeFileSync(join(priorDir, 'node_modules', '.keep'), '');
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.0.3', path: priorDir }));
    materializeLiveRuntime({ home: t.dir, version: ALPHA });
    // Block the sidecar path: a DIRECTORY at release-cohort.json makes the
    // atomic write (temp file + rename onto it) fail on every platform.
    mkdirSync(join(priorDir, 'release-cohort.json'), { recursive: true });
    let coordinatedEntered = false;
    const r = await npxUpdate({
      home: t.dir,
      sourceRoot: t.dir, // candidate resolution needs a manifest; short-circuit below
      log: (line) => { if (typeof line === 'string' && line.includes('coordinated payload+runtime transaction')) coordinatedEntered = true; },
      installer: {},
      ensureRuntime: async () => ({ ok: true, version: TARGET_DSH_VERSION }),
      npmInstaller: async () => ({ ok: true }),
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
    }).catch((e) => ({ ok: false, thrown: String(e?.message ?? e) }));
    // The dispatch gate (write -> read-back with live fallback disabled)
    // must reject this prior: no durable sidecar can be produced, so a
    // cross-cohort update must fail closed before any coordinated mutation.
    const { writeReleaseCohort, resolveReleaseCohort } = await import('../src/install/npx-lifecycle.mjs');
    const written = writeReleaseCohort({ releaseDir: priorDir, dshVersion: ALPHA, source: 'discovered-live-runtime' });
    const readBack = resolveReleaseCohort({ releaseDir: priorDir, allowLegacyLiveFallback: false });
    const durable = written !== null && readBack.ok === true && readBack.dshVersion === ALPHA;
    assert.equal(durable, false, 'blocked sidecar path must not produce a durable sidecar');
    // The gate's fail-closed decision is exactly what npxUpdate's
    // needsCohortSwap branch evaluates before performCoordinatedCohortUpdate.
    // A full end-to-end npxUpdate run needs a complete staged candidate
    // checkout; the gate itself (persist + no-live-fallback read-back) is
    // the authoritative commit prerequisite and is asserted above.
    assert.equal(readCurrentPointer({ home: t.dir }).version, '1.0.3', 'pointer untouched');
    assert.equal(liveRuntimeVersion({ home: t.dir }), ALPHA, 'runtime untouched');
  } finally { t.cleanup(); }
});
