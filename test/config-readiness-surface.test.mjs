import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(here, '..', 'src', 'server.mjs'), 'utf8');

test('dsh_worker_config exposes a top-level readiness matrix from the existing catalog read', () => {
  assert.match(serverSource, /import \{ buildConfigReadinessMatrix \} from '\.\/config-readiness\.mjs';/);
  assert.match(serverSource, /providerCatalogChecked = true;[\s\S]*const res = await fetch\(`\$\{globalConfig\.hub_url\}\/\_dsh\/dsh-crew\/models`\);[\s\S]*providerCatalogBody = body;/);
  assert.match(serverSource, /fetch\(`\$\{globalConfig\.hub_url\}\/\_dsh\/dsh-crew\/extension`\)/);
  assert.match(serverSource, /const readinessMatrix = buildConfigReadinessMatrix\(\{[\s\S]*hubCompatibility,[\s\S]*workerProviderMode,[\s\S]*providerCatalogChecked,[\s\S]*providerCatalogBody,[\s\S]*\}\);/);
  assert.match(serverSource, /readiness_matrix:\s*readinessMatrix/);
});

test('config readiness does not add a second catalog request', () => {
  const catalogFetches = serverSource.match(/\/_dsh\/dsh-crew\/models/g) ?? [];
  assert.equal(catalogFetches.length, 1, 'config report should reuse its single existing /models request');
});
