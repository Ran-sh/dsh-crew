import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function runtimeManifest(manifest) {
  const normalized = { ...manifest, dependencies: { ...manifest.peerDependencies, ...manifest.dependencies } };
  delete normalized.devDependencies;
  delete normalized.peerDependencies;
  delete normalized.peerDependenciesMeta;
  return canonical(normalized);
}

/** Capture bounded first-party package bytes once for both validation and copying. */
export function capturePayloadContent(root, suppliedManifest) {
  try {
    const manifest = suppliedManifest ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (!Array.isArray(manifest.files)) return null;
    const files = new Map();
    const modes = new Map();
    const directories = new Set();
    let bytes = 0;
    const visit = relative => {
      let parent = root;
      for (const segment of posix.dirname(relative).split('/').filter(part => part && part !== '.')) {
        parent = join(parent, segment);
        const info = lstatSync(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsupported payload parent');
      }
      const file = join(root, relative);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('unsupported payload symlink');
      if (stat.isDirectory()) {
        if (directories.size >= 4096) throw new Error('payload directory limit exceeded');
        directories.add(relative);
        for (const name of readdirSync(file)) visit(posix.join(relative, name));
        return;
      }
      if (!stat.isFile() || files.size >= 4096) throw new Error('unsupported payload entry');
      if (files.has(relative)) return;
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024) throw new Error('payload content limit exceeded');
      const content = relative === 'package.json'
        ? Buffer.from(JSON.stringify(runtimeManifest(manifest))) : readFileSync(file);
      if (content.length > stat.size && relative !== 'package.json') throw new Error('payload changed while being read');
      files.set(relative, content);
      modes.set(relative, stat.mode & 0o777);
    };
    visit('package.json');
    for (const entry of manifest.files ?? []) {
      if (typeof entry !== 'string') throw new Error('invalid payload pattern');
      const pattern = entry.replaceAll('\\', '/');
      const segments = pattern.split('/');
      if (!pattern.trim() || entry.includes('\\') || posix.normalize(pattern) === '.'
        || isAbsolute(pattern) || pattern.includes(':')
        || segments.some(segment => ['..', '.git', 'node_modules'].includes(segment.toLowerCase()))) throw new Error('invalid payload path');
      if (!pattern.includes('*')) {
        if (existsSync(join(root, pattern))) visit(pattern);
        continue;
      }
      const base = posix.dirname(pattern);
      if (base.includes('*')) throw new Error('unsupported payload wildcard');
      const expression = new RegExp('^' + posix.basename(pattern).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
      if (existsSync(join(root, base))) {
        for (const name of readdirSync(join(root, base))) if (expression.test(name)) visit(posix.join(base, name));
      }
    }
    return { files, directories, modes };
  } catch { return null; }
}

/** This digest covers first-party shipped files, not dependency tamper attestation. */
export function payloadContentDigest(root) {
  const snapshot = capturePayloadContent(root);
  if (!snapshot) return null;
  const hashes = [...snapshot.files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]);
  return createHash('sha256').update(JSON.stringify(hashes.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
}

export function samePayloadContent(sourceRoot, installedRoot) {
  const source = payloadContentDigest(sourceRoot);
  return source !== null && source === payloadContentDigest(installedRoot);
}
