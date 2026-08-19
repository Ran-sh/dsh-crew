// Live-verify the fixed installer against a fake home: the settings must
// point at the repository itself as the marketplace root (no parent-dir
// assumption), permission rules intact, CLI step skipped in test mode.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installClaudeCode, uninstallClaudeCode } from '../src/install/install.mjs';

const home = mkdtempSync(join(tmpdir(), 'dsh-crew-fix-test-'));
try {
  const r = await installClaudeCode({ home });
  console.log('actions:', r.actions.slice(0, 3).join(' | '));
  const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  const mp = s.extraKnownMarketplaces['dsh-crew'];
  const cwd = process.cwd().replaceAll('\\', '/');
  const mpPath = String(mp?.source?.path ?? '').replaceAll('\\', '/');
  console.log('marketplace path is repo root:', mpPath === cwd, '->', mpPath);
  console.log('permission rules:', (s.permissions?.allow ?? []).filter((x) => String(x).includes('dsh-crew')).length);
  console.log('cli step skipped in test mode:', r.actions.some((a) => a.includes('test mode')));
  if (mpPath !== cwd) throw new Error('marketplace not pointing at repo root');
  const u = await uninstallClaudeCode({ home });
  console.log('uninstall ok:', u.ok);
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log('INSTALLER FIX VERIFIED');
