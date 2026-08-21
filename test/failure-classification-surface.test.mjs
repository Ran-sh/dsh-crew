import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeSource = readFileSync(join(here, '..', 'src', 'workflow-runtime.mjs'), 'utf8');

test('workflow views expose one normalized failure object without changing transport adapters', () => {
  assert.match(runtimeSource, /import \{ classifyFailure \} from '\.\/failure-classification\.mjs';/);
  assert.match(runtimeSource, /const failure = classifyFailure\(\{[\s\S]*phase: job\.phase,[\s\S]*status: job\.status,[\s\S]*errorCode: job\.error_code,[\s\S]*outcome: job\.outcome,[\s\S]*decision: job\.decision,[\s\S]*review: job\.review,[\s\S]*childAttempts: job\.attempts,[\s\S]*\}\);/);
  assert.match(runtimeSource, /error_code: job\.error_code \?\? null,[\s\S]*failure,/);
});
