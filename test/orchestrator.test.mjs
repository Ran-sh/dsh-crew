import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOrchestrator } from '../src/orchestrator.mjs';

test('explicit host metadata wins and is normalized without probing a process', () => {
  let probed = false;
  const source = detectOrchestrator({
    env: { DSH_ORCHESTRATOR: 'ZCode' },
    readParent: () => { probed = true; return 'codex.exe'; },
  });
  assert.equal(source, 'zcode');
  assert.equal(probed, false);
});

test('host detection maps Windows and POSIX parent process names without a shell', () => {
  assert.equal(detectOrchestrator({ env: {}, platform: 'win32', parentPid: 42, readParent: ({ platform, pid }) => {
    assert.equal(platform, 'win32');
    assert.equal(pid, 42);
    return 'ZCode.exe';
  } }), 'zcode');
  assert.equal(detectOrchestrator({ env: {}, platform: 'linux', readParent: () => '/opt/codex' }), 'codex');
  assert.equal(detectOrchestrator({ env: {}, platform: 'darwin', readParent: () => 'claude' }), 'claude-code');
});

test('host detection is quiet and fail-closed when parent inspection fails', () => {
  assert.equal(detectOrchestrator({ env: { CLAUDECODE: '1' }, readParent: () => { throw new Error('unused'); } }), 'claude-code');
  assert.equal(detectOrchestrator({ env: {}, readParent: () => { throw new Error('missing'); } }), 'unknown');
  assert.equal(detectOrchestrator({ env: { DSH_ORCHESTRATOR: 'bad\nsource' }, readParent: () => '' }), 'unknown');
});
