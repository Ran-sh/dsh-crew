import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as frontend from '../src/install/official-frontend-assets.mjs';

test('frontend overlay stays Crew-owned and keeps prior immutable assets available', () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-frontend-assets-'));
  try {
    const root = join(home, 'source');
    const bridge = join(root, 'official-web-bridge');
    mkdirSync(join(bridge, 'lib'), { recursive: true });
    mkdirSync(join(root, 'src'));
    writeFileSync(join(bridge, 'overlay-entry.mjs'), 'export function apply() {}');
    writeFileSync(join(bridge, 'lib', 'client.js'), 'client v1');
    writeFileSync(join(bridge, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew-web-bridge', version:'1', exports:{'./client':'./lib/client.js'} }));
    writeFileSync(join(root, 'src', 'local-request-guard.mjs'), 'export {};');
    const first = frontend.installOfficialFrontendAssets({ home, root });
    assert.equal(first.ok, true);
    const overlay = JSON.parse(readFileSync(first.overlayFile, 'utf8'));
    const entry = fileURLToPath(overlay[0].insert[0].name);
    assert.ok(entry.startsWith(join(home, '.config', 'dsh-crew', 'frontend')));
    assert.equal(existsSync(join(home, '.dsh')), false);
    assert.equal(frontend.installOfficialFrontendAssets({ home, root }).changed, false);
    writeFileSync(join(bridge, 'lib', 'client.js'), 'client v2');
    const second = frontend.installOfficialFrontendAssets({ home, root });
    assert.equal(second.ok, true);
    assert.notEqual(first.revision, second.revision);
    assert.equal(readFileSync(join(first.snapshotRoot, 'official-web-bridge', 'lib', 'client.js'), 'utf8'), 'client v1');
    assert.equal(frontend.officialFrontendAssetsReady({ home, root }), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// Git hands a Windows checkout CRLF while the snapshot was written from the npm
// payload (LF). Both line endings serve these text sources, so a CRLF checkout must
// not read as a drifted snapshot — which is what made every autocrlf machine report
// "needs repair" while the payload-side view said installed.
test('a CRLF checkout is not a drifted snapshot, but changed bytes still are', () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-frontend-crlf-'));
  try {
    const root = join(home, 'source');
    const bridge = join(root, 'official-web-bridge');
    mkdirSync(join(bridge, 'lib'), { recursive: true });
    mkdirSync(join(root, 'src'));
    writeFileSync(join(bridge, 'overlay-entry.mjs'), 'export function apply() {}\n');
    writeFileSync(join(bridge, 'lib', 'client.js'), 'client v1\n');
    writeFileSync(join(bridge, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew-web-bridge', version: '1', exports: { './client': './lib/client.js' } }));
    writeFileSync(join(root, 'src', 'local-request-guard.mjs'), 'export {};\n');
    assert.equal(frontend.installOfficialFrontendAssets({ home, root }).ok, true);
    assert.equal(frontend.officialFrontendAssetsReady({ home, root }), true);

    // A fresh clone rewrites the checkout with CRLF.
    for (const rel of ['official-web-bridge/overlay-entry.mjs', 'official-web-bridge/lib/client.js', 'src/local-request-guard.mjs']) {
      const file = join(root, ...rel.split('/'));
      writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
    }
    assert.equal(frontend.officialFrontendAssetsReady({ home, root }), true, 'line endings are not drift');

    // A real content change is still drift, and so is a snapshot with extra bytes.
    writeFileSync(join(bridge, 'lib', 'client.js'), 'client v2\n');
    assert.equal(frontend.officialFrontendAssetsReady({ home, root }), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
