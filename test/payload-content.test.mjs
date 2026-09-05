import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as payload from '../src/install/payload-content.mjs';

test('captured payload bytes remain stable if the source changes before staging', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-content-'));
  try {
    const manifest = { name: 'test', files: ['src'] };
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.mjs'), 'original');
    const captured = payload.capturePayloadContent(root, manifest);
    writeFileSync(join(root, 'src', 'index.mjs'), 'changed');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest, files: ['../outside'] }));
    assert.equal(captured.files.get('src/index.mjs').toString(), 'original');
    assert.equal(payload.capturePayloadContent(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
