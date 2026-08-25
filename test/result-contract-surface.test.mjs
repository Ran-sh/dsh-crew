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

test('cancel results use the same compact-by-default boundary on every id path', () => {
  assert.match(serverSource, /dsh_worker_cancel[\s\S]*inputSchema: \{ job_id: z\.string\(\), detail: detailSchema \}/);
  assert.match(serverSource, /projectWorkflowView\(view, \{ detail \}\)[\s\S]*note: 'cancelled'/);
  assert.match(serverSource, /projectWorkflowView\(await hub\.cancel\(job_id\)[\s\S]*\{ detail \}\)/);
  assert.match(serverSource, /projectWorkflowView\(jobView\(await cancelJob\(job_id\), \{ withResult: true \}\), \{ detail \}\)/);
});

test('automatic review uses the bounded information-flow module instead of embedding patches in server code', () => {
  assert.match(serverSource, /import \{ buildReviewTask \} from '\.\/information-flow\.mjs'/);
  assert.doesNotMatch(serverSource, /Candidate patch \(sanitized\)/);
});
