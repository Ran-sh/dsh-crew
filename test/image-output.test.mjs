import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as images from '../src/image-output.mjs';

test('generation must create its own image and preserve the previous file on failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-image-output-'));
  const output = join(dir, 'result.png');
  const png = Buffer.from([137,80,78,71,13,10,26,10,1]);
  try {
    writeFileSync(output, 'previous image');
    await assert.rejects(images.withGeneratedImageOutput(output, async () => {}));
    assert.equal(readFileSync(output, 'utf8'), 'previous image');
    await assert.rejects(images.withGeneratedImageOutput(output, async file => writeFileSync(file, 'not an image')));
    assert.equal(readFileSync(output, 'utf8'), 'previous image');
    assert.equal(await images.withGeneratedImageOutput(output, async file => {
      assert.notEqual(file, output);
      writeFileSync(file, png);
    }), output);
    assert.deepEqual(readFileSync(output), png);
    assert.deepEqual(readdirSync(dir), ['result.png']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
