import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The launcher under test is a Windows PowerShell script driven through
// powershell.exe; there is nothing to exercise on other platforms.
const maybe = process.platform === 'win32' ? test : test.skip;

const helper = fileURLToPath(new URL('../windows/start-dsh-crew.ps1', import.meta.url));

maybe('startup health uses the lightweight runtime identity and rejects foreign responders', () => {
  const command = [
    `. '${helper.replaceAll("'", "''")}'`,
    "function Test-Path { return $true }",
    "function Get-Content { return '{\"version\":\"0.1.2-rc.1\"}' }",
    "$script:serviceName = 'dsh-crew-hub'",
    "$script:requestedUri = ''",
    "function Invoke-RestMethod { param($Uri, $TimeoutSec) $script:requestedUri = $Uri; return [pscustomobject]@{ ok=$true; service=$script:serviceName; runtime_version='1.2.0-rc.4'; dsh_version='0.1.2-rc.1'; execution_plane='hub-3210'; profile='dsh-crew'; listen_port=3210 } }",
    '$good = Get-HealthState $services[0]',
    "$script:serviceName = 'unrelated'",
    '$bad = Get-HealthState $services[0]',
    '@{ good=$good.Ready; bad=$bad.Ready; uri=$script:requestedUri } | ConvertTo-Json -Compress',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', env: { ...process.env, DSH_CREW_LAUNCHER_TEST_IMPORT: '1' }, timeout: 30_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { good: true, bad: false, uri: 'http://127.0.0.1:3210/_dsh/dsh-crew/runtime' });
});

test('daily startup never waits for the optional legacy bridge', () => {
  const source = readFileSync(helper, 'utf8');
  const main = source.slice(source.indexOf("if ($env:DSH_CREW_LAUNCHER_TEST_IMPORT"));
  assert.doesNotMatch(main, /\n\s*Write-LegacyBridgeDiagnostic\s*\n/);
});

test('watch mode publishes a starting heartbeat immediately after acquiring its mutex', () => {
  const source = readFileSync(helper, 'utf8');
  const supervisor = source.indexOf('function Start-ServiceSupervisor');
  const firstHeartbeat = source.indexOf('Write-SupervisorHeartbeat -OwnershipReady $false', supervisor);
  const healthLoop = source.indexOf('while ($true)', supervisor);
  assert.equal(supervisor >= 0 && firstHeartbeat > supervisor && firstHeartbeat < healthLoop, true);
});

function processTree({ rootTicks, listenerTicks }) {
  const quoted = helper.replaceAll("'", "''");
  const command = [
    `. '${quoted}'`,
    `$service = [pscustomobject]@{ RootPid = 10; RootStartedAtUtcTicks = ${rootTicks}; ListenerPid = 20; ListenerStartedAtUtcTicks = ${listenerTicks} }`,
    '$table = @(',
    '  [pscustomobject]@{ ProcessId = 10; ParentProcessId = 1; StartTicks = 100 },',
    '  [pscustomobject]@{ ProcessId = 20; ParentProcessId = 10; StartTicks = 200 },',
    '  [pscustomobject]@{ ProcessId = 30; ParentProcessId = 20; StartTicks = 300 },',
    '  [pscustomobject]@{ ProcessId = 40; ParentProcessId = 10; StartTicks = 400 }',
    ')',
    '$tree = @(Get-TrackedProcessTree -Service $service -ProcessTable $table | Sort-Object)',
    'ConvertTo-Json -InputObject $tree -Compress',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: { ...process.env, DSH_CREW_LAUNCHER_TEST_IMPORT: '1' },
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function supervisedServices() {
  const quoted = helper.replaceAll("'", "''");
  const command = [
    `. '${quoted}'`,
    '$summary = @($services | ForEach-Object { [pscustomobject]@{ Profile = $_.Profile; Port = $_.Port; CrewOwned = $_.CrewOwned } })',
    'ConvertTo-Json -InputObject $summary -Compress',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: { ...process.env, DSH_CREW_LAUNCHER_TEST_IMPORT: '1' },
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout.trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

function supervisorLaunchArguments() {
  const quoted = helper.replaceAll("'", "''");
  const command = [
    `. '${quoted}'`,
    "$args = @(Get-SupervisorLaunchArguments -ScriptPath 'C:\\Program Files\\DSH Crew\\start-dsh-crew.ps1')",
    'ConvertTo-Json -InputObject $args -Compress',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: { ...process.env, DSH_CREW_LAUNCHER_TEST_IMPORT: '1' },
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function untrackedListenerOwnership() {
  const quoted = helper.replaceAll("'", "''");
  const command = [
    `. '${quoted}'`,
    '$service = [pscustomobject]@{ Port = 3210; RootPid = $null; RootStartedAtUtcTicks = $null; ListenerPid = $null; ListenerStartedAtUtcTicks = $null }',
    "$port = [pscustomobject]@{ State = 'occupied'; Pid = 42; Error = $null }",
    '$table = @([pscustomobject]@{ ProcessId = 42; ParentProcessId = 1; StartTicks = 100 })',
    '$owned = Test-CrewServiceOwnership -Service $service -PortState $port -ProcessTable $table',
    'ConvertTo-Json -InputObject $owned -Compress',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: { ...process.env, DSH_CREW_LAUNCHER_TEST_IMPORT: '1' },
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

function heartbeatCompatibility() {
  const quoted = helper.replaceAll("'", "''");
  const command = [
    `. '${quoted}'`,
    '$root = Join-Path $env:TEMP ("dsh-heartbeat-test-" + [guid]::NewGuid().ToString("N"))',
    'New-Item -ItemType Directory -Path $root -Force | Out-Null',
    '$global:crewSupervisorRoot = $root',
    '$global:crewHeartbeatFile = Join-Path $root "heartbeat.json"',
    '$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    '$legacy = @{ schema_version = 1; pid = $PID; last_seen = $now; protocol_version = 1 } | ConvertTo-Json -Compress',
    'Write-Utf8NoBom -Path $global:crewHeartbeatFile -Content $legacy',
    '$legacyRecord = Get-SupervisorHeartbeatRecord',
    '$legacyIdentified = $null -ne $legacyRecord -and $legacyRecord.State -eq "legacy-v1"',
    '$legacyRejectedAsAuthority = $null -eq (Get-FreshSupervisorHeartbeat)',
    '$blocked = @{ schema_version = 1; pid = $PID; ownership_ready = $false; last_seen = $now; protocol_version = 1 } | ConvertTo-Json -Compress',
    'Write-Utf8NoBom -Path $global:crewHeartbeatFile -Content $blocked',
    '$explicitFalseRejected = $null -eq (Get-FreshSupervisorHeartbeat)',
    'Write-SupervisorHeartbeat -OwnershipReady $true',
    '$readyRecord = Get-SupervisorHeartbeatRecord',
    '$readyAttested = $readyRecord.State -eq "ready" -and $readyRecord.Record.helper_hash -match "^[a-f0-9]{64}$" -and $readyRecord.Record.supervisor_instance_id -and $readyRecord.Record.process_started_at_utc_ticks',
    'Remove-Item -LiteralPath $root -Recurse -Force',
    'ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ legacy_identified = $legacyIdentified; legacy_authority_rejected = $legacyRejectedAsAuthority; explicit_false = $explicitFalseRejected; ready_attested = [bool] $readyAttested })',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: { ...process.env, DSH_CREW_LAUNCHER_TEST_IMPORT: '1' },
    timeout: 60_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

maybe('launcher supervisor owns only the isolated 3210 service', () => {
  assert.deepEqual(supervisedServices(), [{ Profile: 'dsh-crew', Port: 3210, CrewOwned: true }]);
});

maybe('interactive launch delegates to a hidden persistent watch process', () => {
  const args = supervisorLaunchArguments();
  assert.ok(args.includes('-NoLogo'));
  assert.ok(args.includes('-NonInteractive'));
  assert.ok(args.includes('-File'));
  assert.ok(args.includes('-Mode'));
  assert.equal(args.at(-1), 'watch');
  assert.ok(args.some((value) => value.includes('C:\\Program Files\\DSH Crew\\start-dsh-crew.ps1')));
});

maybe('healthy but untracked 3210 listener is not claimed by a new supervisor', () => {
  assert.equal(untrackedListenerOwnership(), false);
});

maybe('heartbeat compatibility identifies legacy records without granting authority', () => {
  assert.deepEqual(heartbeatCompatibility(), { legacy_identified: true, legacy_authority_rejected: true, explicit_false: true, ready_attested: true });
});

maybe('tracked process tree excludes a reused wrapper PID while retaining the original listener tree', () => {
  assert.deepEqual(processTree({ rootTicks: 999, listenerTicks: 200 }), [20, 30]);
});

maybe('tracked process tree includes matching root and listener identities but excludes unrelated siblings', () => {
  assert.deepEqual(processTree({ rootTicks: 100, listenerTicks: 200 }), [10, 20, 30, 40]);
});

maybe('reused listener PID invalidates ownership entirely', () => {
  assert.deepEqual(processTree({ rootTicks: 999, listenerTicks: 999 }), []);
});
