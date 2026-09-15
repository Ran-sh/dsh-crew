import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const maybe = process.platform === 'win32' ? test : test.skip;
const helper = fileURLToPath(new URL('../windows/start-dsh-crew.ps1', import.meta.url));

function launchScenario(initial, trusted = true) {
  const script = [
    `. '${helper.replaceAll("'", "''")}'`,
    '$script:calls = @()',
    `$script:occupied = $${initial === 'occupied'}`,
    "function Resolve-OfficialHarnessCommand { return [pscustomobject]@{ NodePath='C:\\node.exe'; Entry='C:\\official\\bin.js' } }",
    "function Get-OfficialFrontendOverlay { return [pscustomobject]@{ Path='C:\\crew\\overlay.json'; Revision='test-revision' } }",
    'function Test-OfficialFrontendAttached { param($Revision) return $true }',
    "function Get-PortState { param($Port) return [pscustomobject]@{ State=$(if($script:occupied){'occupied'}else{'free'}); Pid=123; Error=$null } }",
    `function Test-OfficialHarnessListener { param($OwnerPid,$Official) return $${trusted} }`,
    'function Test-OfficialWebReady { return $true }',
    'function Write-LaunchLog { param($Message,$Level) }',
    "function Start-Process { param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError) $script:calls += [pscustomobject]@{file=$FilePath;args=$ArgumentList;style=$WindowStyle;dshHome=$env:DSH_HOME}; $script:occupied=$true; return [pscustomobject]@{Id=123;HasExited=$false} }",
    "$env:DSH_HOME='C:\\crew-home'",
    '$failed=$false; try { Open-OfficialFrontend -TimeoutSeconds 1 } catch { $failed=$true }',
    '@{calls=@($script:calls);failed=$failed;restored=$env:DSH_HOME} | ConvertTo-Json -Depth 5 -Compress',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], {
    encoding:'utf8', windowsHide:true, timeout:15000,
    env:{...process.env, DSH_CREW_LAUNCHER_TEST_IMPORT:'1'},
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

maybe('cold desktop launch uses official web CLI with isolated environment and hidden process', () => {
  const result = launchScenario('free');
  assert.equal(result.failed, false);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].file, 'C:\\node.exe');
  assert.ok(result.calls[0].args.includes('web'));
  assert.ok(result.calls[0].args.includes('3080'));
  assert.ok(result.calls[0].args.includes('--patch'));
  assert.ok(!result.calls[0].args.includes('--no-open'));
  assert.equal(result.calls[0].style, 'Hidden');
  assert.notEqual(result.calls[0].dshHome, result.restored);
  assert.equal(result.restored, 'C:\\crew-home');
});

maybe('warm desktop launch reuses official listener and only opens 3080', () => {
  const result = launchScenario('occupied');
  assert.equal(result.failed, false);
  assert.deepEqual(result.calls.map(c=>c.file), ['http://127.0.0.1:3080/']);
});

maybe('desktop launch refuses an unverified foreign 3080 listener', () => {
  const result = launchScenario('occupied', false);
  assert.equal(result.failed, true);
  assert.equal(result.calls.length, 0);
});

