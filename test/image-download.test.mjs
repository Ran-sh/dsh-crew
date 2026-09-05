import test from 'node:test';
import assert from 'node:assert/strict';
import * as images from '../src/image-output.mjs';

test('image download bounds streamed bytes without trusting content length', async () => {
  const fetchImpl = async () => new Response(new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(images.downloadImageBytes('https://example.invalid/image', { fetchImpl, maxBytes: 3 }), /size limit/);
  const result = await images.downloadImageBytes('https://example.invalid/image', { fetchImpl, maxBytes: 4 });
  assert.deepEqual(result, Buffer.from([1, 2, 3, 4]));
});

test('image download settles even if fetch never responds to abort', async () => {
  let signal;
  await assert.rejects(images.downloadImageBytes('https://example.invalid/image', {
    fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(() => {}); }, timeoutMs: 20,
  }), /timed out/);
  assert.equal(signal.aborted, true);
});
