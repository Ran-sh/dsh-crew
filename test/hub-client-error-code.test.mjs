import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUB_REQUEST_FAILED, hubRequestError } from '../src/hub-client.mjs';

test('Hub request error preserves explicit code without copying response payload', () => {
  const err = hubRequestError({
    error: 'model unavailable',
    code: 'NO_WORKER_MODEL_AVAILABLE',
    secret: 'must-not-copy',
  }, 400);
  assert.equal(err.message, 'model unavailable');
  assert.equal(err.code, 'NO_WORKER_MODEL_AVAILABLE');
  assert.equal(err.secret, undefined);
  assert.doesNotMatch(JSON.stringify(err), /must-not-copy/);
});

test('Hub request error falls back to policyCode and ignores blank explicit codes', () => {
  assert.equal(hubRequestError({ error: 'blocked', policyCode: 'ROLE_DISABLED' }, 400).code, 'ROLE_DISABLED');
  assert.equal(hubRequestError({ error: 'bad', code: '   ' }, 500).code, HUB_REQUEST_FAILED);
});

test('Hub request error uses a bounded fallback code when the server omitted one', () => {
  const err = hubRequestError(null, 503);
  assert.equal(err.message, 'hub request failed (503)');
  assert.equal(err.code, HUB_REQUEST_FAILED);
});

test('bounded machine-code rule: malformed, lowercase, oversized codes never propagate', () => {
  assert.equal(hubRequestError({ error: 'x', code: 'no_worker_model_available' }, 400).code, HUB_REQUEST_FAILED);
  assert.equal(hubRequestError({ error: 'x', code: 'Mixed_Case' }, 400).code, HUB_REQUEST_FAILED);
  assert.equal(hubRequestError({ error: 'x', code: '_LEADING' }, 400).code, HUB_REQUEST_FAILED);
  assert.equal(hubRequestError({ error: 'x', code: 'A'.repeat(65) }, 400).code, HUB_REQUEST_FAILED);
  assert.equal(hubRequestError({ error: 'x', policyCode: 'not_a_machine_code' }, 400).code, HUB_REQUEST_FAILED);
  // valid bounded codes still propagate; an invalid code falls through to a
  // valid policyCode instead of being copied verbatim.
  assert.equal(hubRequestError({ error: 'x', code: 'NO_WORKER_MODEL_AVAILABLE' }, 400).code, 'NO_WORKER_MODEL_AVAILABLE');
  assert.equal(hubRequestError({ error: 'x', code: 'broken', policyCode: 'ROLE_DISABLED' }, 400).code, 'ROLE_DISABLED');
});
