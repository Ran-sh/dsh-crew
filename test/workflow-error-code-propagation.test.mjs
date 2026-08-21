import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowRuntime } from '../src/workflow-runtime.mjs';
import { normalizeGlobalConfig } from '../src/policy.mjs';

const GOOD = `Done.
## Diff
- src/a.mjs — change
## Tests
PASS — node --test — passed
## Risks
none`;

function runtimeFor(results, config = {}) {
  let index = 0;
  return createWorkflowRuntime({
    getConfig: () => normalizeGlobalConfig(config),
    executeAttempt: async (spec) => ({
      id: `a-${index}`,
      role: spec.role,
      attempt: spec.attempt,
      provider: 'p',
      model: spec.attempt > 0 ? 'strong' : 'cheap',
      selection_source: 'test',
      ...results[index++],
    }),
    buildReviewTask: () => 'review',
    releaseWorkspace: async () => ({ ok: true }),
  }, { idFactory: () => 'wf-code-test' });
}

test('final failed attempt code reaches workflow, child attempt and failure classifier', async () => {
  const rt = runtimeFor([{
    status: 'failed',
    result: '',
    stopReason: 'provider-error',
    error: 'model unavailable',
    error_code: 'NO_WORKER_MODEL_AVAILABLE',
  }]);
  const job = rt.start({ role: 'worker', task: 'x', cwd: '/repo' });
  await rt.wait(job.id, 1000);
  const view = rt.get(job.id, { withResult: true });

  assert.equal(view.status, 'failed');
  assert.equal(view.error_code, 'NO_WORKER_MODEL_AVAILABLE');
  assert.equal(view.child_attempts[0].error_code, 'NO_WORKER_MODEL_AVAILABLE');
  assert.equal(view.failure.category, 'provider');
  assert.equal(view.failure.source_code, 'NO_WORKER_MODEL_AVAILABLE');
});

test('an escalated failed-attempt code does not leak after a later success', async () => {
  const rt = runtimeFor([
    {
      status: 'failed',
      result: '',
      stopReason: 'provider-error',
      error: 'temporary model failure',
      error_code: 'NO_WORKER_MODEL_AVAILABLE',
    },
    { status: 'done', result: GOOD, stopReason: 'completed' },
  ], { escalate_on_failure: true });
  const job = rt.start({ role: 'worker', task: 'x', cwd: '/repo' });
  await rt.wait(job.id, 1000);
  const view = rt.get(job.id, { withResult: true });

  assert.equal(view.status, 'done');
  assert.equal(view.error_code, null);
  assert.equal(view.child_attempts[0].error_code, 'NO_WORKER_MODEL_AVAILABLE');
  assert.equal(view.child_attempts[1].error_code, null);
  assert.equal(view.failure.category, 'none');
});

test('failed reviewer code remains diagnostic without changing reviewer completion semantics', async () => {
  const rt = runtimeFor([{
    status: 'failed',
    result: '',
    stopReason: 'provider-error',
    error: 'review model unavailable',
    error_code: 'NO_WORKER_MODEL_AVAILABLE',
  }]);
  const job = rt.start({ role: 'reviewer', delivery: 'review', task: 'review', cwd: '/repo' });
  await rt.wait(job.id, 1000);
  const view = rt.get(job.id, { withResult: true });

  assert.equal(view.status, 'done', 'existing reviewer completion semantics stay unchanged');
  assert.equal(view.error_code, 'NO_WORKER_MODEL_AVAILABLE');
  assert.equal(view.child_attempts[0].error_code, 'NO_WORKER_MODEL_AVAILABLE');
  assert.equal(view.failure.category, 'provider');
});
