// Lifecycle regression tests for the v0.5.6 review findings:
//
//   P1-1  an automatic reviewer rejection / failed / incomplete review must
//         fail the workflow (fail closed) instead of finalizing as done;
//   P1-2  hub cancel()/timeout() during a pending agents.create() must never
//         deliver the worker prompt, and a rejected preset must not leave a
//         ghost registry entry;
//   P1-3  hub-client transport calls are bounded so a hanging fetch cannot
//         outlive the workflow timeout contract.
//
// Run with: node --test test/review-lifecycle.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowRuntime } from '../src/workflow-runtime.mjs';
import { JOB_PHASES } from '../src/workflow.mjs';
import { WorkerRegistry } from '../src/hub/index.mjs';
import { normalizeGlobalConfig } from '../src/policy.mjs';

const GOOD = `Done.
## Diff
- src/a.mjs — change
## Tests
PASS — node --test — 12 passed
## Risks
none`;
const REVIEW_APPROVED = `## Review Findings
Looks good.
## Evidence
inspected src/a.mjs
## Risks
none
## Verdict
approved`;
const REVIEW_REQUEST_CHANGES = `## Review Findings
The diff misses the edge case.
## Evidence
inspected src/a.mjs
## Risks
edge case unhandled
## Verdict
needs changes: edge case unhandled`;
const REVIEW_INCOMPLETE = `## Review Findings
Looks fine but the contract is incomplete.
## Evidence
inspected src/a.mjs
## Risks
none`;

const AUTO_REVIEW = { auto_review: true, review_state: 'auto' };

let wfSeq = 0;
const idFactory = () => `wf-test-${++wfSeq}`;

function makeAdapter({ workers = [GOOD], reviews = [], getConfigPatch = {} } = {}) {
  let wIdx = 0;
  let rIdx = 0;
  return {
    attempts: [],
    executeAttempt: async (spec) => {
      if (spec.role === 'reviewer') {
        const r = reviews[rIdx] ?? { status: 'done', result: REVIEW_APPROVED, stopReason: 'completed' };
        rIdx += 1;
        return { id: `review-${rIdx}`, role: 'reviewer', attempt: 0, provider: 'p', model: 'm-review', selection_source: 'policy', ...r };
      }
      const result = workers[wIdx] ?? GOOD;
      wIdx += 1;
      return { id: `w${wIdx}`, role: 'worker', attempt: spec.attempt, provider: 'p', model: 'm-cheap', selection_source: 'policy', status: 'done', result, stopReason: 'completed' };
    },
    cancelAttempt: async () => {},
    allocateWorkspace: async (spec) => ({ ok: true, execution_cwd: spec.cwd, base_revision: 'abc123', isolation: 'worktree', primary_workspace_dirty: false, handle: 'wt-1' }),
    captureCandidate: async () => ({ ok: true, kind: 'git-worktree', base_revision: 'abc123', changed_files: ['src/a.mjs'], patch: 'diff --git a/src/a.mjs b/src/a.mjs', fingerprint: 'fp-1' }),
    releaseWorkspace: async () => ({ ok: true }),
    buildReviewTask: (task) => `review: ${task}`,
    getConfig: () => normalizeGlobalConfig({ ...getConfigPatch }),
  };
}

// ---------- P1-1: the automatic review verdict is an acceptance gate ----------

