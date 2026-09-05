// Wrap the compiled client bundle into the dsh-web module-loader artifact:
// `window.__ModuleLoader__.load({ id, factory })`. The id must equal the
// package name (= the cordis entry name). Pattern from dsh-noema.

import { readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pluginId = manifest.name;
const buildDir = join(root, '.client-build');

// Dual entry: the full 3210 control plane (entry.cjs) and the narrow 3080
// quick panel (quick-entry.cjs). They are wrapped under DIFFERENT module
// ids so the official surface never receives full control-plane code.
const fullEntry = 'entry.cjs';
const quickEntry = 'quick-entry.cjs';
const built = (await readdir(buildDir)).filter((name) => name.endsWith('.cjs'));
for (const expected of [fullEntry, quickEntry]) {
  if (!built.includes(expected)) {
    throw new Error(`missing compiled client entry ${expected} in .client-build (found: ${built.join(', ')})`);
  }
}

function wrap(source, id) {
  // The host resolves package modules, not discarded tsdown shared chunks.
  if (/require\(["']\.\.?\//.test(source)) throw new Error(`client ${id} depends on an unshipped relative chunk`);
  return [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    'var module = { exports: {} }; var exports = module.exports;',
    source.replace(/\n?\/\/# sourceMappingURL=.*$/u, ''),
    'return module.exports; } });',
    '',
  ].join('\n');
}

const fullSource = await readFile(join(buildDir, fullEntry), 'utf8');
const fullWrapped = wrap(fullSource, pluginId);
await mkdir(join(root, 'lib'), { recursive: true });
await writeFile(join(root, 'lib', 'client.js'), fullWrapped);

const bridgeManifest = JSON.parse(await readFile(join(root, 'official-web-bridge', 'package.json'), 'utf8'));
const quickSource = await readFile(join(buildDir, quickEntry), 'utf8');
const quickWrapped = wrap(quickSource, bridgeManifest.name);
await mkdir(join(root, 'official-web-bridge', 'lib'), { recursive: true });
await writeFile(join(root, 'official-web-bridge', 'lib', 'client.js'), quickWrapped);
await rm(buildDir, { recursive: true, force: true });
console.log(`built lib/client.js (${fullWrapped.length} bytes) and official-web-bridge/lib/client.js (${quickWrapped.length} bytes) from ${fullEntry} + ${quickEntry}`);
