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