test('automatic review with request_changes fails the workflow (no false done)', async () => {
  const a = makeAdapter({ reviews: [{ status: 'done', result: REVIEW_REQUEST_CHANGES, stopReason: 'completed' }], getConfigPatch: AUTO_REVIEW });
  const rt = createWorkflowRuntime(a, { idFactory });
  const job = rt.start({ role: 'worker', task: 'do it', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'failed', 'a rejected candidate must not surface as done');
  assert.equal(v.phase, JOB_PHASES.FAILED);
  assert.equal(v.error_code, 'REVIEW_CHANGES_REQUESTED');
  assert.equal(v.review.verdict, 'request_changes');
  assert.ok(v.canonical_events.some((e) => e.type === 'job.failed'), 'terminal event must be job.failed');
  assert.ok(!v.canonical_events.some((e) => e.type === 'job.completed'), 'no job.completed event may exist');
});

test('automatic review approve still finalizes as done (baseline preserved)', async () => {
  const a = makeAdapter({ reviews: [{ status: 'done', result: REVIEW_APPROVED, stopReason: 'completed' }], getConfigPatch: AUTO_REVIEW });
  const rt = createWorkflowRuntime(a, { idFactory });
  const job = rt.start({ role: 'worker', task: 'do it', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'done');
  assert.equal(v.review.verdict, 'approve');
});

test('failed reviewer execution fails the workflow instead of completing it', async () => {
  const a = makeAdapter({ reviews: [{ status: 'failed', result: '', stopReason: 'error', error: 'reviewer boom' }], getConfigPatch: AUTO_REVIEW });
  const rt = createWorkflowRuntime(a, { idFactory });
  const job = rt.start({ role: 'worker', task: 'do it', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'failed');
  assert.equal(v.error_code, 'REVIEW_INCONCLUSIVE');
});

test('incomplete review contract (missing Verdict) fails the workflow', async () => {
  const a = makeAdapter({ reviews: [{ status: 'done', result: REVIEW_INCOMPLETE, stopReason: 'completed' }], getConfigPatch: AUTO_REVIEW });
  const rt = createWorkflowRuntime(a, { idFactory });
  const job = rt.start({ role: 'worker', task: 'do it', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'failed');
  assert.equal(v.review.delivery_complete, false);
  assert.equal(v.error_code, 'REVIEW_INCONCLUSIVE');
});

// ---------- P1-2: hub cancel/timeout vs pending agents.create() ----------

function makeRegistry({ create, presets } = {}) {
  let createCalls = 0;
  const reg = new WorkerRegistry({
    agents: {
      create: async (spec) => {
        createCalls += 1;
        return create(spec);
      },
    },
    sessions: { flush: async () => {} },
    get: (key) => {
      if (key === 'loader') return { await: async () => {} };
      if (key === 'agentPresets') return presets;
      return undefined;
    },
  });
  reg.createCalls = () => createCalls;
  return reg;
}

function makeHandle(state) {
  return {
    agent: {
      session: {},
      whenIdle: async () => {},
      followup() { state.followups += 1; },
    },
    dispose: async () => { state.disposed += 1; },
  };
}

test('cancel while agents.create() is pending: handle disposed, prompt never delivered', async () => {
  const state = { followups: 0, disposed: 0 };
  let resolveCreate;
  const reg = makeRegistry({ create: () => new Promise((resolve) => { resolveCreate = () => resolve(makeHandle(state)); }) });
  const job = await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/repo' });
  await reg.cancel(job.id);
  resolveCreate();
  await job.promise;
  const v = reg.view(job, true);
  assert.equal(v.status, 'cancelled');
  assert.equal(state.followups, 0, 'a cancelled job must never receive the worker prompt');
  assert.equal(state.disposed, 1, 'the freshly acquired handle must be disposed exactly once');
});

test('timeout while agents.create() is pending: prompt never delivered', async () => {
  const state = { followups: 0, disposed: 0 };
  let resolveCreate;
  const reg = makeRegistry({ create: () => new Promise((resolve) => { resolveCreate = () => resolve(makeHandle(state)); }) });
  const job = await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/repo', timeout_seconds: 1 });
  const terminal = await reg.wait(job.id, 5_000);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error_code, 'JOB_TIMEOUT');
  resolveCreate();
  await job.promise;
  assert.equal(state.followups, 0, 'a timed-out job must never receive the worker prompt');
  assert.equal(state.disposed, 1);
});

test('preset resolution failure after selection leaves no ghost job or agent run', async () => {
  const reg = makeRegistry({
    create: () => { throw new Error('agents.create must not be reached'); },
    presets: { resolve: async () => { throw new Error('preset missing'); }, mount: async () => {} },
  });
  await assert.rejects(
    reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/repo', requested_isolation: 'worktree' }),
    (err) => err.message === 'preset missing',
  );
  assert.equal(reg.jobs.size, 0, 'no ghost registry entry may survive a failed setup');
  assert.equal(reg.createCalls(), 0, 'no agent session may be created for a failed setup');
});

// ---------- P1-3: hub-client transport deadlines ----------

test('a hanging hub fetch rejects with HUB_REQUEST_FAILED within the transport deadline', async () => {
  process.env.DSH_CREW_HUB = 'http://127.0.0.1:9';
  process.env.DSH_CREW_HUB_TIMEOUT_MS = '80';
  // Neither the abort timer nor a pending promise keeps the event loop
  // alive on every platform; hold it explicitly until the deadline fires.
  const keepAlive = setTimeout(() => {}, 10_000);
  try {
    const { hub } = await import('../src/hub-client.mjs');
    // Wedged exchange: fetch honors the abort signal but never resolves.
    globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = init.signal.reason?.name ?? 'AbortError';
        reject(err);
      });
    });
    const started = Date.now();
    await assert.rejects(
      hub.list(),
      (err) => err.code === 'HUB_REQUEST_FAILED' && /timed out/.test(err.message),
      'a wedged hub exchange must convert into the bounded HUB_REQUEST_FAILED error',
    );
    assert.ok(Date.now() - started < 3_000, 'transport deadline must be honored promptly');
  } finally {
    clearTimeout(keepAlive);
    delete process.env.DSH_CREW_HUB_TIMEOUT_MS;
  }
});
