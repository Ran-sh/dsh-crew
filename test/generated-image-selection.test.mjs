import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as multimodal from '../src/multimodal.mjs';

test('image selection never substitutes an unrelated recent image', () => {
  const root = mkdtempSync(join(tmpdir(), 'crew-image-selection-'));
  try {
    writeFileSync(join(root, 'unrelated.png'), 'other task');
    assert.equal(multimodal.findGeneratedImage(root, 'request123'), null);
    const expected = join(root, 'request123.png');
    writeFileSync(expected, 'current task');
    assert.equal(multimodal.findGeneratedImage(root, 'request123'), expected);
    utimesSync(expected, new Date(0), new Date(0));
    assert.equal(multimodal.findGeneratedImage(root, 'request123'), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