// The interactive entry must not wait for 3210, only for a watcher to exist.
// Shelling out to powershell.exe costs a second on its own, so these assert
// behaviour and a generous ceiling rather than exact durations.
function supervisorScenario(body) {
  const script = [
    `. '${helper.replaceAll("'", "''")}'`,
    '$script:spawned = @()',
    '$script:healthCalls = 0',
    '$script:beats = 0',
    'function Write-LaunchLog { param($Message,$Level) }',
    "function Get-SupervisorLaunchArguments { param([string] $ScriptPath) return @('-NoLogo','-File','C:\\crew\\helper.ps1','-Mode','watch') }",
    "function Start-Process { param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError) $script:spawned += [pscustomobject]@{file=$FilePath;args=$ArgumentList}; return [pscustomobject]@{Id=321;HasExited=$false} }",
    "function Get-HealthState { param($Service) $script:healthCalls++; return [pscustomobject]@{ Ready=$false; Version=$null; Error='hub not answering yet' } }",
    body,
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
    env: { ...process.env, DSH_CREW_LAUNCHER_TEST_IMPORT: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

maybe('interactive launch reuses a running supervisor without spawning or probing 3210', () => {
  const result = supervisorScenario([
    "function Get-SupervisorHeartbeatRecord { param([int] $MaxAgeSeconds = 30) return [pscustomobject]@{ State='ready'; Record=[pscustomobject]@{ pid=4242 } } }",
    '$started = Get-Date',
    '$ok = Wait-CrewSupervisorStarted -TimeoutSeconds 30',
    '@{ok=$ok;spawned=@($script:spawned).Count;health=$script:healthCalls;elapsed=((Get-Date)-$started).TotalSeconds} | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.equal(result.ok, true);
  assert.equal(result.spawned, 0);
  assert.equal(result.health, 0);
  assert.ok(result.elapsed < 5, `reused-launch took ${result.elapsed}s`);
});

maybe('interactive launch returns on the heartbeat while 3210 is still booting', () => {
  const result = supervisorScenario([
    "function Get-SupervisorHeartbeatRecord { param([int] $MaxAgeSeconds = 30) $script:beats++; if ($script:beats -ge 5) { return [pscustomobject]@{ State='starting'; Record=[pscustomobject]@{ pid=777 } } } return $null }",
    '$started = Get-Date',
    '$ok = Wait-CrewSupervisorStarted -TimeoutSeconds 30',
    '@{ok=$ok;spawned=@($script:spawned).Count;health=$script:healthCalls;beats=$script:beats;elapsed=((Get-Date)-$started).TotalSeconds} | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.equal(result.ok, true);
  assert.equal(result.spawned, 1);
  assert.ok(result.beats >= 5, `only polled ${result.beats} times`);
  // The whole point: 3210 is not up, and the launch still succeeds.
  assert.equal(result.health, 0);
  assert.ok(result.elapsed < 30, `waited ${result.elapsed}s`);
});

maybe('interactive launch gives up bounded when no supervisor ever appears', () => {
  const result = supervisorScenario([
    "function Get-SupervisorHeartbeatRecord { param([int] $MaxAgeSeconds = 30) $script:beats++; return $null }",
    '$started = Get-Date',
    '$ok = Wait-CrewSupervisorStarted -TimeoutSeconds 1',
    '@{ok=$ok;spawned=@($script:spawned).Count;elapsed=((Get-Date)-$started).TotalSeconds} | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.equal(result.ok, false);
  assert.equal(result.spawned, 1);
  assert.ok(result.elapsed >= 1 && result.elapsed < 15, `gave up after ${result.elapsed}s`);
});

maybe('the blocking entry still waits for 3210 and still reports the health error', () => {
  const result = supervisorScenario([
    "function Get-SupervisorHeartbeatRecord { param([int] $MaxAgeSeconds = 30) return [pscustomobject]@{ State='ready'; Record=[pscustomobject]@{ pid=4242 } } }",
    '$message = $null',
    'try { Ensure-CrewSupervisorRunning -TimeoutSeconds 1 } catch { $message = $_.Exception.Message }',
    '@{spawned=@($script:spawned).Count;health=$script:healthCalls;message=$message} | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.equal(result.spawned, 0);
  assert.ok(result.health > 0, 'never probed 3210');
  assert.match(result.message, /did not make 3210 ready within 1s/);
  assert.match(result.message, /hub not answering yet/);
});

maybe('both entries refuse a legacy watcher through the same guard', () => {
  const result = supervisorScenario([
    "function Get-SupervisorHeartbeatRecord { param([int] $MaxAgeSeconds = 30) return [pscustomobject]@{ State='legacy-v1'; Record=[pscustomobject]@{ pid=4242 } } }",
    '$startMessage = $null; $blockMessage = $null',
    'try { Wait-CrewSupervisorStarted -TimeoutSeconds 1 } catch { $startMessage = $_.Exception.Message }',
    'try { Ensure-CrewSupervisorRunning -TimeoutSeconds 1 } catch { $blockMessage = $_.Exception.Message }',
    '@{spawned=@($script:spawned).Count;startMessage=$startMessage;blockMessage=$blockMessage} | ConvertTo-Json -Compress',
  ].join('\n'));
  assert.equal(result.spawned, 0);
  assert.match(result.startMessage, /CREW_SUPERVISOR_UPGRADE_REQUIRED/);
  assert.equal(result.blockMessage, result.startMessage);
});

// The tests above prove the two helpers differ; this pins which one the
// interactive entry is wired to, so a later edit cannot quietly re-couple the
// desktop launch to a full 3210 boot without failing here.
maybe('the interactive entry is wired to the start-only wait', () => {
  const source = readFileSync(helper, 'utf8');
  const flow = source.slice(source.indexOf("if ($env:DSH_CREW_LAUNCHER_TEST_IMPORT"));
  assert.match(flow, /Wait-CrewSupervisorStarted/);
  assert.match(flow, /\} else \{\s*\n\s*Ensure-CrewSupervisorRunning/);
  assert.ok(flow.indexOf('Wait-CrewSupervisorStarted') < flow.indexOf('Ensure-CrewSupervisorRunning'));
});

maybe('Windows PowerShell 5.1 parses the root-array frontend overlay', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-crew-overlay-'));
  try {
    const revision = 'a'.repeat(64);
    const entry = join(home, '.config', 'dsh-crew', 'frontend', 'revisions', revision, 'official-web-bridge', 'entry.mjs');
    const overlay = join(home, '.config', 'dsh-crew', 'frontend', 'official-web.patch.json');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, 'export function apply() {}\n');
    writeFileSync(join(dirname(entry), 'package.json'), JSON.stringify({
      dshCrewManagedFrontend: true,
      dshCrewFrontendRevision: revision,
    }));
    mkdirSync(dirname(overlay), { recursive: true });
    writeFileSync(overlay, JSON.stringify([{
      insert: [{ id: 'dsh-crew-official-web-bridge', name: pathToFileURL(entry).href }],
    }]));

    const command = [
      '$env:DSH_CREW_LAUNCHER_TEST_IMPORT="1"',
      `. '${helper.replaceAll("'", "''")}'`,
      '$x=Get-OfficialFrontendOverlay',
      '@{path=$x.Path;revision=$x.Revision} | ConvertTo-Json -Compress',
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, USERPROFILE: home, DSH_CREW_LAUNCHER_TEST_IMPORT: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.path, overlay);
    assert.equal(parsed.revision, revision);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
