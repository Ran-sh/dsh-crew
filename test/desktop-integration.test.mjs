import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  crewBridgeEntry,
  desktopAttach,
  desktopDetach,
  desktopPatchFile,
  desktopStatus,
} from '../src/install/desktop-profile.mjs';

// The desktop app boots the app-exclusive `desktop` profile and hot-watches that
// profile's user patch layer, so the Crew panel reaches the desktop app only
// through an insert in ~/.dsh/profiles/desktop/cordis.patch.yml. That file is the
// single official-home artifact Crew may write, and only from `dsh-crew desktop`.

const REVISION = 'a'.repeat(64);
const SECOND_REVISION = 'b'.repeat(64);

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-desktop-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Materialize the overlay + snapshot the launcher itself validates.
function materializeBridge(home, revision = REVISION) {
  const frontendRoot = join(home, '.config', 'dsh-crew', 'frontend');
  const bridgeRoot = join(frontendRoot, 'revisions', revision, 'official-web-bridge');
  mkdirSync(bridgeRoot, { recursive: true });
  const entry = join(bridgeRoot, 'entry.mjs');
  writeFileSync(entry, 'export function apply() {}\n');
  writeFileSync(join(bridgeRoot, 'package.json'), JSON.stringify({
    name: '@ran-sh/dsh-crew-web-bridge',
    version: '0.3.8',
    dshCrewManagedFrontend: true,
    dshCrewFrontendRevision: revision,
  }, null, 2));
  writeFileSync(join(frontendRoot, 'official-web.patch.json'), `${JSON.stringify([
    { insert: [{ id: 'dsh-crew-official-web-bridge', name: pathToFileURL(entry).href }] },
  ], null, 2)}\n`);
  return { entryUri: pathToFileURL(entry).href, entry };
}

const USER_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: commandcode',
  '    model: deepseek/deepseek-v4-flash',
  '    reasoningEffort: max',
  '- id: ui-chat',
  '  name: "@deepseek-ai/dsh-client-ui-chat"',
  '  config:',
  '    transcriptView: standard',
  '',
].join('\n');

function materializeUserPatch(home, text = USER_PATCH) {
  const file = desktopPatchFile({ home });
  mkdirSync(join(home, '.dsh', 'profiles', 'desktop'), { recursive: true });
  writeFileSync(file, text);
  return { file, original: readFileSync(file, 'utf8') };
}

test('crewBridgeEntry accepts the launcher-validated snapshot and rejects drift', () => {
  const t = tempHome();
  try {
    materializeBridge(t.dir);
    const bridge = crewBridgeEntry({ home: t.dir });
    assert.equal(bridge.ok, true, bridge.code);
    assert.equal(bridge.revision, REVISION);

    // A snapshot whose manifest disagrees with its directory is not usable.
    writeFileSync(join(t.dir, '.config', 'dsh-crew', 'frontend', 'revisions', REVISION, 'official-web-bridge', 'package.json'),
      JSON.stringify({ name: '@ran-sh/dsh-crew-web-bridge', dshCrewManagedFrontend: true, dshCrewFrontendRevision: SECOND_REVISION }));
    assert.equal(crewBridgeEntry({ home: t.dir }).code, 'CREW_BRIDGE_SNAPSHOT_INVALID');

    // No overlay at all (a checkout that never installed the frontend assets).
    rmSync(join(t.dir, '.config', 'dsh-crew', 'frontend'), { recursive: true, force: true });
    assert.equal(crewBridgeEntry({ home: t.dir }).code, 'CREW_BRIDGE_OVERLAY_UNAVAILABLE');
  } finally { t.cleanup(); }
});

test('attach appends one managed block and leaves the rest byte-identical', () => {
  const t = tempHome();
  try {
    const { entryUri } = materializeBridge(t.dir);
    const { file, original } = materializeUserPatch(t.dir);

    const attached = desktopAttach({ home: t.dir, log: () => {} });
    assert.equal(attached.ok, true, attached.error ?? attached.code);
    assert.equal(attached.changed, true);
    assert.equal(attached.revision, REVISION);

    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith(original), 'the original bytes must be preserved as a prefix');
    assert.ok(text.includes(`- id: dsh-crew-official-web-bridge`));
    assert.ok(text.includes(`name: '${entryUri}'`));
    assert.equal(text.replace(original, '').trim().split('\n').length, 4, 'exactly the 4-line managed block is added');
  } finally { t.cleanup(); }
});

