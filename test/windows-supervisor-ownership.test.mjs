import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../windows/start-dsh-crew.ps1', import.meta.url));

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
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

test('tracked process tree excludes a reused wrapper PID while retaining the original listener tree', () => {
  assert.deepEqual(processTree({ rootTicks: 999, listenerTicks: 200 }), [20, 30]);
});

test('tracked process tree includes matching root and listener identities but excludes unrelated siblings', () => {
  assert.deepEqual(processTree({ rootTicks: 100, listenerTicks: 200 }), [10, 20, 30, 40]);
});

test('reused listener PID invalidates ownership entirely', () => {
  assert.deepEqual(processTree({ rootTicks: 999, listenerTicks: 999 }), []);
});
