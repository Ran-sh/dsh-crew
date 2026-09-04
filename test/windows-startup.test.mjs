import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installWindowsStartup,
  uninstallWindowsStartup,
  windowsStartupStatus,
} from '../src/install/windows-startup.mjs';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-crew-startup-'));
  const root = join(home, 'payload');
  const startupDir = join(home, 'Startup');
  mkdirSync(join(root, 'windows'), { recursive: true });
  writeFileSync(join(root, 'windows', 'start-dsh-crew.cmd'), '@echo off\r\npowershell.exe -File "%~dp0start-dsh-crew.ps1" %*\r\n');
  writeFileSync(join(root, 'windows', 'start-dsh-crew.ps1'), '# DSH Crew managed Windows launcher\n# DSHCrewServiceSupervisor\nparam([string]$Mode = "open")\n');
  writeFileSync(join(root, 'windows', 'start-dsh-crew.vbs'), 'Option Explicit\n__LAUNCHER__\n--watch\n');
  return { home, root, startupDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('Windows startup install is durable, idempotent, and reports readiness', () => {
  const f = fixture();
  try {
    const first = installWindowsStartup({ home: f.home, root: f.root, startupDir: f.startupDir, platform: 'win32' });
    const second = installWindowsStartup({ home: f.home, root: f.root, startupDir: f.startupDir, platform: 'win32' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(windowsStartupStatus({ home: f.home, startupDir: f.startupDir, platform: 'win32' }).ready, true);
    assert.equal(existsSync(first.launcherFile), true);
    assert.equal(existsSync(first.helperFile), true);
    assert.equal(existsSync(first.startupFile), true);
    const startup = readFileSync(first.startupFile, 'utf16le');
    assert.match(startup, /start-dsh-crew\.cmd/);
    assert.match(startup, /--watch/);
  } finally { f.cleanup(); }
});

test('Windows startup readiness fails closed when a managed launcher asset is missing or corrupt', () => {
  const f = fixture();
  try {
    const installed = installWindowsStartup({ home: f.home, root: f.root, startupDir: f.startupDir, platform: 'win32' });
    rmSync(installed.helperFile, { force: true });
    assert.equal(windowsStartupStatus({ home: f.home, startupDir: f.startupDir, platform: 'win32' }).ready, false);

    installWindowsStartup({ home: f.home, root: f.root, startupDir: f.startupDir, platform: 'win32' });
    writeFileSync(installed.launcherFile, '');
    assert.equal(windowsStartupStatus({ home: f.home, startupDir: f.startupDir, platform: 'win32' }).ready, false);
  } finally { f.cleanup(); }
});

test('Windows startup readiness rejects marker-preserving launcher drift', () => {
  const f = fixture();
  try {
    const installed = installWindowsStartup({ home: f.home, root: f.root, startupDir: f.startupDir, platform: 'win32' });
    writeFileSync(
      installed.launcherFile,
      `${readFileSync(installed.launcherFile, 'utf8').trimEnd()}\r\nrem DSH Crew Launcher local drift\r\n`,
    );

    const status = windowsStartupStatus({ home: f.home, root: f.root, startupDir: f.startupDir, platform: 'win32' });
    assert.equal(status.installed, true);
    assert.equal(status.ready, false);
  } finally { f.cleanup(); }
});

test('Windows startup readiness rejects launcher assets installed from an older payload root', () => {
  const f = fixture();
  try {
    installWindowsStartup({ home: f.home, root: f.root, startupDir: f.startupDir, platform: 'win32' });
    const newRoot = join(f.home, 'new-payload');
    mkdirSync(join(newRoot, 'windows'), { recursive: true });
    writeFileSync(join(newRoot, 'windows', 'start-dsh-crew.cmd'), '@echo off\r\nrem payload revision new\r\npowershell.exe -File "%~dp0start-dsh-crew.ps1" %*\r\n');
    writeFileSync(join(newRoot, 'windows', 'start-dsh-crew.ps1'), '# DSH Crew managed Windows launcher\n# DSHCrewServiceSupervisor\n# payload revision new\nparam([string]$Mode = "open")\n');
    writeFileSync(join(newRoot, 'windows', 'start-dsh-crew.vbs'), "Option Explicit\n' payload revision new\n__LAUNCHER__\n--watch\n");

    const status = windowsStartupStatus({ home: f.home, root: newRoot, startupDir: f.startupDir, platform: 'win32' });
    assert.equal(status.installed, true);
    assert.equal(status.ready, false);
  } finally { f.cleanup(); }
});

test('Windows startup uninstall removes only managed files', () => {
  const f = fixture();
  try {
    mkdirSync(f.startupDir, { recursive: true });
    const keep = join(f.startupDir, 'keep-me.txt');
    writeFileSync(keep, 'keep');
    installWindowsStartup({ home: f.home, root: f.root, startupDir: f.startupDir, platform: 'win32' });
    const result = uninstallWindowsStartup({ home: f.home, startupDir: f.startupDir, platform: 'win32' });
    assert.equal(result.ok, true);
    assert.equal(existsSync(keep), true);
    assert.equal(existsSync(join(f.home, '.config', 'dsh-crew', 'launchers', 'start-dsh-crew.ps1')), false);
    assert.equal(windowsStartupStatus({ home: f.home, startupDir: f.startupDir, platform: 'win32' }).installed, false);
  } finally { f.cleanup(); }
});

test('non-Windows startup integration is an explicit no-op', () => {
  const f = fixture();
  try {
    const result = installWindowsStartup({ home: f.home, root: f.root, startupDir: f.startupDir, platform: 'linux' });
    assert.equal(result.ok, true);
    assert.equal(result.supported, false);
    assert.equal(existsSync(f.startupDir), false);
  } finally { f.cleanup(); }
});
test('Windows startup install fails closed on foreign pre-existing VBS/CMD/PS1 targets', () => {
  const f = fixture();
  try {
    const launcherDir = join(f.home, '.config', 'dsh-crew', 'launchers');
    mkdirSync(f.startupDir, { recursive: true });
    mkdirSync(launcherDir, { recursive: true });

    const startupFile = join(f.startupDir, 'DSH Crew.vbs');
    const launcherFile = join(launcherDir, 'start-dsh-crew.cmd');
    const helperFile = join(launcherDir, 'start-dsh-crew.ps1');
    const foreignStartup = 'Option Explicit\nMsgBox "foreign vbs"\n';
    const foreignLauncher = '@echo off\r\necho foreign launcher\r\n';
    const foreignHelper = 'Write-Host "foreign helper"\r\n';
    writeFileSync(startupFile, foreignStartup);
    writeFileSync(launcherFile, foreignLauncher);
    writeFileSync(helperFile, foreignHelper);

    const result = installWindowsStartup({ home: f.home, root: f.root, startupDir: f.startupDir, platform: 'win32' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STARTUP_TARGET_COLLISION');
    assert.equal(readFileSync(startupFile, 'utf8'), foreignStartup);
    assert.equal(readFileSync(launcherFile, 'utf8'), foreignLauncher);
    assert.equal(readFileSync(helperFile, 'utf8'), foreignHelper);
  } finally { f.cleanup(); }
});

test('Windows startup uninstall preserves foreign pre-existing VBS/CMD/PS1 targets', () => {
  const f = fixture();
  try {
    const launcherDir = join(f.home, '.config', 'dsh-crew', 'launchers');
    mkdirSync(f.startupDir, { recursive: true });
    mkdirSync(launcherDir, { recursive: true });

    const startupFile = join(f.startupDir, 'DSH Crew.vbs');
    const launcherFile = join(launcherDir, 'start-dsh-crew.cmd');
    const helperFile = join(launcherDir, 'start-dsh-crew.ps1');
    const foreignStartup = 'Option Explicit\nMsgBox "foreign vbs"\n';
    const foreignLauncher = '@echo off\r\necho foreign launcher\r\n';
    const foreignHelper = 'Write-Host "foreign helper"\r\n';
    writeFileSync(startupFile, foreignStartup);
    writeFileSync(launcherFile, foreignLauncher);
    writeFileSync(helperFile, foreignHelper);

    const result = uninstallWindowsStartup({ home: f.home, startupDir: f.startupDir, platform: 'win32' });
    assert.equal(result.ok, true);
    assert.equal(result.removed, false);
    assert.equal(readFileSync(startupFile, 'utf8'), foreignStartup);
    assert.equal(readFileSync(launcherFile, 'utf8'), foreignLauncher);
    assert.equal(readFileSync(helperFile, 'utf8'), foreignHelper);
  } finally { f.cleanup(); }
});

test('Windows startup uninstall still removes legacy DSH Crew VBS/CMD launcher content', () => {
  const f = fixture();
  try {
    const launcherDir = join(f.home, '.config', 'dsh-crew', 'launchers');
    mkdirSync(f.startupDir, { recursive: true });
    mkdirSync(launcherDir, { recursive: true });
    const launcherFile = join(launcherDir, 'start-dsh-crew.cmd');
    const startupFile = join(f.startupDir, 'DSH Crew.vbs');
    const keep = join(f.startupDir, 'keep-me.txt');
    writeFileSync(keep, 'keep');
    writeFileSync(launcherFile, '@echo off\r\ntitle DSH Crew Launcher\r\nset "DSH_CLI=%USERPROFILE%\\.config\\dsh-crew\\harness\\runtime\\node_modules\\.bin\\dsh.cmd"\r\n');
    writeFileSync(startupFile, `\uFEFFOption Explicit\r\nDim shell, launcher\r\nSet shell = CreateObject("WScript.Shell")\r\nlauncher = "${launcherFile}"\r\nshell.Run command, 0, False\r\n`, 'utf16le');

    const result = uninstallWindowsStartup({ home: f.home, startupDir: f.startupDir, platform: 'win32' });
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    assert.equal(existsSync(launcherFile), false);
    assert.equal(existsSync(startupFile), false);
    assert.equal(existsSync(keep), true);
  } finally { f.cleanup(); }
});
