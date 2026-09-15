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

// The window has to cover every server on the DSH home, not just the hub: the
// managed frontend on 3080 holds the same workspace store in memory and writes
// the whole file back. The launcher stops it and proves both ports free; this is
// the independent re-probe the operation runs before it trusts that.
test('a stopped window is proven by both ports, not by the launcher word', async () => {
  const { stoppedWindowIsClean } = await import('../src/history/runner.mjs');
  const session = (extra = {}) => ({ ok: true, state: 'present', session: { lease: 'L', runtime_id: 'R', ...extra } });
  const probe = free => async (port) => { if (!free.includes(port)) throw Error(`port ${port} must not be probed`); return true; };

  assert.equal(await stoppedWindowIsClean({ session: session(), lease: 'L', runtimeId: 'R', probe: probe([3210]) }), true,
    'a hub-only window does not need 3080');
  assert.equal(await stoppedWindowIsClean({ session: session({ frontend_stopped: true }), lease: 'L', runtimeId: 'R', probe: probe([3210, 3080]) }), true);
  assert.equal(await stoppedWindowIsClean({ session: session({ frontend_stopped: true }), lease: 'L', runtimeId: 'R',
    probe: async (port) => port !== 3080 }), false, 'a frontend that came back is not a clean window');
  assert.equal(await stoppedWindowIsClean({ session: { ok: true, state: 'present', session: { lease: 'other', runtime_id: 'R' } }, lease: 'L', runtimeId: 'R', probe: async () => true }), false);
  assert.equal(await stoppedWindowIsClean({ session: { ok: true, state: 'absent' }, lease: 'L', runtimeId: 'R', probe: async () => true }), false);
  assert.equal(await stoppedWindowIsClean({ session: { ok: false }, lease: 'L', runtimeId: 'R', probe: async () => true }), false);
  assert.equal(await stoppedWindowIsClean({ session: session(), lease: 'L', runtimeId: 'R', probe: async () => false }), false);
});

test('the launcher window is opt-in, recorded, and restored', () => {
  const source = readFileSync(helper, 'utf8');
  const lifecycle = readFileSync(new URL('../src/install/npx-lifecycle.mjs', import.meta.url), 'utf8');
  // Opt-in: the npx lifecycle's stop defaults the flag off, so a runtime-tree
  // swap keeps stopping only the hub.
  assert.match(lifecycle, /stopOwnedBackend: async \(\{ lease = null, runtimeId = null, refreshFrontend = false \}/);
  assert.match(lifecycle, /extra: refreshFrontend \? \{ refresh_frontend: true \} : null/);
  // The window records what it stopped, publishes STOPPED only with both, and
  // the matching start gives it back.
  assert.match(source, /frontend_stopped = \$FrontendStopped/);
  assert.match(source, /Set-MaintenanceSession \$request \$frontendStopped/);
  assert.match(source, /SUPERVISOR_FRONTEND_STOP_FAILED/);
  assert.match(source, /if \(\$restoreFrontend\) \{ Start-CrewManagedFrontendQuietly \}/);
});
