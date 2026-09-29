import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crewDshHome } from '../src/install/install.mjs';
import { crewDshRuntimeRoot } from '../src/dsh-cli-runtime.mjs';
import { configMirrorTargets, mirrorOfficialHarnessConfig, officialConfigMirrorStatus } from '../src/install/harness-config-import.mjs';
import { DESKTOP_BRIDGE_ID, DESKTOP_BRIDGE_MARKER } from '../src/install/desktop-profile.mjs';

// The Crew hub must run the operator's own user-level configuration (models,
// providers, policy, MCP servers) instead of a blank Crew-only home. The official
// home is read-only for Crew: only Crew's own home is written, and secrets are
// never copied because provider entries reference their keys through apiKeyEnv.

const HOME_LAYER = [
  '# user patch layer for all profiles',
  '- insert:',
  '    - id: mcp-matlab',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: matlab',
  '',
].join('\n');

const MODEL_ENTRIES = [
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: commandcode',
  '    model: deepseek/deepseek-v4.1-flash',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      opencode-go-chat:',
  '        apiKeyEnv: OPENCODE_GO_API_KEY',
].join('\n');

const COHORT_FOREIGN = [
  '- id: ui-settings-account',
  '  name: "@deepseek-ai/dsh-client-ui-settings-account"',
  '  config:',
  '    purpose: both',
].join('\n');

