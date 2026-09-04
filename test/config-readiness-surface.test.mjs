import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(here, '..', 'src', 'server.mjs'), 'utf8');

test('dsh_worker_config consumes the Hub extension readiness snapshot as its matrix authority', () => {
  assert.match(serverSource, /import \{ buildRuntimeReadinessSnapshot \} from '\.\/runtime-readiness-snapshot\.mjs';/);
  assert.match(serverSource, /providerCatalogChecked = true;[\s\S]*const res = await fetch\(`\$\{globalConfig\.hub_url\}\/\_dsh\/dsh-crew\/models`, \{ signal: AbortSignal\.timeout\(800\) \}\);[\s\S]*providerCatalogBody = body;/);
  assert.match(serverSource, /fetch\(`\$\{globalConfig\.hub_url\}\/\_dsh\/dsh-crew\/extension`, \{ signal: AbortSignal\.timeout\(800\) \}\)/);
  assert.match(serverSource, /hubReadinessSnapshot/);
  assert.match(serverSource, /hubReadinessSnapshot\?\.readiness_matrix/);
  assert.match(serverSource, /readinessSnapshot/);
  assert.match(serverSource, /readiness_matrix:\s*readinessMatrix/);
  assert.doesNotMatch(serverSource, /\/_dsh\/dsh-crew\/(?:jobs|providers|provider-health)/);
});
test('dsh_worker_config bounds the Hub /models catalog fetch instead of hanging forever', () => {
  assert.match(serverSource, /fetch\(`\$\{globalConfig\.hub_url\}\/\_dsh\/dsh-crew\/models`, \{ signal: AbortSignal\.timeout\(800\) \}\)/);
});

test('config readiness does not add a second catalog request', () => {
  const catalogFetches = serverSource.match(/\/_dsh\/dsh-crew\/models/g) ?? [];
  assert.equal(catalogFetches.length, 1, 'config report should reuse its single existing /models request');
});
