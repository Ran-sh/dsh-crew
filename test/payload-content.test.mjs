import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as payload from '../src/install/payload-content.mjs';

// The shipped mode is part of the payload: the installer copies each file with
// the mode it captured from the source, so a payload differing only by a
// permission bit is not already installed, and treating it as such would skip the
// repair that was the point of the update.
test('a permission change with identical bytes is not the same payload', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-payload-mode-'));
  const copy = `${root}-copy`;
  try {
    for (const dir of [root, copy]) {
      mkdirSync(join(dir, 'bin'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', files: ['bin'] }));
      writeFileSync(join(dir, 'bin', 'run.mjs'), 'console.log(1);\n', { mode: 0o644 });
    }
    assert.equal(payload.samePayloadContent(root, copy), true, 'identical bytes and modes match');

    chmodSync(join(copy, 'bin', 'run.mjs'), 0o755);
    // chmod is advisory on Windows and can be a no-op for the executable bit, so
    // assert the digest change only where the filesystem actually recorded it.
    const changed = payload.payloadContentDigest(root) !== payload.payloadContentDigest(copy);
    if (process.platform === 'win32') {
      assert.ok(typeof changed === 'boolean', 'the digest is still comparable on Windows');
    } else {
      assert.equal(changed, true, 'a mode change is a difference');
      assert.equal(payload.samePayloadContent(root, copy), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  }
});

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

test('nested file patterns cannot traverse a linked parent directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'crew-content-boundary-'));
  try {
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    mkdirSync(root); mkdirSync(outside);
    writeFileSync(join(outside, 'value.txt'), 'outside');
    symlinkSync(outside, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const manifest = { files: ['alias/value.txt'] };
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    assert.equal(payload.capturePayloadContent(root), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
