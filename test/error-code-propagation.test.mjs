import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attemptFromView } from '../src/mcp-runtime.mjs';

test('attemptFromView preserves error_code from Hub/Standalone views', () => {
  const attempt = attemptFromView({
    id: 'hub-1', status: 'failed', error: 'unavailable', error_code: 'NO_WORKER_MODEL_AVAILABLE',
  }, { id: 'wf-1-a0', role: 'worker', attempt: 0 });
  assert.equal(attempt.error_code, 'NO_WORKER_MODEL_AVAILABLE');
});

test('attemptFromView accepts legacy code when error_code is absent', () => {
  const attempt = attemptFromView({
    id: 'hub-2', status: 'failed', code: 'ROLE_DISABLED',
  }, { id: 'wf-2-a0', role: 'worker', attempt: 0 });
  assert.equal(attempt.error_code, 'ROLE_DISABLED');
});

test('attemptFromView prefers explicit error_code over generic code', () => {
  const attempt = attemptFromView({
    status: 'failed', error_code: 'NO_WORKER_MODEL_AVAILABLE', code: 'GENERIC',
  }, { id: 'wf-3-a0', role: 'worker', attempt: 0 });
  assert.equal(attempt.error_code, 'NO_WORKER_MODEL_AVAILABLE');
});
