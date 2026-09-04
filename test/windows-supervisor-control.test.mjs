import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const maybe = process.platform === 'win32' ? test : test.skip;
const control = fileURLToPath(new URL('../windows/supervisor-control.ps1', import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-supervisor-control-'));
  const helper = (name) => {
    const file = join(root, name, 'start-dsh-crew.ps1');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, [
      '[CmdletBinding()]',
      'param([string] $Mode = "open", [Parameter(ValueFromRemainingArguments=$true)] [string[]] $Remaining)',
      'Set-StrictMode -Version Latest',
      '$ErrorActionPreference = "Stop"',
      'while ($true) { Start-Sleep -Milliseconds 100 }',
      '',
    ].join('\r\n'), 'utf8');
    return file;
  };
  return {
    root,
    first: helper('first'),
    second: helper('second'),
    other: helper('other'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runControl(request, timeout = 60_000) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', control,
  ], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    windowsHide: true,
    timeout,
  });
  assert.equal(result.error, undefined, result.error?.message);
  const stdout = result.stdout.trim();
  let response;
  try {
    response = JSON.parse(stdout);
  } catch (error) {
    assert.fail(`control output was not one JSON value: ${error.message}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return { ...result, response };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceStop(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return;
  try { process.kill(pid); } catch { /* already stopped */ }
}

function hashOf(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function startManaged(helperPath) {
  const started = runControl({ operation: 'start', helper_path: helperPath, helper_hash: hashOf(helperPath) });
  const watcher = started.response?.watcher ?? null;
  try {
    assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
    assert.equal(started.response.ok, true, JSON.stringify(started.response));
    assert.equal(started.response.operation, 'start');
    assert.equal(watcher?.pid > 0, true);
    assert.match(watcher.process_started_at_utc_ticks, /^\d+$/u);
    assert.match(watcher.helper_hash, /^[a-f0-9]{64}$/u);
    return watcher;
  } catch (error) {
    if (Number.isInteger(watcher?.pid)) {
      try {
        const stopped = stopManaged(helperPath, watcher);
        if (stopped.response?.ok !== true) forceStop(watcher.pid);
      } catch { forceStop(watcher.pid); }
    }
    throw error;
  }
}

function inspect(helperPath, watcher, overrides = {}) {
  return runControl({
    operation: 'inspect',
    helper_path: helperPath,
    pid: watcher.pid,
    process_started_at_utc_ticks: watcher.process_started_at_utc_ticks,
    helper_hash: watcher.helper_hash,
    ...overrides,
  });
}

function stopManaged(helperPath, watcher, overrides = {}) {
  return runControl({
    operation: 'stop',
    helper_path: helperPath,
    pid: watcher.pid,
    process_started_at_utc_ticks: watcher.process_started_at_utc_ticks,
    helper_hash: watcher.helper_hash,
    ...overrides,
  });
}

maybe('start is hidden and inspect returns the exact managed watcher identity', () => {
  const f = fixture();
  let watcher;
  try {
    watcher = startManaged(f.first);
    const inspected = inspect(f.first, watcher);
    assert.equal(inspected.status, 0, `${inspected.stdout}\n${inspected.stderr}`);
    assert.deepEqual(inspected.response, {
      ok: true,
      operation: 'inspect',
      watcher,
    });

    const discovered = runControl({ operation: 'inspect', helper_path: f.first, pid: watcher.pid });
    assert.equal(discovered.status, 0, `${discovered.stdout}\n${discovered.stderr}`);
    assert.deepEqual(discovered.response.watcher, watcher);

    const source = readFileSync(control, 'utf8');
    assert.match(source, /CreateNoWindow\s*=\s*\$true/u);
    assert.match(source, /WindowStyle\s*=\s*\[System\.Diagnostics\.ProcessWindowStyle\]::Hidden/u);
  } finally {
    if (watcher) {
      const stopped = stopManaged(f.first, watcher);
      if (!stopped.response.ok) forceStop(watcher.pid);
    }
    f.cleanup();
  }
});

maybe('stop terminates only the exact watcher PID and preserves an unrelated sibling', () => {
  const f = fixture();
  let first;
  let second;
  try {
    first = startManaged(f.first);
    second = startManaged(f.second);

    const stopped = stopManaged(f.first, first);
    assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.deepEqual(stopped.response, {
      ok: true,
      operation: 'stop',
      stopped: true,
      watcher: first,
    });
    assert.equal(alive(first.pid), false, 'the selected watcher should exit');
    assert.equal(alive(second.pid), true, 'the unrelated sibling must remain alive');
    assert.equal(inspect(f.second, second).response.ok, true);
  } finally {
    if (first) forceStop(first.pid);
    if (second) {
      const stopped = stopManaged(f.second, second);
      if (!stopped.response.ok) forceStop(second.pid);
    }
    f.cleanup();
  }
});

maybe('a fully attested stale watcher remains stoppable after its stable helper file is upgraded', () => {
  const f = fixture();
  let watcher;
  try {
    watcher = startManaged(f.first);
    const oldHash = watcher.helper_hash;
    writeFileSync(f.first, [
      '[CmdletBinding()]',
      'param([string] $Mode = "open")',
      'Set-StrictMode -Version Latest',
      'while ($true) { Start-Sleep -Milliseconds 250 }',
      '',
    ].join('\r\n'), 'utf8');
    assert.notEqual(hashOf(f.first), oldHash);

    const expected = {
      pid: watcher.pid,
      process_started_at_utc_ticks: watcher.process_started_at_utc_ticks,
      helper_hash: oldHash,
    };
    const inspected = runControl({
      operation: 'inspect', helper_path: f.first, expected, allow_helper_drift: true,
    });
    assert.equal(inspected.status, 0, `${inspected.stdout}\n${inspected.stderr}`);
    assert.deepEqual(inspected.response.watcher, expected);

    const stopped = runControl({
      operation: 'stop', helper_path: f.first, expected, allow_helper_drift: true,
    });
    assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.deepEqual(stopped.response.watcher, expected);
    assert.equal(alive(watcher.pid), false);
  } finally {
    if (watcher) forceStop(watcher.pid);
    f.cleanup();
  }
});

maybe('inspect and stop fail closed on PID reuse, helper path, hash, or watch command mismatch', () => {
  const f = fixture();
  let watcher;
  let wrongMode;
  try {
    watcher = startManaged(f.first);

    const wrongTicks = inspect(f.first, watcher, {
      process_started_at_utc_ticks: (BigInt(watcher.process_started_at_utc_ticks) + 1n).toString(),
    });
    assert.equal(wrongTicks.status, 1);
    assert.equal(wrongTicks.response.code, 'PROCESS_START_TIME_MISMATCH');
    assert.equal(alive(watcher.pid), true);

    const wrongPath = inspect(f.other, watcher);
    assert.equal(wrongPath.status, 1);
    assert.equal(wrongPath.response.code, 'PROCESS_COMMAND_MISMATCH');
    assert.equal(alive(watcher.pid), true);

    const wrongHash = stopManaged(f.first, watcher, { helper_hash: '0'.repeat(64) });
    assert.equal(wrongHash.status, 1);
    assert.equal(wrongHash.response.code, 'HELPER_HASH_MISMATCH');
    assert.equal(alive(watcher.pid), true, 'hash mismatch must never stop the process');

    wrongMode = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', f.other, '-Mode', 'open',
    ], { windowsHide: true, stdio: 'ignore' });
    const wrongModeTicks = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${wrongMode.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).stdout.trim();
    const modeCheck = runControl({
      operation: 'inspect',
      helper_path: f.other,
      pid: wrongMode.pid,
      process_started_at_utc_ticks: wrongModeTicks,
    });
    assert.equal(modeCheck.status, 1);
    assert.equal(modeCheck.response.code, 'PROCESS_COMMAND_MISMATCH');
    assert.equal(alive(wrongMode.pid), true);
  } finally {
    if (watcher) {
      const stopped = stopManaged(f.first, watcher);
      if (!stopped.response.ok) forceStop(watcher.pid);
    }
    if (wrongMode) forceStop(wrongMode.pid);
    f.cleanup();
  }
});

maybe('inspect rejects a non-PowerShell executable even when its arguments imitate the watcher', () => {
  const f = fixture();
  const imposter = spawn(process.execPath, [
    '-e', 'setInterval(() => {}, 1000)',
    '--',
    '-File', f.first,
    '-Mode', 'watch',
  ], { windowsHide: true, stdio: 'ignore' });
  try {
    const ticksResult = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${imposter.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(ticksResult.status, 0, ticksResult.stderr);
    const checked = runControl({
      operation: 'inspect',
      helper_path: f.first,
      pid: imposter.pid,
      process_started_at_utc_ticks: ticksResult.stdout.trim(),
    });
    assert.equal(checked.status, 1);
    assert.equal(checked.response.code, 'PROCESS_EXECUTABLE_MISMATCH');
    assert.equal(alive(imposter.pid), true);
  } finally {
    forceStop(imposter.pid);
    f.cleanup();
  }
});

maybe('inspect rejects a PowerShell watcher command with any extra arguments', () => {
  const f = fixture();
  const extra = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', f.first, '-Mode', 'watch', '-ExtraExecution', 'unexpected',
  ], { windowsHide: true, stdio: 'ignore' });
  try {
    const ticks = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${extra.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(ticks.status, 0, ticks.stderr);
    const checked = runControl({
      operation: 'inspect',
      helper_path: f.first,
      pid: extra.pid,
      process_started_at_utc_ticks: ticks.stdout.trim(),
    });
    assert.equal(checked.status, 1);
    assert.equal(checked.response.code, 'PROCESS_COMMAND_MISMATCH');
    assert.equal(alive(extra.pid), true);
  } finally {
    forceStop(extra.pid);
    f.cleanup();
  }
});

maybe('invalid input still produces exactly one structured JSON failure', () => {
  const malformed = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', control,
  ], { input: '{broken', encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(malformed.error, undefined, malformed.error?.message);
  assert.equal(malformed.status, 1);
  assert.deepEqual(JSON.parse(malformed.stdout.trim()), {
    ok: false,
    code: 'REQUEST_JSON_INVALID',
    error: 'The stdin request is not valid JSON.',
  });

  const unsupported = runControl({ operation: 'destroy', helper_path: 'C:\\not-used\\start-dsh-crew.ps1' });
  assert.equal(unsupported.status, 1);
  assert.equal(unsupported.response.code, 'OPERATION_UNSUPPORTED');
});
