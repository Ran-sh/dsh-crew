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

/** Hash published source files, excluding installed dependencies and transaction metadata. */
export function payloadContentDigest(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const files = new Map();
    let bytes = 0;
    const visit = relative => {
      const file = join(root, relative);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('unsupported payload symlink');
      if (stat.isDirectory()) {
        for (const name of readdirSync(file)) visit(posix.join(relative, name));
        return;
      }
      if (!stat.isFile() || files.size >= 4096) throw new Error('unsupported payload entry');
      if (files.has(relative)) return;
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024) throw new Error('payload content limit exceeded');
      const content = relative === 'package.json'
        ? JSON.stringify(runtimeManifest(manifest)) : readFileSync(file);
      files.set(relative, createHash('sha256').update(content).digest('hex'));
    };
    visit('package.json');
    for (const entry of manifest.files ?? []) {
      if (typeof entry !== 'string') throw new Error('invalid payload pattern');
      const pattern = entry.replaceAll('\\', '/');
      if (isAbsolute(pattern) || pattern.includes(':') || pattern.split('/').includes('..')) throw new Error('invalid payload path');
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
    return createHash('sha256').update(JSON.stringify([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
  } catch { return null; }
}

export function samePayloadContent(sourceRoot, installedRoot) {
  const source = payloadContentDigest(sourceRoot);
  return source !== null && source === payloadContentDigest(installedRoot);
}
