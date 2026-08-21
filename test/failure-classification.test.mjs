import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFailure,
  classifyFailureCode,
  FAILURE_REASON_CODES,
} from '../src/failure-classification.mjs';

function classification(input) {
  return classifyFailure(input);
}

test('cancelled workflows outrank all other signals', () => {
  const failure = classification({
    phase: 'cancelled',
    status: 'cancelled',
    errorCode: 'HUB_PROTOCOL_MISMATCH',
    outcome: { tests_status: 'FAIL' },
  });
  assert.equal(failure.category, 'cancelled');
  assert.equal(failure.reason_code, FAILURE_REASON_CODES.CANCELLED);
});

test('Hub compatibility codes classify without inspecting error text', () => {
  for (const code of ['HUB_UNREACHABLE', 'HUB_PROTOCOL_MISSING', 'HUB_PROTOCOL_MISMATCH', 'HUB_CAPABILITY_MISSING']) {
    const failure = classifyFailureCode(code);
    assert.equal(failure.category, 'compatibility');
    assert.equal(failure.reason_code, code);
    assert.equal(failure.source_code, code);
  }
});

test('provider availability codes are provider failures even when one originated in policy', () => {
  for (const code of ['NO_DSH_PROVIDER_SELECTED', 'NO_WORKER_MODEL_AVAILABLE', 'MODEL_CATALOG_UNAVAILABLE']) {
    const failure = classifyFailureCode(code);
    assert.equal(failure.category, 'provider');
    assert.equal(failure.reason_code, FAILURE_REASON_CODES.PROVIDER_UNAVAILABLE);
    assert.equal(failure.source_code, code);
  }
});

test('ordinary policy rejection is distinct from provider availability', () => {
  const failure = classifyFailureCode('ROLE_DISABLED');
  assert.equal(failure.category, 'policy');
  assert.equal(failure.reason_code, FAILURE_REASON_CODES.POLICY_REJECTED);
  assert.equal(failure.source_code, 'ROLE_DISABLED');
});

test('attempt timeout outranks verification evidence', () => {
  const failure = classification({
    phase: 'failed',
    status: 'failed',
    outcome: { execution_status: 'failed', tests_status: 'FAIL' },
    childAttempts: [{ timed_out: true, stopReason: 'timeout' }],
  });
  assert.equal(failure.category, 'runtime');
  assert.equal(failure.reason_code, FAILURE_REASON_CODES.ATTEMPT_TIMEOUT);
});

test('runtime infrastructure codes remain bounded', () => {
  const failure = classification({ phase: 'failed', status: 'failed', errorCode: 'WORKTREE_CREATE_FAILED' });
  assert.deepEqual(failure, {
    schema_version: 1,
    category: 'runtime',
    reason_code: 'WORKTREE_CREATE_FAILED',
    source_code: 'WORKTREE_CREATE_FAILED',
  });
});

test('tests failure remains the root cause when escalation is exhausted', () => {
  const failure = classification({
    phase: 'failed',
    status: 'failed',
    decision: { step: 'fail', reason: 'max_attempts_reached' },
    outcome: {
      execution_status: 'completed',
      task_status: 'partial',
      tests_status: 'FAIL',
      delivery: { complete: true },
    },
  });
  assert.equal(failure.category, 'verification');
  assert.equal(failure.reason_code, FAILURE_REASON_CODES.TESTS_FAILED);
  assert.equal(failure.terminal_reason, 'max_attempts_reached');
});

test('delivery incompleteness is verification even when escalation is disabled', () => {
  const failure = classification({
    phase: 'failed',
    status: 'failed',
    decision: { step: 'fail', reason: 'escalation_disabled' },
    outcome: {
      execution_status: 'completed',
      task_status: 'blocked',
      delivery: { complete: false },
    },
  });
  assert.equal(failure.category, 'verification');
  assert.equal(failure.reason_code, FAILURE_REASON_CODES.DELIVERY_INCOMPLETE);
  assert.equal(failure.terminal_reason, 'escalation_disabled');
});

test('review request-changes is surfaced even if transport status completed', () => {
  const failure = classification({
    phase: 'completed',
    status: 'done',
    review: { verdict: 'request_changes', status: 'done' },
    outcome: { execution_status: 'completed', task_status: 'success', delivery: { complete: true } },
  });
  assert.equal(failure.category, 'verification');
  assert.equal(failure.reason_code, FAILURE_REASON_CODES.REVIEW_CHANGES_REQUESTED);
});

test('clean completed result is none', () => {
  assert.deepEqual(classification({
    phase: 'completed',
    status: 'done',
    outcome: { execution_status: 'completed', task_status: 'success', tests_status: 'PASS', delivery: { complete: true } },
  }), {
    schema_version: 1,
    category: 'none',
    reason_code: 'NONE',
  });
});

test('classifier cannot leak arbitrary raw error strings because they are not inputs', () => {
  const failure = classification({
    phase: 'failed',
    status: 'failed',
    errorCode: null,
    outcome: { execution_status: 'failed' },
    error: 'Authorization: Bearer secret-token',
  });
  assert.equal(failure.category, 'runtime');
  assert.equal(failure.reason_code, FAILURE_REASON_CODES.EXECUTION_FAILED);
  assert.doesNotMatch(JSON.stringify(failure), /secret-token|authorization/i);
});
