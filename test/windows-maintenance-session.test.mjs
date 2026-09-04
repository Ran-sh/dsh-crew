import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The launcher under test is a Windows PowerShell script driven through
// powershell.exe; there is nothing to exercise on other platforms.
const maybe = process.platform === 'win32' ? test : test.skip;

const helper = fileURLToPath(new URL('../windows/start-dsh-crew.ps1', import.meta.url));

function runPs(snippet) {
  const quoted = helper.replaceAll("'", "''");
  const command = [`. '${quoted}'`, snippet].join('\n');
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    env: { ...process.env, DSH_CREW_LAUNCHER_TEST_IMPORT: '1' },
    timeout: 20_000,
    windowsHide: true,
  });
}

maybe('maintenance session set/read-back is exact and verifiable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-maint-ps-'));
  try {
    const root = dir.replaceAll("'", "''");
    const result = runPs([
      `$script:crewSupervisorRoot = '${root}'`,
      `$script:crewMaintenanceSessionFile = Join-Path '${root}' 'maintenance-session.json'`,
      `$req = [pscustomobject]@{ lease = 'lease-1'; runtime_id = 'rid-1'; request_id = 'req-1' }`,
      `$ok = Set-MaintenanceSession $req`,
      `if (-not $ok) { throw 'set failed' }`,
      `$back = Read-MaintenanceSession`,
      `if ($back -is [string]) { throw ('unexpected tri-state: ' + $back) }`,
      `if ($back.lease -ne 'lease-1') { throw 'lease mismatch' }`,
      `if ($back.runtime_id -ne 'rid-1') { throw 'runtime mismatch' }`,
      `if ($back.request_id -ne 'req-1') { throw 'request mismatch' }`,
      `if (-not (Test-MaintenanceSessionActive)) { throw 'fence should be active' }`,
      `$cleared = Clear-MaintenanceSession`,
      `if (-not $cleared) { throw 'clear failed' }`,
      `$absent = Read-MaintenanceSession`,
      `if ($absent -ne 'ABSENT') { throw ('expected ABSENT, got ' + $absent) }`,
      `if (Test-MaintenanceSessionActive) { throw 'fence should be released' }`,
      `'MAINT_OK'`,
    ].join('\n'));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout.trim(), /MAINT_OK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

maybe('malformed session file fails closed for Crew auto-start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-maint-ps-'));
  try {
    const root = dir.replaceAll("'", "''");
    const result = runPs([
      `$script:crewSupervisorRoot = '${root}'`,
      `$script:crewMaintenanceSessionFile = Join-Path '${root}' 'maintenance-session.json'`,
      `New-Item -ItemType Directory -Path '${root}' -Force | Out-Null`,
      `Set-Content -LiteralPath (Join-Path '${root}' 'maintenance-session.json') -Value '{ broken json' -Encoding UTF8 -NoNewline`,
      `$read = Read-MaintenanceSession`,
      `if ($read -ne 'MALFORMED') { throw ('expected MALFORMED, got ' + $read) }`,
      `if (-not (Test-MaintenanceSessionActive)) { throw 'malformed session must fence auto-start' }`,
      `'MALFORMED_OK'`,
    ].join('\n'));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout.trim(), /MALFORMED_OK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

maybe('mismatched lease or runtime_id refuses maintenance-start without launching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-maint-ps-'));
  try {
    const root = dir.replaceAll("'", "''");
    const result = runPs([
      `$script:crewSupervisorRoot = '${root}'`,
      `$script:crewMaintenanceSessionFile = Join-Path '${root}' 'maintenance-session.json'`,
      `$script:crewMaintenanceRequestsDir = Join-Path '${root}' 'maintenance-requests'`,
      `$script:crewMaintenanceResultsDir = Join-Path '${root}' 'maintenance-results'`,
      `New-Item -ItemType Directory -Path (Join-Path '${root}' 'maintenance-requests') -Force | Out-Null`,
      `New-Item -ItemType Directory -Path (Join-Path '${root}' 'maintenance-results') -Force | Out-Null`,
      // A session stamped for a DIFFERENT lease/identity than the start request.
      `$session = @{ schema_version = 1; state = 'STOPPED'; lease = 'lease-good'; runtime_id = 'rid-good'; stopped_at = 1; request_id = 'req-stop' } | ConvertTo-Json -Compress`,
      `Set-Content -LiteralPath (Join-Path '${root}' 'maintenance-session.json') -Value $session -Encoding UTF8 -NoNewline`,
      `$bad = [pscustomobject]@{ schema_version = 1; request_id = 'req-start'; operation = 'maintenance-start'; lease = 'lease-WRONG'; runtime_id = 'rid-WRONG'; expires_at = 9999999999999; extra = $null }`,
      // Simulate the lease check the start branch performs (without spawning).
      `$session = Read-MaintenanceSession`,
      `$ok = ($session -isnot [string]) -and ($session.lease -eq $bad.lease) -and ($session.runtime_id -eq $bad.runtime_id)`,
      `if ($ok) { throw 'mismatched lease must be rejected' }`,
      // Matching lease+identity passes the session pairing gate.
      `$good = [pscustomobject]@{ lease = 'lease-good'; runtime_id = 'rid-good' }`,
      `$paired = ($session -isnot [string]) -and ($session.lease -eq $good.lease) -and ($session.runtime_id -eq $good.runtime_id)`,
      `if (-not $paired) { throw 'matching session must pair' }`,
      `'PAIRING_OK'`,
    ].join('\n'));
    assert.equal(result.status, 0, `${result.stdout}
${result.stderr}`);
    assert.match(result.stdout.trim(), /PAIRING_OK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

maybe('blocked supervisor root cannot fabricate a STOPPED session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-maint-ps-'));
  try {
    const root = dir.replaceAll("'", "''");
    const result = runPs([
      `$script:crewSupervisorRoot = '${root}'`,
      `$script:crewMaintenanceSessionFile = Join-Path '${root}' 'maintenance-session.json'`,
      // Block the supervisor root with a FILE so no session can persist.
      `Remove-Item -LiteralPath '${root}' -Recurse -Force -ErrorAction SilentlyContinue`,
      `Set-Content -LiteralPath '${root}' -Value 'block' -Encoding UTF8 -NoNewline`,
      `$req = [pscustomobject]@{ lease = 'lease-x'; runtime_id = 'rid-x'; request_id = 'req-x' }`,
      `$ok = Set-MaintenanceSession $req`,
      `if ($ok) { throw 'blocked root must not report success' }`,
      `'BLOCK_OK'`,
    ].join('\n'));
    assert.equal(result.status, 0, `${result.stdout}
${result.stderr}`);
    assert.match(result.stdout.trim(), /BLOCK_OK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

maybe('Invoke-CrewMaintenanceRequests rejects mismatched start without launching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-maint-ps-'));
  try {
    const root = dir.replaceAll("'", "''");
    const result = runPs([
      `$script:crewSupervisorRoot = '${root}'`,
      `$script:crewMaintenanceRequestsDir = Join-Path '${root}' 'maintenance-requests'`,
      `$script:crewMaintenanceResultsDir = Join-Path '${root}' 'maintenance-results'`,
      `$script:crewMaintenanceSessionFile = Join-Path '${root}' 'maintenance-session.json'`,
      `$script:services = @([pscustomobject]@{ Name = 'test'; CrewOwned = $true; Port = 32199; Url = 'http://127.0.0.1:32199' })`,
      `New-Item -ItemType Directory -Path (Join-Path '${root}' 'maintenance-requests') -Force | Out-Null`,
      `New-Item -ItemType Directory -Path (Join-Path '${root}' 'maintenance-results') -Force | Out-Null`,
      // A STOPPED session for lease-good/rid-good...
      `$session = @{ schema_version = 1; state = 'STOPPED'; lease = 'lease-good'; runtime_id = 'rid-good'; stopped_at = 1; request_id = 'req-stop' } | ConvertTo-Json -Compress`,
      `Set-Content -LiteralPath (Join-Path '${root}' 'maintenance-session.json') -Value $session -Encoding UTF8 -NoNewline`,
      // ...but the start request carries a WRONG lease/identity.
      `$start = @{ schema_version = 1; request_id = 'req-start'; operation = 'maintenance-start'; lease = 'lease-WRONG'; runtime_id = 'rid-WRONG'; expires_at = 9999999999999; extra = $null } | ConvertTo-Json -Compress`,
      `Set-Content -LiteralPath (Join-Path (Join-Path '${root}' 'maintenance-requests') 'req-start.json') -Value $start -Encoding UTF8 -NoNewline`,
      // Stub the launcher: any actual launch attempt throws.
      `function Start-CrewService { throw 'must not launch on mismatch' }`,
      `Invoke-CrewMaintenanceRequests`,
      `$resFile = Join-Path (Join-Path '${root}' 'maintenance-results') 'req-start.json'`,
      `if (-not (Test-Path -LiteralPath $resFile -PathType Leaf)) { throw 'result missing' }`,
      `$res = Get-Content -LiteralPath $resFile -Raw | ConvertFrom-Json`,
      `if ($res.state -ne 'SUPERVISOR_OWNERSHIP_CONFLICT') { throw ('expected conflict, got ' + $res.state) }`,
      `'HANDLER_REJECT_OK'`,
    ].join('\n'));
    assert.equal(result.status, 0, `${result.stdout}
${result.stderr}`);
    assert.match(result.stdout.trim(), /HANDLER_REJECT_OK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
