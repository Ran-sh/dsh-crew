import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

test('primary documentation uses the verified GitHub-only distribution workflow', () => {
  const install = 'npx -y @deepseek-ai/dsh plugin --profile web add github:Ran-sh/dsh-crew';
  const remove = 'npx -y @deepseek-ai/dsh plugin --profile web remove @ran-sh/dsh-crew';
  const legacyRemove = 'npx -y @deepseek-ai/dsh plugin --profile web remove @zseven-w/dsh-crew';

  for (const file of ['README.md', 'README.zh.md']) {
    const doc = read(file);
    assert.match(doc, new RegExp(install.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(doc, new RegExp(remove.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(doc, new RegExp(legacyRemove.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(doc.indexOf(install) < doc.indexOf('git clone https://github.com/Ran-sh/dsh-crew.git'));
    assert.match(doc, /ZSeven-W\/dsh-crew/);
    assert.doesNotMatch(doc, /npm:\s*<code>@zseven-w\/dsh-crew<\/code>/);
  }
});

test('translated READMEs do not advertise the upstream npm package as this fork', () => {
  const start = 'npx -y @deepseek-ai/dsh web';
  const translated = readdirSync(ROOT).filter((file) => /^README\..+\.md$/.test(file) && file !== 'README.zh.md');
  assert.ok(translated.length > 0);
  for (const file of translated) {
    const doc = read(file);
    const installSection = doc.split(/\r?\n/).slice(0, 150).join('\n');
    assert.doesNotMatch(doc, /npm:\s*<code>@zseven-w\/dsh-crew<\/code>/, file);
    assert.doesNotMatch(doc, /dsh plugin --profile web add @zseven-w\/dsh-crew@latest/, file);
    assert.doesNotMatch(doc, /^dsh (?:web|plugin )/m, file);
    assert.doesNotMatch(installSection, /\bnpm\b/i, file);
    assert.match(doc, /github:Ran-sh\/dsh-crew/, file);
    assert.match(doc, new RegExp(start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), file);
  }
});
