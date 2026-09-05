import { mkdtempSync, mkdirSync, lstatSync, openSync, readSync, closeSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

export async function downloadImageBytes(url, { fetchImpl = globalThis.fetch, timeoutMs = 60_000, maxBytes = 64 * 1024 * 1024 } = {}) {
  if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('unsupported image URL protocol');
  const controller = new AbortController();
  let reader;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('image download timed out'));
    }, timeoutMs);
  });
  const download = async () => {
    const response = await fetchImpl(url, { signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!response.ok) throw new Error(`image download failed: HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('image download exceeds size limit');
    if (!response.body) throw new Error('image download has no body');
    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('image download exceeds size limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes);
  };
  try { return await Promise.race([download(), timeout]); }
  finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

function validateImage(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.size === 0 || info.size > 64 * 1024 * 1024) throw new Error('generated image has invalid type or size');
  const head = Buffer.alloc(32);
  const fd = openSync(file, 'r');
  let length;
  try { length = readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
  const bytes = head.subarray(0, length);
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const gif = ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!png && !jpeg && !gif && !webp) throw new Error('generated output does not have a supported image signature');
}

/** Stage each request separately; an existing destination never proves success. */
export async function withGeneratedImageOutput(outputPath, generate) {
  if (!isAbsolute(outputPath)) throw new Error('output_path must be absolute');
  mkdirSync(dirname(outputPath), { recursive: true });
  const stage = mkdtempSync(join(dirname(outputPath), '.dsh-image-'));
  const stagedFile = join(stage, basename(outputPath));
  try {
    await generate(stagedFile);
    validateImage(stagedFile);
    renameSync(stagedFile, outputPath);
    return outputPath;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
