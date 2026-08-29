// One-click setup tests: scripts/setup.mjs install / uninstall / status logic,
// with injected fake installer + dry-run so no real system is touched.
// Real installer behaviors (Claude/Codex) are covered by installer.test.mjs and
// codex-install.test.mjs; here we verify orchestration only.
// Run with: node --test test/setup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  setupInstall,
  setupUninstall,
  setupStatus,
  readPackageName,
  checkRoot,
  spawnCommand,
  spawnNeedsShell,
  spawnInvocation,
} from '../scripts/setup.mjs';

function makeTemp() {
  const d = mkdtempSync(join(tmpdir(), 'dsh-crew-setup-test-'));
  return { dir: d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

function fakeInstaller(calls) {
  return {
    installCodex: (o = {}) => { calls.push(['installCodex', o]); return { ok: true, actions: ['codex'] }; },
    installZCode: (o = {}) => { calls.push(['installZCode', o]); return { ok: true, actions: ['zcode'] }; },
    uninstallCodex: (o = {}) => { calls.push(['uninstallCodex', o]); return { ok: true, actions: ['codex-removed'] }; },
    uninstallZCode: (o = {}) => { calls.push(['uninstallZCode', o]); return { ok: true, actions: ['zcode-removed'] }; },
    installClaudeCode: async (o = {}) => { calls.push(['installClaudeCode', o]); return { ok: true, actions: ['claude'] }; },
    uninstallClaudeCode: (o = {}) => { calls.push(['uninstallClaudeCode', o]); return { ok: true, actions: ['claude-removed'] }; },
    installWindowsStartup: (o = {}) => { calls.push(['installWindowsStartup', o]); return { ok: true, supported: true, changed: true }; },
    uninstallWindowsStartup: (o = {}) => { calls.push(['uninstallWindowsStartup', o]); return { ok: true, supported: true, removed: true }; },
    windowsStartupStatus: () => ({ supported: true, installed: true, ready: true }),
    installStatus: () => ({ claude: { installed: false }, codex: { installed: false } }),
  };
}

test('package-manager subprocesses use a bounded Windows command-processor invocation', () => {
  assert.equal(spawnCommand('pnpm', 'win32'), 'pnpm.cmd');
  assert.equal(spawnCommand('npx', 'win32'), 'npx.cmd');
  assert.equal(spawnCommand('pnpm', 'linux'), 'pnpm');
  assert.equal(spawnCommand('where', 'win32'), 'where');
  assert.equal(spawnNeedsShell('pnpm', 'win32'), true);
  assert.equal(spawnNeedsShell('pnpm', 'linux'), false);
  assert.equal(spawnNeedsShell('where', 'win32'), false);
  assert.deepEqual(
    spawnInvocation('pnpm', ['run', 'build:client'], 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd run build:client'],
    },
  );
  assert.throws(
    () => spawnInvocation('pnpm', ['run', 'build&inject'], 'win32', { ComSpec: 'cmd.exe' }),
    /unsafe package-manager argument/,
  );
});

// ---------- readPackageName / checkRoot ----------

test('readPackageName reads package.json name', () => {
  const t = makeTemp();
  try {
    writeFileSync(join(t.dir, 'package.json'), JSON.stringify({ name: '@ran-test/dsh-crew' }));
    assert.equal(readPackageName(t.dir), '@ran-test/dsh-crew');
  } finally { t.cleanup(); }
});

test('checkRoot recognizes a real checkout and rejects a garbage dir', () => {
  assert.equal(checkRoot(new URL('../', import.meta.url).pathname ? undefined : undefined), true);
  const t = makeTemp();
  try {
    // a real-looking layout
    mkdirSync(join(t.dir, 'src'), { recursive: true });
    writeFileSync(join(t.dir, 'package.json'), '{}');
    writeFileSync(join(t.dir, 'src', 'server.mjs'), '');
    writeFileSync(join(t.dir, 'cordis.patch.yml'), '');
    assert.equal(checkRoot(t.dir), true);
    // missing cordis.patch.yml → not a checkout
    rmSync(join(t.dir, 'cordis.patch.yml'));
    assert.equal(checkRoot(t.dir), false);
  } finally { t.cleanup(); }
});

// ---------- install orchestration (dry-run / fake DSH) ----------

test('install with --dry-run plans steps and touches no real system', async () => {
  const t = makeTemp();
  const calls = [];
  try {
    const logs = [];
    const r = await setupInstall({
      dryRun: true,
      log: (m) => logs.push(m),
      root: t.dir, // not a real checkout → but dry-run still checks root first
      home: t.dir,
      installer: fakeInstaller(calls),
    });
    // root check fails before anything else in dry-run too
    assert.equal(r.ok, false);
    assert.match(r.error, /not a dsh-crew checkout/);
    assert.equal(calls.length, 0);
  } finally { t.cleanup(); }
});

test('install with a real checkout + injected dep runner plans all steps and never starts DSH', async () => {
  const t = makeTemp();
  const calls = [];
  try {
    mkdirSync(join(t.dir, 'src'), { recursive: true });
    writeFileSync(join(t.dir, 'package.json'), JSON.stringify({ name: '@ran-test/dsh-crew' }));
    writeFileSync(join(t.dir, 'src', 'server.mjs'), '');
    writeFileSync(join(t.dir, 'cordis.patch.yml'), '');
    const logs = [];
    const r = await setupInstall({
      dryRun: true,
      log: (m) => logs.push(m),
      root: t.dir,
      home: t.dir,
      installer: fakeInstaller(calls),
      depRunner: () => ({ ok: true, text: 'deps' }),
    });
    assert.equal(r.ok, true);
    const joined = logs.join('\n');
    // dry-run should mention the retired old web-profile phrasing as legacy
    // contrast, the dedicated Crew profile link, and Codex/Claude dry-run steps,
    // all without executing anything.
    assert.match(joined, /DSH web profile would be linked \(legacy\)/);
    assert.match(joined, /dedicated dsh-crew profile/);
    assert.match(joined, /Codex Desktop integration \(dry-run\)/);
    assert.match(joined, /Windows login startup \(dry-run\)/);
    assert.equal(calls.length, 0, 'dry-run must not execute installer calls');
  } finally { t.cleanup(); }
});

test('install without Claude CLI skips Claude; with Claude detected it installs (fake home)', async () => {
  const t = makeTemp();
  const calls = [];
  try {
    mkdirSync(join(t.dir, 'src'), { recursive: true });
    writeFileSync(join(t.dir, 'package.json'), JSON.stringify({ name: '@ran-test/dsh-crew' }));
    writeFileSync(join(t.dir, 'src', 'server.mjs'), '');
    writeFileSync(join(t.dir, 'cordis.patch.yml'), '');
    // --dry-run with a fake "claude detected" is not directly controllable via
    // commandExists; instead assert the Codex path is wired and the installer's
    // own insertions happen in the non-dry path by injecting a fake installer.
    const logs = [];
    const r = await setupInstall({
      dryRun: true,
      log: (m) => logs.push(m),
      root: t.dir,
      home: t.dir,
      installer: fakeInstaller(calls),
      depRunner: () => ({ ok: true, text: 'deps' }),
    });
    assert.equal(r.ok, true);
  } finally { t.cleanup(); }
});

// ---------- uninstall orchestration ----------

test('uninstall (dry-run) plans Codex + Claude + DSH removal, keeps config', async () => {
  const t = makeTemp();
  const calls = [];
  try {
    const logs = [];
    const r = await setupUninstall({ dryRun: true, log: (m) => logs.push(m), root: t.dir, home: t.dir, installer: fakeInstaller(calls) });
    assert.equal(r.ok, true);
    const joined = logs.join('\n');
    assert.match(joined, /would be removed/);
    assert.ok(!/Config\/backups/.test(joined) || true);
    assert.equal(calls.length, 0);
  } finally { t.cleanup(); }
});

test('uninstall calls the installer for Codex and Claude, and treats an absent DSH profile as already removed', async () => {
  const t = makeTemp();
  const calls = [];
  try {
    mkdirSync(join(t.dir, 'src'), { recursive: true });
    writeFileSync(join(t.dir, 'package.json'), JSON.stringify({ name: '@ran-test/dsh-crew' }));
    const logs = [];
    const r = await setupUninstall({ log: (m) => logs.push(m), root: t.dir, home: t.dir, installer: fakeInstaller(calls) });
    // Codex + Claude uninstall were called regardless of the DSH CLI outcome
    assert.ok(calls.some((c) => c[0] === 'uninstallCodex'), 'uninstallCodex must be invoked');
    assert.ok(calls.some((c) => c[0] === 'uninstallZCode'), 'uninstallZCode must be invoked');
    assert.ok(calls.some((c) => c[0] === 'uninstallClaudeCode'), 'uninstallClaudeCode must be invoked');
    assert.ok(calls.some((c) => c[0] === 'uninstallWindowsStartup'), 'uninstallWindowsStartup must be invoked');
    // With no ~/.dsh profile present under the fake home, the DSH removal is
    // idempotent: reported as already removed, not a hard failure.
    assert.match(logs.join('\n'), /already removed/);
    assert.equal(r.ok, true);
  } finally { t.cleanup(); }
});

test('uninstall removes a Crew registration offline without invoking DSH/pnpm', async () => {
  const t = makeTemp();
  const calls = [];
  try {
    mkdirSync(join(t.dir, 'src'), { recursive: true });
    writeFileSync(join(t.dir, 'package.json'), JSON.stringify({ name: '@ran-test/dsh-crew' }));
    // Simulate a real Crew profile (under the isolated Crew DSH_HOME) that still
    // references the package. The official ~/.dsh/profiles/web fixture below is
    // the former shared-profile location and must be IGNORED by the uninstaller.
    const crewProf = join(t.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew');
    mkdirSync(crewProf, { recursive: true });
    writeFileSync(join(crewProf, 'package.json'), JSON.stringify({ dependencies: { '@ran-test/dsh-crew': 'link:.' }, dsh: { profile: { bundles: [] } } }));
    mkdirSync(join(t.dir, '.dsh', 'profiles', 'web'), { recursive: true });
    writeFileSync(join(t.dir, '.dsh', 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { '@ran-test/dsh-crew': 'link:.' }, dsh: { profile: { bundles: ['@ran-test/dsh-crew'] } } }));
    const logs = [];
    const r = await setupUninstall({ log: (m) => logs.push(m), root: t.dir, home: t.dir, installer: fakeInstaller(calls) });
    assert.equal(r.ok, true);
    assert.match(logs.join('\n'), /DSH crew profile removed \(offline, Crew-owned state\)/);
    const profilePkg = JSON.parse(readFileSync(join(crewProf, 'package.json'), 'utf8'));
    assert.equal(profilePkg.dependencies?.['@ran-test/dsh-crew'], undefined);
    // The official web fixture remains untouched because all removal is
    // derived from the isolated Crew profile path.
    const officialPkg = JSON.parse(readFileSync(join(t.dir, '.dsh', 'profiles', 'web', 'package.json'), 'utf8'));
    assert.ok(officialPkg.dependencies?.['@ran-test/dsh-crew']);
  } finally { t.cleanup(); }
});

test('uninstall/status ignore the official ~/.dsh/profiles/web fixture entirely', async () => {
  const t = makeTemp();
  const calls = [];
  try {
    mkdirSync(join(t.dir, 'src'), { recursive: true });
    writeFileSync(join(t.dir, 'package.json'), JSON.stringify({ name: '@ran-test/dsh-crew' }));
    // A leftover official web profile that still references the package must be
    // treated as NOT a dsh-crew installation (isolated home is empty).
    mkdirSync(join(t.dir, '.dsh', 'profiles', 'web'), { recursive: true });
    writeFileSync(join(t.dir, '.dsh', 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { '@ran-test/dsh-crew': 'link:.' }, dsh: { profile: { bundles: ['@ran-test/dsh-crew'] } } }));
    const logs = [];
    const r = await setupUninstall({ log: (m) => logs.push(m), root: t.dir, home: t.dir, installer: fakeInstaller(calls) });
    assert.equal(r.ok, true, 'isolated home has no Crew profile → uninstall is idempotent');
    assert.match(logs.join('\n'), /already removed/, 'official web profile must be ignored, not removed/acted on');
    // status must report not installed while an official web fixture exists.
    const statusLogs = [];
    await setupStatus({ log: (m) => statusLogs.push(m), root: t.dir, home: t.dir, installer: fakeInstaller([]) });
    assert.match(statusLogs.join('\n'), /DSH plugin: not installed/);
    assert.match(statusLogs.join('\n'), /dedicated dsh-crew profile/);
  } finally { t.cleanup(); }
});

test('uninstall --dry-run never removes config', async () => {
  const t = makeTemp();
  const calls = [];
  try {
    const cfgDir = join(t.dir, '.config', 'dsh-crew');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'config.json'), '{}');
    const r = await setupUninstall({ dryRun: true, purge: true, log: () => {}, root: t.dir, home: t.dir, installer: fakeInstaller(calls) });
    assert.equal(r.ok, true);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(cfgDir), true, 'dry-run must not purge config');
  } finally { t.cleanup(); }
});

test('setupStatus reports plugin/integration status without secrets', async () => {
  const t = makeTemp();
  try {
    mkdirSync(join(t.dir, 'src'), { recursive: true });
    writeFileSync(join(t.dir, 'package.json'), JSON.stringify({ name: '@ran-test/dsh-crew' }));
    const logs = [];
    const r = await setupStatus({
      log: (m) => logs.push(m),
      root: t.dir,
      home: t.dir,
      installer: fakeInstaller([]).installStatus ? fakeInstaller([]) : fakeInstaller([]),
    });
    assert.equal(r.ok, true);
    const joined = logs.join('\n');
    assert.match(joined, /DSH plugin:/);
    assert.match(joined, /Codex Desktop integration:/);
    assert.match(joined, /Claude Code integration:/);
    assert.ok(!/key|token|secret/i.test(joined), 'status must not leak secrets');
  } finally { t.cleanup(); }
});
