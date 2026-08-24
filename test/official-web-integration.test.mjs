import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OFFICIAL_BRIDGE_PACKAGE,
  ensureOfficialWebIntegration,
  officialWebIntegrationStateFile,
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

test('integration adds only the lightweight bridge, preserves official state, and is idempotent', () => {
  const t = fixture();
  try {
    const first = ensureOfficialWebIntegration({ home: t.home, releaseDir: t.releaseDir });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.changed, true);
    const official = JSON.parse(readFileSync(join(t.profileRoot, 'package.json'), 'utf8'));
    assert.equal(official.dependencies['keep-me'], '7.0.0');
    assert.equal(official.custom.untouched, true);
    assert.equal(official.dependencies['@ran-sh/dsh-crew'], undefined, 'full Hub must stay out of official web');
    assert.match(official.dependencies[OFFICIAL_BRIDGE_PACKAGE], /^link:/);
    assert.equal(official.dsh.profile.bundles.filter((name) => name === OFFICIAL_BRIDGE_PACKAGE).length, 1);
    assert.equal(realpathSync(first.linkPath), realpathSync(t.bridgeRoot));
    assert.equal(existsSync(first.backupFile), true);
    const state = JSON.parse(readFileSync(officialWebIntegrationStateFile({ home: t.home }), 'utf8'));
    assert.equal(state.enabled, true);
    assert.equal(state.release_dir, realpathSync(t.releaseDir));

    const second = ensureOfficialWebIntegration({ home: t.home, releaseDir: t.releaseDir });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.changed, false);
    assert.equal(second.backupFile, first.backupFile);
    assert.equal(officialWebIntegrationStatus({ home: t.home, releaseDir: t.releaseDir }).healthy, true);
  } finally { t.cleanup(); }
});

test('integration fails closed for malformed or missing official profiles', () => {
  const malformed = fixture();
  try {
    writeFileSync(join(malformed.profileRoot, 'package.json'), '{broken');
    const before = readFileSync(join(malformed.profileRoot, 'package.json'), 'utf8');
    const result = ensureOfficialWebIntegration({ home: malformed.home, releaseDir: malformed.releaseDir });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'OFFICIAL_WEB_PROFILE_INVALID');
    assert.equal(readFileSync(join(malformed.profileRoot, 'package.json'), 'utf8'), before);
    assert.equal(existsSync(officialWebIntegrationStateFile({ home: malformed.home })), false);
  } finally { malformed.cleanup(); }
});

test('detach removes only the bridge and keeps the opt-out state for later updates', () => {
  const t = fixture();
  try {
    const installed = ensureOfficialWebIntegration({ home: t.home, releaseDir: t.releaseDir });
    const removed = removeOfficialWebIntegration({ home: t.home });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(removed.removed, true);
    const official = JSON.parse(readFileSync(join(t.profileRoot, 'package.json'), 'utf8'));
    assert.equal(official.dependencies[OFFICIAL_BRIDGE_PACKAGE], undefined);
    assert.equal(official.dependencies['keep-me'], '7.0.0');
    assert.equal(official.dsh.profile.bundles.includes(OFFICIAL_BRIDGE_PACKAGE), false);
    assert.equal(existsSync(installed.linkPath), false);
    const state = JSON.parse(readFileSync(officialWebIntegrationStateFile({ home: t.home }), 'utf8'));
    assert.equal(state.enabled, false);
    assert.equal(officialWebIntegrationStatus({ home: t.home }).enabled, false);
  } finally { t.cleanup(); }
});
