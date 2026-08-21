import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const buildScript = await readFile(new URL('../scripts/build-client.mjs', import.meta.url), 'utf8');

test('client build uses the activation wrapper entry', () => {
  assert.match(packageJson.scripts?.['build:client'] ?? '', /tsdown src\/client\/entry\.tsx\b/);
});

test('client wrapper resolves the emitted cjs artifact instead of hard-coding index.cjs', () => {
  assert.match(buildScript, /readdir\(buildDir\)/);
  assert.match(buildScript, /endsWith\('\.cjs'\)/);
  assert.doesNotMatch(buildScript, /\.client-build['"],\s*['"]index\.cjs/);
});
