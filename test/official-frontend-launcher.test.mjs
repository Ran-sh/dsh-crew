import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
