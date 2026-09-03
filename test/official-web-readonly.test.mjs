import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OFFICIAL_WEB_READ_ONLY_CODE,
  ensureOfficialWebIntegration,
  removeOfficialWebIntegration,
  officialWebIntegrationStatus,
} from '../src/install/official-web.mjs';

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-official-ro-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedOfficialProfile(home) {
  const profileRoot = join(home, '.dsh', 'profiles', 'web');
  mkdirSync(profileRoot, { recursive: true });
  const manifest = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  };
  writeFileSync(join(profileRoot, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { profileRoot, before: readFileSync(join(profileRoot, 'package.json'), 'utf8') };
}

test('official-web ensure fails closed without touching ~/.dsh', () => {
  const t = tempHome();
  try {
    const { before } = seedOfficialProfile(t.dir);
    const result = ensureOfficialWebIntegration({ home: t.dir, releaseDir: t.dir });
    assert.equal(result.ok, false);
    assert.equal(result.code, OFFICIAL_WEB_READ_ONLY_CODE);
    const after = readFileSync(join(t.dir, '.dsh', 'profiles', 'web', 'package.json'), 'utf8');
    assert.equal(after, before);
  } finally { t.cleanup(); }
});

test('official-web remove fails closed without touching ~/.dsh', () => {
  const t = tempHome();
  try {
    const { before } = seedOfficialProfile(t.dir);
    const result = removeOfficialWebIntegration({ home: t.dir });
    assert.equal(result.ok, false);
    assert.equal(result.code, OFFICIAL_WEB_READ_ONLY_CODE);
    const after = readFileSync(join(t.dir, '.dsh', 'profiles', 'web', 'package.json'), 'utf8');
    assert.equal(after, before);
  } finally { t.cleanup(); }
});

test('official-web status stays read-only', () => {
  const t = tempHome();
  try {
    seedOfficialProfile(t.dir);
    const status = officialWebIntegrationStatus({ home: t.dir });
    assert.equal(status.enabled, false);
    assert.equal(existsSync(join(t.dir, '.config', 'dsh-crew', 'official-web.json')), false);
  } finally { t.cleanup(); }
});
