import { mkdtempSync, mkdirSync, lstatSync, openSync, readSync, closeSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

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
