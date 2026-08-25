import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(here, '..', 'src', 'server.mjs'), 'utf8');

test('MCP dispatch gates read canonical global config per request instead of freezing startup state', () => {
  assert.match(serverSource, /const currentGlobalConfig = \(\) => normalizeGlobalConfig\(readGlobalConfig\(\)\);/);
  assert.doesNotMatch(serverSource, /const globalConfig = normalizeGlobalConfig\(readGlobalConfig\(\)\);/);
  const liveReads = serverSource.match(/const globalConfig = currentGlobalConfig\(\);/g) ?? [];
  assert.ok(liveReads.length >= 2, `expected shared per-dispatch preparation and config-report live reads; found ${liveReads.length}`);
  assert.equal((serverSource.match(/const prepared = prepareDispatch\(/g) ?? []).length, 2, 'run and spawn must both invoke live preparation');
});

test('dsh_worker_config surfaces activation boundaries and the actual runtime gate state', () => {
  assert.match(serverSource, /workflowRuntime\.refreshRuntimeControls\(\)/);
  assert.match(serverSource, /runtime_controls:\s*runtimeControls/);
  assert.match(serverSource, /activation_boundaries:\s*activationBoundaries/);
  assert.match(serverSource, /runtimeActivationMetadata/);
});
