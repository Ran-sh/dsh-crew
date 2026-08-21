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
const compiledEntries = (await readdir(buildDir)).filter((name) => name.endsWith('.cjs'));
if (compiledEntries.length !== 1) {
  throw new Error(`expected exactly one compiled client entry in .client-build, found ${compiledEntries.length}: ${compiledEntries.join(', ')}`);
}
const source = await readFile(join(buildDir, compiledEntries[0]), 'utf8');
const wrapped = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  source.replace(/\n?\/\/# sourceMappingURL=.*$/u, ''),
  'return module.exports; } });',
  '',
].join('\n');
await mkdir(join(root, 'lib'), { recursive: true });
await writeFile(join(root, 'lib', 'client.js'), wrapped);
await rm(buildDir, { recursive: true, force: true });
console.log(`built lib/client.js (${wrapped.length} bytes) as module "${pluginId}" from ${compiledEntries[0]}`);
