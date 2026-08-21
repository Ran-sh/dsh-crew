import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(join(here, '..', 'src', 'server.mjs'), 'utf8');

test('immediate MCP code responses receive normalized failure metadata', () => {
  assert.match(serverSource, /import \{ classifyFailureCode \} from '\.\/failure-classification\.mjs';/);
  assert.match(serverSource, /obj\.code && obj\.failure === undefined[\s\S]*failure: classifyFailureCode\(obj\.code\)/);
});
