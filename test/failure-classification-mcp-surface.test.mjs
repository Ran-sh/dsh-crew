import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(here, '..', 'src', 'server.mjs'), 'utf8');

test('immediate MCP code responses receive normalized failure metadata', () => {
  assert.match(serverSource, /import \{ classifyFailure, classifyFailureCode \} from '\.\/failure-classification\.mjs';/);
  assert.match(serverSource, /if \(obj\.code\)[\s\S]*failure: classifyFailureCode\(obj\.code\)/);
});

test('legacy result-like payloads are decorated from structured fields only', () => {
  assert.match(serverSource, /obj\.status !== undefined \|\| obj\.phase !== undefined \|\| obj\.outcome !== undefined \|\| obj\.error_code !== undefined/);
  assert.match(serverSource, /failure: classifyFailure\(\{[\s\S]*phase: obj\.phase,[\s\S]*status: obj\.status,[\s\S]*errorCode: obj\.error_code,[\s\S]*outcome: obj\.outcome,[\s\S]*decision: obj\.decision,[\s\S]*review: obj\.review,[\s\S]*childAttempts: obj\.child_attempts/);
});
