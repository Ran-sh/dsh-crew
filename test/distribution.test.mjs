import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

test('fork package identity is consistent across manifest, Cordis, and client artifact', () => {
  const manifest = JSON.parse(read('package.json'));
  const cordis = read('cordis.patch.yml');
  const client = read('lib/client.js');

  assert.equal(manifest.name, '@ran-sh/dsh-crew');
  assert.equal(manifest.repository?.url, 'git+https://github.com/Ran-sh/dsh-crew.git');
  assert.equal(manifest.homepage, 'https://github.com/Ran-sh/dsh-crew');
  assert.equal(manifest.bugs?.url, 'https://github.com/Ran-sh/dsh-crew/issues');
  assert.equal(manifest.license, 'MIT');
  assert.equal('publishConfig' in manifest, false);
  for (const lifecycle of ['prepare', 'preinstall', 'postinstall', 'preuninstall', 'postuninstall']) {
    assert.equal(lifecycle in (manifest.scripts ?? {}), false, `${lifecycle} must not mutate host state`);
  }

  assert.match(cordis, new RegExp(`name: ['"]${manifest.name.replace('/', '\\/')}['"]`));
  assert.match(client, new RegExp(`ModuleLoader__\\.load\\(\\{ id: ["']${manifest.name.replace('/', '\\/')}["']`));
});
