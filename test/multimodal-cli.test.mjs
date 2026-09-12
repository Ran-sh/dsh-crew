import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCli } from '../src/multimodal.mjs';

// The vision bridge shells out to a subscription CLI by bare name. Two things
// about that are easy to get wrong on Windows and both were live defects: the
// CLI is often installed without being on PATH, and the locator's first hit can
// be an npm shell shim that spawn() cannot execute.

test('a CLI that is not on PATH is still resolved from its install location', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const versioned = join(dir, 'OpenAI', 'Codex', 'bin', 'abcdef123456');
  mkdirSync(versioned, { recursive: true });
  writeFileSync(join(versioned, 'samplecli.exe'), '');

  const resolved = resolveCli('samplecli', {
    env: { LOCALAPPDATA: dir },
    exists: (p) => p === join(versioned, 'samplecli.exe'),
    locate: '__missing_locator__',
  });
  assert.equal(resolved, join(versioned, 'samplecli.exe'));
});

test('an unresolved name is returned unchanged so the spawn reports its own ENOENT', () => {
  const resolved = resolveCli('definitely-not-installed-9f3a2b', {
    env: {},
    exists: () => false,
    locate: '__missing_locator__',
  });
  assert.equal(resolved, 'definitely-not-installed-9f3a2b');
});

// where.exe can list an extensionless shim before the .cmd beside it. Taking the
// first hit resolved `claude` to a shell script and spawn failed with ENOENT even
// though the CLI was installed and working.
test('a Windows locator hit prefers something spawn can execute', () => {
  const hits = ['C:/npm/claude', 'C:/npm/claude.cmd', 'C:/npm/claude.ps1'];
  const chosen = hits.slice().sort((a, b) => {
    const rank = (p) => (/\.exe$/i.test(p) ? 0 : /\.(cmd|bat)$/i.test(p) ? 1 : 2);
    return rank(a) - rank(b);
  })[0];
  assert.equal(chosen, 'C:/npm/claude.cmd', 'the .cmd shim must beat the extensionless one');
});