test('attach is idempotent and re-points a stale revision', () => {
  const t = tempHome();
  try {
    const first = materializeBridge(t.dir, REVISION);
    const { file } = materializeUserPatch(t.dir);
    assert.equal(desktopAttach({ home: t.dir, log: () => {} }).ok, true);
    const once = readFileSync(file, 'utf8');

    const again = desktopAttach({ home: t.dir, log: () => {} });
    assert.equal(again.ok, true);
    assert.equal(again.changed, false);
    assert.equal(readFileSync(file, 'utf8'), once, 'a second attach must not touch the file');

    // A new payload revision re-points the same block instead of stacking another.
    materializeBridge(t.dir, SECOND_REVISION);
    const repoint = desktopAttach({ home: t.dir, log: () => {} });
    assert.equal(repoint.ok, true);
    assert.equal(repoint.changed, true);
    assert.equal(repoint.revision, SECOND_REVISION);
    const text = readFileSync(file, 'utf8');
    assert.equal(text.split('dsh-crew-official-web-bridge').length - 1, 1, 'exactly one bridge entry');
    assert.ok(!text.includes(`${REVISION}/official-web-bridge`), 'the stale revision must be gone');
    assert.ok(text.includes(`name: '${materializeBridgeEntryUri(t.dir, SECOND_REVISION)}'`));
    assert.equal(desktopStatus({ home: t.dir }).current, true);
  } finally { t.cleanup(); }
});

function materializeBridgeEntryUri(home, revision) {
  return pathToFileURL(join(home, '.config', 'dsh-crew', 'frontend', 'revisions', revision, 'official-web-bridge', 'entry.mjs')).href;
}

test('detach removes only the managed block and restores the original bytes', () => {
  const t = tempHome();
  try {
    materializeBridge(t.dir);
    const { file, original } = materializeUserPatch(t.dir);
    desktopAttach({ home: t.dir, log: () => {} });

    const detached = desktopDetach({ home: t.dir, log: () => {} });
    assert.equal(detached.ok, true);
    assert.equal(detached.changed, true);
    assert.equal(readFileSync(file, 'utf8'), original, 'detach must restore the file byte for byte');

    const second = desktopDetach({ home: t.dir, log: () => {} });
    assert.equal(second.changed, false);
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally { t.cleanup(); }
});

test('detach removes a file that held only the managed block, and a missing file is a no-op', () => {
  const t = tempHome();
  try {
    materializeBridge(t.dir);
    const { file } = materializeUserPatch(t.dir, '');
    assert.equal(desktopAttach({ home: t.dir, log: () => {} }).ok, true);
    assert.equal(existsSync(file), true);
    const detached = desktopDetach({ home: t.dir, log: () => {} });
    assert.equal(detached.removed_file, true);
    assert.equal(existsSync(file), false);
    assert.equal(desktopDetach({ home: t.dir, log: () => {} }).changed, false);
  } finally { t.cleanup(); }
});

test('attach fails closed on a patch layer it does not own the shape of', () => {
  const t = tempHome();
  try {
    materializeBridge(t.dir);
    const { file } = materializeUserPatch(t.dir, 'key: value\n');
    const refused = desktopAttach({ home: t.dir, log: () => {} });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'DESKTOP_PATCH_SHAPE_UNSUPPORTED');
    assert.equal(readFileSync(file, 'utf8'), 'key: value\n', 'a refused attach must not write');
  } finally { t.cleanup(); }
});

test('attach without a Crew bridge snapshot fails closed and writes nothing', () => {
  const t = tempHome();
  try {
    const { file, original } = materializeUserPatch(t.dir);
    const refused = desktopAttach({ home: t.dir, log: () => {} });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'CREW_BRIDGE_OVERLAY_UNAVAILABLE');
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally { t.cleanup(); }
});

test('attach creates the layer when the desktop profile exists without one', () => {
  const t = tempHome();
  try {
    const { entryUri } = materializeBridge(t.dir);
    mkdirSync(join(t.dir, '.dsh', 'profiles', 'desktop'), { recursive: true });
    const attached = desktopAttach({ home: t.dir, log: () => {} });
    assert.equal(attached.ok, true);
    const text = readFileSync(desktopPatchFile({ home: t.dir }), 'utf8');
    assert.ok(text.includes(`name: '${entryUri}'`));
    assert.equal(desktopStatus({ home: t.dir }).attached, true);
  } finally { t.cleanup(); }
});

test('status reports an absent layer, an attached block, and a stale revision', () => {
  const t = tempHome();
  try {
    assert.equal(desktopStatus({ home: t.dir }).file_present, false);
    materializeBridge(t.dir);
    materializeUserPatch(t.dir);
    assert.equal(desktopStatus({ home: t.dir }).attached, false);
    desktopAttach({ home: t.dir, log: () => {} });
    assert.deepEqual(
      { attached: desktopStatus({ home: t.dir }).attached, current: desktopStatus({ home: t.dir }).current },
      { attached: true, current: true },
    );
    materializeBridge(t.dir, SECOND_REVISION);
    assert.deepEqual(
      { attached: desktopStatus({ home: t.dir }).attached, current: desktopStatus({ home: t.dir }).current },
      { attached: true, current: false },
    );
  } finally { t.cleanup(); }
});
