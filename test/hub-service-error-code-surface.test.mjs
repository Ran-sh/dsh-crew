// Static surface regression for issue #30 hub-service error-code completion:
// the Hub /jobs catch must emit a top-level machine `code` only via the shared
// bounded helper (err.code / err.policyCode), never from error text, and the
// Hub client must use the same bounded rule with HUB_REQUEST_FAILED fallback.
//
// Run with: node --test test/hub-service-error-code-surface.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('../', import.meta.url)));

test('hub /jobs catch wires the shared bounded-code helper and keeps raw error text', () => {
  const hub = readFileSync(join(ROOT, 'src', 'hub', 'index.mjs'), 'utf8');
  assert.match(hub, /import \{[^}]*\bboundedMachineCodeFromError\b[^}]*\} from '\.\.?\/structured-error-code\.mjs'/, 'hub must import the shared helper');
  assert.match(hub, /boundedMachineCodeFromError\(err\)/, 'hub catch must call the bounded helper');
  assert.match(hub, /const body = \{ ok: false, error: err\?\.message \?\? String\(err\) \};/, 'raw error text must always be preserved');
  assert.match(hub, /if \(code\) body\.code = code;/, 'code is emitted only when bounded');
  assert.doesNotMatch(hub, /code:\s*String\(err\)|code:\s*err\.message/, 'hub must never derive codes from error text');
});

test('hub client uses the same bounded rule for code and policyCode', () => {
  const cli = readFileSync(join(ROOT, 'src', 'hub-client.mjs'), 'utf8');
  assert.match(cli, /isBoundedMachineCode\(body\?\.code\)/, 'client must bound body.code');
  assert.match(cli, /isBoundedMachineCode\(body\?\.policyCode\)/, 'client must bound body.policyCode');
  assert.match(cli, /HUB_REQUEST_FAILED/, 'client keeps its bounded fallback code');
});

test('shared contract consistency: HUB_REQUEST_FAILED is itself a bounded machine code', async () => {
  const { HUB_REQUEST_FAILED } = await import('../src/hub-client.mjs');
  const { isBoundedMachineCode } = await import('../src/structured-error-code.mjs');
  assert.equal(isBoundedMachineCode(HUB_REQUEST_FAILED), true);
});