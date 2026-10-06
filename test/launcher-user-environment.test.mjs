import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launcherSandboxEnv } from './launcher-test-env.mjs';

const maybe = process.platform === 'win32' ? test : test.skip;
const helper = fileURLToPath(new URL('../windows/start-dsh-crew.ps1', import.meta.url));

function runLauncherScript(body) {
  const script = [`. '${helper.replaceAll("'", "''")}'`, body].join('\n');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: launcherSandboxEnv(),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

// The Hub resolves its env: credential references from its own environment, so a
// launcher started outside a logon session (a terminal, a scheduled task, an agent
// shell) must merge the operator's persisted user scope back in — otherwise the Hub
// boots healthy and only the first job fails, with CREDENTIAL_MISSING.
maybe('persisted user scope fills only what the launch environment is missing', () => {
  const result = runLauncherScript([
    "$script:pathBefore = $env:Path",
    "$script:tempBefore = $env:TEMP",
    // A skip-list name that is genuinely absent here, so the skip is what excludes it.
    "[Environment]::SetEnvironmentVariable('ComSpec', $null, 'Process')",
    "function Get-PersistedUserEnvironment { return @{ 'CREW_TEST_PERSISTED' = 'persisted-secret'; 'CREW_TEST_PRESENT' = 'from-registry'; 'Path' = 'user-only-path'; 'ComSpec' = 'registry-cmd'; 'TEMP' = 'user-temp' } }",
    "$env:CREW_TEST_PRESENT = 'explicit-wins'",
    "$added = @(Import-PersistedUserEnvironment)",
    "$captured = [pscustomobject]@{",
    "  added = @($added)",
    "  persisted = $env:CREW_TEST_PERSISTED",
    "  present = $env:CREW_TEST_PRESENT",
    "  comspec = [Environment]::GetEnvironmentVariable('ComSpec', 'Process')",
    "  pathUnchanged = ($env:Path -eq $script:pathBefore)",
    "  tempUnchanged = ($env:TEMP -eq $script:tempBefore)",
    "}",
    "Remove-ImportedUserEnvironment -Names $added",
    "$captured | Add-Member -NotePropertyName persistedAfterRestore -NotePropertyValue ([Environment]::GetEnvironmentVariable('CREW_TEST_PERSISTED', 'Process'))",
    "$captured | Add-Member -NotePropertyName presentAfterRestore -NotePropertyValue $env:CREW_TEST_PRESENT",
    "$captured | ConvertTo-Json -Depth 5 -Compress",
  ].join('\n'));

  assert.deepEqual(result.added, ['CREW_TEST_PERSISTED']);
  assert.equal(result.persisted, 'persisted-secret');
  // An explicitly exported value is never overwritten by the registry.
  assert.equal(result.present, 'explicit-wins');
  // Skip list: the user-scope Path is one fragment of a real logon PATH.
  assert.equal(result.comspec, null);
  assert.equal(result.pathUnchanged, true);
  assert.equal(result.tempUnchanged, true);
  // The merge is scoped to the launch it wraps.
  assert.equal(result.persistedAfterRestore, null);
  assert.equal(result.presentAfterRestore, 'explicit-wins');
});

maybe('the Crew service is started with the persisted credential and the launcher env is restored', () => {
  const result = runLauncherScript([
    "$script:captured = @()",
    "function Get-PersistedUserEnvironment { return @{ 'CREW_TEST_PERSISTED' = 'persisted-secret' } }",
    "function Write-LaunchLog { param($Message,$Level) }",
    "function Assert-HistoryStartAllowed { }",
    "function Write-OwnedServiceRecord { param($Service) }",
    "function Start-Process { param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError) $script:captured += [pscustomobject]@{ persisted = [Environment]::GetEnvironmentVariable('CREW_TEST_PERSISTED','Process'); dshHome = $env:DSH_HOME }; return [pscustomobject]@{ Id = 4242; StartTime = [datetime]::UtcNow } }",
    "$env:DSH_HOME = 'launcher-original-home'",
    "$service = [pscustomobject]@{ Name = 'Crew backend'; Profile = 'dsh-crew'; Home = 'crew-home'; Port = 3210; Url = 'http://127.0.0.1:3210'; CrewOwned = $true; State = 'pending'; Process = $null; RootPid = $null; RootStartedAtUtcTicks = $null; ListenerPid = $null; ListenerStartedAtUtcTicks = $null; ConsecutiveFailures = 0; LastError = $null }",
    "Start-CrewService -Service $service",
    "$out = [pscustomobject]@{",
    "  captured = @($script:captured)",
    "  persistedAfter = [Environment]::GetEnvironmentVariable('CREW_TEST_PERSISTED','Process')",
    "  dshHomeAfter = $env:DSH_HOME",
    "}",
    "$out | ConvertTo-Json -Depth 5 -Compress",
  ].join('\n'));

  assert.equal(result.captured.length, 1);
  // The child the launcher starts receives the credential it would otherwise lack.
  assert.equal(result.captured[0].persisted, 'persisted-secret');
  // DSH_HOME still belongs to the service, not the launcher, and is restored after.
  assert.equal(result.captured[0].dshHome, 'crew-home');
  assert.equal(result.dshHomeAfter, 'launcher-original-home');
  assert.equal(result.persistedAfter, null);
});
