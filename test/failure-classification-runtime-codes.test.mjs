import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailureCode } from '../src/failure-classification.mjs';

test('git isolation failures stay runtime with their bounded source code', () => {
  for (const code of ['GIT_NOT_FOUND', 'GIT_TIMEOUT', 'GIT_ERROR', 'WORKTREE_LOCKED']) {
    const failure = classifyFailureCode(code);
    assert.equal(failure.category, 'runtime');
    assert.equal(failure.reason_code, code);
    assert.equal(failure.source_code, code);
  }
});
