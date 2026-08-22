// Unit tests for the shared bounded machine error-code contract
// (src/structured-error-code.mjs): uppercase snake-style identifiers of at
// most 64 characters are the only values that may cross the Hub service/client
// boundary as a `code`.
//
// Run with: node --test test/structured-error-code.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBoundedMachineCode,
  boundedMachineCodeFromError,
  MACHINE_CODE_MAX_LENGTH,
} from '../src/structured-error-code.mjs';

test('bounded machine codes accept valid uppercase snake-style identifiers', () => {
  for (const good of ['HUB_REQUEST_FAILED', 'NO_WORKER_MODEL_AVAILABLE', 'ROLE_DISABLED', 'MAX_ATTEMPTS_REACHED', 'A', 'A1', 'A_1', 'E100']) {
    assert.equal(isBoundedMachineCode(good), true, `${good} should be accepted`);
  }
  assert.equal(isBoundedMachineCode('A'.repeat(MACHINE_CODE_MAX_LENGTH)), true, 'exactly 64 chars is allowed');
});

test('bounded machine codes reject non-codes and malformed values', () => {
  for (const bad of [
    null, undefined, 42, {}, [],
    '', '   ',
    'no_worker_model_available', // lowercase
    'Mixed_Case', // mixed case
    '_LEADING', // leading underscore
    'TRAILING_', // trailing underscore
    'A__B', // double underscore
    'with space',
    'dash-code',
    'A'.repeat(MACHINE_CODE_MAX_LENGTH + 1), // over length 64
  ]) {
    assert.equal(isBoundedMachineCode(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
});

test('boundedMachineCodeFromError prefers a valid err.code over err.policyCode', () => {
  assert.equal(boundedMachineCodeFromError({ code: 'NO_WORKER_MODEL_AVAILABLE', policyCode: 'OTHER' }), 'NO_WORKER_MODEL_AVAILABLE');
});

test('boundedMachineCodeFromError falls through to a valid err.policyCode', () => {
  assert.equal(boundedMachineCodeFromError({ policyCode: 'ROLE_DISABLED' }), 'ROLE_DISABLED');
  // an invalid code must not block a valid policyCode
  assert.equal(boundedMachineCodeFromError({ code: 'not-a-machine-code', policyCode: 'ROLE_DISABLED' }), 'ROLE_DISABLED');
});

test('boundedMachineCodeFromError returns null when there is no valid machine code', () => {
  for (const err of [
    { error: 'text only' },
    { code: 'lowercase' },
    { code: '   ' },
    { policyCode: '' },
    { code: 'A'.repeat(65) },
    null,
    undefined,
    'not-an-object',
  ]) {
    assert.equal(boundedMachineCodeFromError(err), null, `${JSON.stringify(err)} must yield null`);
  }
});