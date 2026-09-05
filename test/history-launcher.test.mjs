import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const helper = fileURLToPath(new URL('../windows/start-dsh-crew.ps1', import.meta.url));
test('supervisor checks history recovery state before launching 3210', () => {
  assert.match(readFileSync(helper, 'utf8'), /function Start-CrewService\s*\{\s*param\([^\n]*\)\s*Assert-HistoryStartAllowed/);
});
(process.platform === 'win32' ? test : test.skip)('unsafe and malformed history states prevent startup; verified transitions may start', t => {
  const root = mkdtempSync(join(tmpdir(), 'history-start-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'active.json');
  for (const phase of ['QUEUED', 'STOPPING', 'APPLYING', 'RECOVERY_REQUIRED', 'unknown', 'STARTING', 'VERIFYING', 'DONE', 'FAILED', 'ROLLED_BACK']) {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, phase }));
    const script = `. '${helper.replaceAll("'", "''")}'; try { Assert-HistoryStartAllowed -StatePath '${file.replaceAll("'", "''")}'; 'allowed' } catch { 'blocked' }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, DSH_CREW_LAUNCHER_TEST_IMPORT: '1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), ['STARTING', 'VERIFYING', 'DONE', 'FAILED', 'ROLLED_BACK'].includes(phase) ? 'allowed' : 'blocked');
  }
});

test('native Crew panel includes history controls without adding them to the official quick panel', () => {
  const full = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8');
  const quick = readFileSync(new URL('../src/client/quick-panel.tsx', import.meta.url), 'utf8');
  assert.match(full, /<HistoryPanel/);
  assert.doesNotMatch(quick, /HistoryPanel/);
});
