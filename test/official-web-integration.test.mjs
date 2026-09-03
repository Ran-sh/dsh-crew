import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OFFICIAL_BRIDGE_PACKAGE,
  OFFICIAL_WEB_READ_ONLY_CODE,
  ensureOfficialWebIntegration,
  officialWebIntegrationStatus,
  removeOfficialWebIntegration,
} from '../src/install/official-web.mjs';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-crew-official-web-'));
  const releaseDir = join(home, '.config', 'dsh-crew', 'app', 'releases', '0.3.8');
  const bridgeRoot = join(releaseDir, 'official-web-bridge');
  const profileRoot = join(home, '.dsh', 'profiles', 'web');
  mkdirSync(join(bridgeRoot, 'lib'), { recursive: true });
  mkdirSync(profileRoot, { recursive: true });
  writeFileSync(join(bridgeRoot, 'entry.mjs'), 'export async function apply() {}\n');
  writeFileSync(join(bridgeRoot, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(bridgeRoot, 'lib', 'client.js'), '// bridge client\n');
  writeFileSync(join(bridgeRoot, 'package.json'), JSON.stringify({
    name: OFFICIAL_BRIDGE_PACKAGE,
    version: '0.3.8',
    type: 'module',
    main: './entry.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { inject: ['@deepseek-ai/dsh-web:client'] } },
  }, null, 2));
  writeFileSync(join(profileRoot, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { '@deepseek-ai/dsh-web-app': '0.1.1', 'keep-me': '7.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'keep-me'] } },
    custom: { untouched: true },
  }, null, 2));
  return { home, releaseDir, bridgeRoot, profileRoot, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('integration refuses to write the read-only official profile', () => {
  const t = fixture();
  try {
    const before = readFileSync(join(t.profileRoot, 'package.json'), 'utf8');
    const first = ensureOfficialWebIntegration({ home: t.home, releaseDir: t.releaseDir });
    assert.equal(first.ok, false);
    assert.equal(first.code, OFFICIAL_WEB_READ_ONLY_CODE);
    assert.equal(readFileSync(join(t.profileRoot, 'package.json'), 'utf8'), before);
  } finally { t.cleanup(); }
});

test('integration fails closed for malformed or missing official profiles', () => {
  const malformed = fixture();
  try {
    writeFileSync(join(malformed.profileRoot, 'package.json'), '{broken');
    const before = readFileSync(join(malformed.profileRoot, 'package.json'), 'utf8');
    const result = ensureOfficialWebIntegration({ home: malformed.home, releaseDir: malformed.releaseDir });
    assert.equal(result.ok, false);
    assert.equal(result.code, OFFICIAL_WEB_READ_ONLY_CODE);
    assert.equal(readFileSync(join(malformed.profileRoot, 'package.json'), 'utf8'), before);
  } finally { malformed.cleanup(); }
});

test('detach refuses to write the read-only official profile', () => {
  const t = fixture();
  try {
    const before = readFileSync(join(t.profileRoot, 'package.json'), 'utf8');
    const removed = removeOfficialWebIntegration({ home: t.home });
    assert.equal(removed.ok, false);
    assert.equal(removed.code, OFFICIAL_WEB_READ_ONLY_CODE);
    assert.equal(readFileSync(join(t.profileRoot, 'package.json'), 'utf8'), before);
    assert.equal(officialWebIntegrationStatus({ home: t.home }).enabled, false);
  } finally { t.cleanup(); }
});
