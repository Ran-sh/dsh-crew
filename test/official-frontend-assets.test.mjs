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
