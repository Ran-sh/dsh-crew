// Wrap the compiled client bundle into the dsh-web module-loader artifact:
// `window.__ModuleLoader__.load({ id, factory })`. The id must equal the
// package name (= the cordis entry name). Pattern from dsh-noema.

import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pluginId = manifest.name;
const source = await readFile(join(root, '.client-build', 'index.cjs'), 'utf8');
const wrapped = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  source.replace(/\n?\/\/# sourceMappingURL=.*$/u, ''),
  'return module.exports; } });',
  '',
].join('\n');
await mkdir(join(root, 'lib'), { recursive: true });
await writeFile(join(root, 'lib', 'client.js'), wrapped);
await rm(join(root, '.client-build'), { recursive: true, force: true });
console.log(`built lib/client.js (${wrapped.length} bytes) as module "${pluginId}"`);
