import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const serverSource = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');

test('blocking and polling MCP results default to compact and allow explicit full detail', () => {
  assert.match(serverSource, /const detailSchema = z\.enum\(\['compact', 'full'\]\)\.default\('compact'\)/);
  assert.match(serverSource, /dsh_run_worker[\s\S]*detail: detailSchema/);
  assert.match(serverSource, /dsh_worker_result[\s\S]*detail: detailSchema/);
  assert.ok((serverSource.match(/projectWorkflowView\(view, \{ detail \}\)/g) ?? []).length >= 3);
});

test('automatic review uses the bounded information-flow module instead of embedding patches in server code', () => {
  assert.match(serverSource, /import \{ buildReviewTask \} from '\.\/information-flow\.mjs'/);
  assert.doesNotMatch(serverSource, /Candidate patch \(sanitized\)/);
});

