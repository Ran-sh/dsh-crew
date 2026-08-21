import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowRuntime, normalizeMaxParallel } from '../src/workflow-runtime.mjs';
import { JOB_PHASES } from '../src/workflow.mjs';
import { normalizeGlobalConfig } from '../src/policy.mjs';

const GOOD = `Done.
## Diff
- src/a.mjs — change
## Tests
PASS — node --test — 1 passed
## Risks
none`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function controlledAdapter(limitRef) {
  const started = [];
  const releases = new Map();
  return {
    started,
    releases,
    getRuntimeControls: () => ({ max_parallel: limitRef.value }),
    getConfig: () => normalizeGlobalConfig({ isolation: 'shared' }),
    allocateWorkspace: async (job) => ({
      ok: true,
      execution_cwd: job.requested_cwd,
      isolation: 'shared',
      base_revision: null,
      primary_workspace_dirty: false,
      handle: null,
    }),
    releaseWorkspace: async () => ({ ok: true }),
    buildReviewTask: (task) => `review: ${task}`,
    cancelAttempt: async () => {},
    executeAttempt: async (spec) => {
      started.push(spec.workflowId);
      await new Promise((resolve) => releases.set(spec.workflowId, resolve));
      return {
        id: `${spec.workflowId}-attempt`,
        role: spec.role,
        attempt: spec.attempt,
        provider: 'test',
        model: 'test-model',
        selection_source: 'test',
        status: 'done',
        result: GOOD,
        stopReason: 'completed',
      };
    },
  };
}

function finish(adapter, workflowId) {
  const release = adapter.releases.get(workflowId);
  assert.equal(typeof release, 'function', `${workflowId} should have an active attempt`);
  release();
}

test('raising live max_parallel immediately admits queued work', async () => {
  const limit = { value: 1 };
  const adapter = controlledAdapter(limit);
  const rt = createWorkflowRuntime(adapter, { maxParallel: 1 });

  const a = rt.start({ task: 'a', cwd: '/repo' });
  const b = rt.start({ task: 'b', cwd: '/repo' });
  await tick();

  assert.deepEqual(adapter.started, [a.id]);
  assert.equal(b.phase, JOB_PHASES.QUEUED);
  assert.deepEqual(rt.runtimeState(), { max_parallel: 1, active: 1, queued: 1 });

  limit.value = 2;
  const refreshed = rt.refreshRuntimeControls();
  await tick();

  assert.equal(refreshed.max_parallel, 2);
  assert.equal(rt.runtimeState().active, 2);
  assert.equal(rt.runtimeState().queued, 0);
  assert.deepEqual(adapter.started, [a.id, b.id]);
  assert.equal(b.phase, JOB_PHASES.RUNNING);

  finish(adapter, a.id);
  finish(adapter, b.id);
  await rt.wait(a.id, 1000);
  await rt.wait(b.id, 1000);
  assert.equal(rt.get(a.id).status, 'done');
  assert.equal(rt.get(b.id).status, 'done');
});

test('lowering live max_parallel never cancels running work and blocks new admission', async () => {
  const limit = { value: 2 };
  const adapter = controlledAdapter(limit);
  const rt = createWorkflowRuntime(adapter, { maxParallel: 2 });

  const a = rt.start({ task: 'a', cwd: '/repo' });
  const b = rt.start({ task: 'b', cwd: '/repo' });
  await tick();
  assert.deepEqual(adapter.started, [a.id, b.id]);

  limit.value = 1;
  const lowered = rt.refreshRuntimeControls();
  assert.deepEqual(lowered, { max_parallel: 1, active: 2, queued: 0 });

  const c = rt.start({ task: 'c', cwd: '/repo' });
  await tick();
  assert.equal(c.phase, JOB_PHASES.QUEUED);
  assert.deepEqual(adapter.started, [a.id, b.id]);

  finish(adapter, a.id);
  await rt.wait(a.id, 1000);
  await tick();
  assert.equal(rt.runtimeState().active, 1, 'B is allowed to finish under the lowered limit');
  assert.equal(rt.runtimeState().queued, 1, 'C stays queued while active equals the new limit');
  assert.equal(c.phase, JOB_PHASES.QUEUED);

  finish(adapter, b.id);
  await rt.wait(b.id, 1000);
  await tick();
  assert.ok(adapter.started.includes(c.id), 'C starts only after active falls below the new limit');
  assert.equal(c.phase, JOB_PHASES.RUNNING);

  finish(adapter, c.id);
  await rt.wait(c.id, 1000);
  assert.equal(rt.get(c.id).status, 'done');
});

test('max_parallel normalization is bounded and invalid live values preserve the current limit', () => {
  assert.equal(normalizeMaxParallel(0), 1);
  assert.equal(normalizeMaxParallel(99), 16);
  assert.equal(normalizeMaxParallel('4'), 4);
  assert.equal(normalizeMaxParallel('bad', 7), 7);

  const limit = { value: 5 };
  const adapter = controlledAdapter(limit);
  const rt = createWorkflowRuntime(adapter, { maxParallel: 3 });
  assert.equal(rt.refreshRuntimeControls().max_parallel, 5);
  limit.value = 'not-a-number';
  assert.equal(rt.refreshRuntimeControls().max_parallel, 5, 'bad live input cannot collapse or expand the gate');
});