const OWN_BLOCK = [
  `${DESKTOP_BRIDGE_MARKER}`,
  '- insert:',
  `    - id: ${DESKTOP_BRIDGE_ID}`,
  "      name: 'file:///C:/somewhere/official-web-bridge/entry.mjs'",
].join('\n');

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-config-import-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Only some packages exist in Crew's runtime cohort: that is the whole point of
// the resolution gate.
function materializeCohort(home, packages) {
  for (const name of packages) {
    const dir = join(crewDshRuntimeRoot({ home }), 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.1.6-alpha.1' }));
  }
  const dsh = join(crewDshRuntimeRoot({ home }), 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  mkdirSync(dsh, { recursive: true });
  writeFileSync(join(dsh, 'bin.js'), '// entry\n');
}

function materializeSources(home, { homeLayer = HOME_LAYER, profileLayer = `${MODEL_ENTRIES}\n${COHORT_FOREIGN}\n${OWN_BLOCK}\n` } = {}) {
  const official = join(home, '.dsh');
  mkdirSync(join(official, 'profiles', 'desktop'), { recursive: true });
  if (homeLayer !== null) writeFileSync(join(official, 'cordis.patch.yml'), homeLayer);
  if (profileLayer !== null) writeFileSync(join(official, 'profiles', 'desktop', 'cordis.patch.yml'), profileLayer);
  mkdirSync(join(crewDshHome({ home }), 'profiles', 'dsh-crew'), { recursive: true });
}

test('import mirrors resolvable entries and reports what it skipped', () => {
  const t = tempHome();
  try {
    materializeSources(t.dir);
    materializeCohort(t.dir, ['@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-llm-pi-ai']);
    const logs = [];
    const result = mirrorOfficialHarnessConfig({ home: t.dir, log: (line) => logs.push(line) });
    assert.equal(result.ok, true, result.error ?? result.code);
    assert.equal(result.changed, true);

    const targets = configMirrorTargets({ home: t.dir });
    const homeText = readFileSync(targets.homeLayer.target, 'utf8');
    assert.ok(homeText.includes('mcp-matlab'), 'the MCP insert must be mirrored');
    assert.ok(homeText.includes('by dsh-crew config import'), 'the mirror must be attributable');

    const profileText = readFileSync(targets.profileLayer.target, 'utf8');
    assert.ok(profileText.includes('agent-default-model'));
    assert.ok(profileText.includes('llm-pi-ai'));
    assert.ok(profileText.includes('apiKeyEnv: OPENCODE_GO_API_KEY'), 'provider entries keep their env reference');
    assert.equal(profileText.includes('ui-settings-account'), false, 'a cohort-foreign entry must be skipped');
    assert.equal(profileText.includes(DESKTOP_BRIDGE_ID), false, 'Crew managed blocks are never mirrored');
    assert.ok(logs.some((line) => line.includes('not-in-crew-cohort') || line.includes('is not in the Crew runtime cohort')));
    assert.ok(logs.some((line) => line.includes('Crew-managed block')));

    const skippedIds = result.layers.flatMap((layer) => layer.skipped.map((item) => item.id));
    assert.ok(skippedIds.includes('ui-settings-account'));
    assert.ok(skippedIds.includes(DESKTOP_BRIDGE_ID));
  } finally { t.cleanup(); }
});

test('import never writes into the official home', () => {
  const t = tempHome();
  try {
    materializeSources(t.dir);
    materializeCohort(t.dir, ['@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-llm-pi-ai']);
    const official = join(t.dir, '.dsh');
    const before = {
      home: readFileSync(join(official, 'cordis.patch.yml'), 'utf8'),
      profile: readFileSync(join(official, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'),
    };
    mirrorOfficialHarnessConfig({ home: t.dir, log: () => {} });
    assert.equal(readFileSync(join(official, 'cordis.patch.yml'), 'utf8'), before.home);
    assert.equal(readFileSync(join(official, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), before.profile);
  } finally { t.cleanup(); }
});

test('a second import changes nothing', () => {
  const t = tempHome();
  try {
    materializeSources(t.dir);
    materializeCohort(t.dir, ['@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-llm-pi-ai']);
    assert.equal(mirrorOfficialHarnessConfig({ home: t.dir, log: () => {} }).changed, true);
    const targets = configMirrorTargets({ home: t.dir });
    const first = { home: readFileSync(targets.homeLayer.target, 'utf8'), profile: readFileSync(targets.profileLayer.target, 'utf8') };
    const second = mirrorOfficialHarnessConfig({ home: t.dir, log: () => {} });
    assert.equal(second.changed, false);
    assert.equal(readFileSync(targets.homeLayer.target, 'utf8'), first.home);
    assert.equal(readFileSync(targets.profileLayer.target, 'utf8'), first.profile);
  } finally { t.cleanup(); }
});

test('dry-run reports the change and writes nothing', () => {
  const t = tempHome();
  try {
    materializeSources(t.dir);
    materializeCohort(t.dir, ['@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-llm-pi-ai']);
    const targets = configMirrorTargets({ home: t.dir });
    const result = mirrorOfficialHarnessConfig({ home: t.dir, dryRun: true, log: () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.dryRun, true);
    assert.equal(existsSync(targets.homeLayer.target), false);
    assert.equal(existsSync(targets.profileLayer.target), false);
  } finally { t.cleanup(); }
});

test('a missing official source is not an error', () => {
  const t = tempHome();
  try {
    materializeSources(t.dir, { homeLayer: null, profileLayer: null });
    materializeCohort(t.dir, []);
    const result = mirrorOfficialHarnessConfig({ home: t.dir, log: () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
  } finally { t.cleanup(); }
});

test('a missing Crew profile directory fails closed without writing', () => {
  const t = tempHome();
  try {
    const official = join(t.dir, '.dsh');
    mkdirSync(join(official, 'profiles', 'desktop'), { recursive: true });
    writeFileSync(join(official, 'profiles', 'desktop', 'cordis.patch.yml'), `${MODEL_ENTRIES}\n`);
    materializeCohort(t.dir, ['@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-llm-pi-ai']);
    const targets = configMirrorTargets({ home: t.dir });
    const result = mirrorOfficialHarnessConfig({ home: t.dir, log: () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CREW_HOME_LAYER_MISSING');
    assert.equal(existsSync(targets.profileLayer.target), false);
  } finally { t.cleanup(); }
});

test('status reports the mirror state of both layers', () => {
  const t = tempHome();
  try {
    materializeSources(t.dir);
    materializeCohort(t.dir, ['@deepseek-ai/dsh-mcp-client', '@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-llm-pi-ai']);
    const before = officialConfigMirrorStatus({ home: t.dir });
    assert.equal(before.home_layer.source_present, true);
    assert.equal(before.home_layer.mirrored, false);
    mirrorOfficialHarnessConfig({ home: t.dir, log: () => {} });
    const after = officialConfigMirrorStatus({ home: t.dir });
    assert.equal(after.home_layer.mirrored, true);
    assert.equal(after.profile_layer.mirrored, true);
  } finally { t.cleanup(); }
});
