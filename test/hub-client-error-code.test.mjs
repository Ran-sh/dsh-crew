import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubRequestError } from '../src/hub-client.mjs';

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

test('Hub request error falls back to policyCode and ignores blank codes', () => {
  assert.equal(hubRequestError({ error: 'blocked', policyCode: 'ROLE_DISABLED' }, 400).code, 'ROLE_DISABLED');
  assert.equal(hubRequestError({ error: 'bad', code: '   ' }, 500).code, undefined);
});

test('Hub request error remains compatible when no structured code exists', () => {
  const err = hubRequestError(null, 503);
  assert.equal(err.message, 'hub request failed (503)');
  assert.equal(err.code, undefined);
});
