import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('package root loads the v0.3 Hub entry wrapper', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.main, './src/hub/entry.mjs');
  assert.equal(pkg.exports['.'], './src/hub/entry.mjs');
  // Release/package semver remains independent from the runtime/wire identity.
  assert.notEqual(pkg.version, '0.3.0-dev');
});

test('MCP server uses shared runtime identity rather than a hard-coded generation', () => {
  const source = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(source, /import\s+\{\s*RUNTIME_VERSION(?:,\s*getHubRuntimeIdentity)?\s*\}\s+from\s+'\.\/runtime-identity\.mjs'/);
  assert.match(source, /new McpServer\(\{\s*name:\s*'dsh-crew',\s*version:\s*RUNTIME_VERSION\s*\}\)/);
  assert.doesNotMatch(source, /version:\s*'0\.2\.0'/);
});
