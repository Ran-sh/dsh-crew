// PR2 runtime tests: the shared workflow runtime with mock adapters. Covers the
// state machine (guarded transitions), the attempt loop (verify -> escalate ->
// review -> finalize), infra-vs-task failure, async parity, cancellation and
// the max_parallel queue. No DSH/hub/git involved — all I/O is injected.
// Run with: node --test test/workflow-runtime.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowRuntime, normalizeReviewVerdict, WORKFLOW_ERROR_CODES } from '../src/workflow-runtime.mjs';
import { JOB_PHASES, canTransition } from '../src/workflow.mjs';
import { normalizeGlobalConfig } from '../src/policy.mjs';

const GOOD = `Done.
## Diff
- src/a.mjs — change
## Tests
PASS — node --test — 12 passed
## Risks
none`;
const FAILING = `Done.
## Diff
- src/a.mjs — change
## Tests
FAIL — node --test — 1 failed
## Risks
none`;
const REVIEW = `## Review Findings
Looks good.
## Evidence
inspected src/a.mjs
## Risks
none
## Verdict
approved`;
const READ_ONLY = `Checked package metadata.
## Diff
no files changed
## Tests
PASS — read package.json — name and version confirmed
NOT RUN — build — read-only task with no code changes
## Risks
none`;
const READ_ONLY_PASS = `Checked package metadata.
## Diff
no files changed
## Tests
PASS — read package.json — name and version confirmed
## Risks
none`;

const WORKER_RESULT = GOOD;

function makeAdapter({ workers, reviews = [], candidateOverride, getConfigPatch = {}, alloc = true } = {}) {
  let wIdx = 0;
  let rIdx = 0;
  let candidateCalls = 0;
  const cancelled = [];
  const attempts = [];
  return {
    config: normalizeGlobalConfig({ ...getConfigPatch }),
    cancelled,
    attempts,
    executeAttempt: async (spec) => {
      attempts.push(spec);
      if (spec.role === 'reviewer') {
        const r = (reviews && reviews[rIdx]) ?? { status: 'done', result: REVIEW, stopReason: 'completed' };
        rIdx += 1;
        return { id: `review-${rIdx}`, role: 'reviewer', attempt: 0, provider: 'p', model: 'm-review', selection_source: 'policy', ...r };
      }
      const w = workers && workers[wIdx];
      wIdx += 1;
      if (w === 'throw') throw new Error('boom');
      const result = w && typeof w === 'string' ? w : WORKER_RESULT;
      return { id: `w${wIdx}`, role: 'worker', attempt: spec.attempt, provider: 'p', model: spec.attempt > 0 ? 'm-strong' : 'm-cheap', selection_source: 'policy', status: 'done', result, stopReason: 'completed' };
    },
    cancelAttempt: async (id) => { cancelled.push(id); },
    allocateWorkspace: alloc === false ? () => ({ ok: false, reason: 'ISOLATION_UNAVAILABLE', error: 'not a git repo' }) : async (spec) => {
      const c = this?.config ?? getConfigPatch;
      return { ok: true, execution_cwd: spec.cwd, base_revision: 'abc123', isolation: 'worktree', primary_workspace_dirty: false, handle: 'wt-1' };
    },
    captureCandidate: async () => {
      candidateCalls += 1;
      return { ok: true, kind: 'git-worktree', base_revision: 'abc123', changed_files: ['src/a.mjs'], patch: 'diff --git a/src/a.mjs b/src/a.mjs', fingerprint: candidateOverride && candidateCalls > 1 ? 'MUTATED' : 'fp-1' };
    },
    releaseWorkspace: async () => ({ ok: true }),
    buildReviewTask: (task, view) => `review: ${task}`,
    getConfig: () => ({ ...getConfigPatch }),
  };
}

function idFactory() { let i = 0; return () => `wf-${++i}`; }
const cfg = (patch = {}) => normalizeGlobalConfig({ ...patch });

// ---------- transition guard ----------

test('canTransition guards legal and illegal phase moves', () => {
  assert.equal(canTransition(JOB_PHASES.RUNNING, JOB_PHASES.VERIFYING), true);
  assert.equal(canTransition(JOB_PHASES.VERIFYING, JOB_PHASES.ESCALATING), true);
  assert.equal(canTransition(JOB_PHASES.ESCALATING, JOB_PHASES.RUNNING), true);
  assert.equal(canTransition(JOB_PHASES.VERIFYING, JOB_PHASES.REVIEWING), true);
  assert.equal(canTransition(JOB_PHASES.COMPLETED, JOB_PHASES.RUNNING), false);
  assert.equal(canTransition(JOB_PHASES.FAILED, JOB_PHASES.REVIEWING), false);
  assert.equal(canTransition(JOB_PHASES.CANCELLED, JOB_PHASES.ESCALATING), false);
  assert.equal(canTransition(JOB_PHASES.RUNNING, JOB_PHASES.CANCELLED), true);
});

// ---------- success ----------

test('worker success -> completed with one attempt and a candidate', async () => {
  const a = makeAdapter();
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 'do it', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(job.phase, JOB_PHASES.COMPLETED);
  assert.equal(v.status, 'done');
  assert.equal(v.attempt, 1);
  assert.equal(v.candidate_available, true);
  assert.equal(v.outcome.task_status, 'success');
});

test('explicit no-change analysis completes when read evidence passes and the candidate is empty', async () => {
  const a = makeAdapter({ workers: [READ_ONLY], getConfigPatch: { collaboration_mode: 'flash-only', escalate_on_failure: false } });
  a.captureCandidate = async () => ({
    ok: true, kind: 'git-worktree', base_revision: 'abc123', changed_files: [], patch: '', fingerprint: 'empty-fp',
  });
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 'read package metadata', cwd: '/repo', allow_no_changes: true });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'done');
  assert.equal(v.outcome.task_status, 'success');
  assert.equal(v.outcome.workspace_evidence_ok, true);
  assert.deepEqual(v.outcome.changes, []);
  assert.equal(v.allow_no_changes, true);
});

test('no-change analysis still fails closed when the isolated candidate contains edits', async () => {
  const a = makeAdapter({ workers: [READ_ONLY], getConfigPatch: { collaboration_mode: 'flash-only', escalate_on_failure: false } });
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 'read package metadata', cwd: '/repo', allow_no_changes: true });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'failed');
  assert.equal(v.outcome.workspace_evidence_ok, false);
});

test('shared isolation cannot bypass explicit zero-change authorization', async () => {
  const a = makeAdapter({ workers: [READ_ONLY_PASS], getConfigPatch: { collaboration_mode: 'flash-only', escalate_on_failure: false } });
  a.allocateWorkspace = async (spec) => ({
    ok: true, execution_cwd: spec.cwd, base_revision: 'abc123', isolation: 'shared', primary_workspace_dirty: false, handle: null,
  });
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 'read package metadata', cwd: '/repo', allow_no_changes: false });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'failed');
  assert.equal(v.outcome.task_status, 'partial');
  assert.equal(v.outcome.no_change_verified, undefined);
});

test('candidate capture failure cannot authorize a zero-change success', async () => {
  const a = makeAdapter({ workers: [READ_ONLY_PASS], getConfigPatch: { collaboration_mode: 'flash-only', escalate_on_failure: false } });
  a.captureCandidate = async () => null;
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 'read package metadata', cwd: '/repo', allow_no_changes: true });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'failed');
  assert.equal(v.outcome.task_status, 'partial');
  assert.equal(v.candidate_capture_failed, true);
  assert.equal(v.outcome.no_change_verified, undefined);
});

test('worker lifecycle exposes ordered canonical events without candidate payloads', async () => {
  const a = makeAdapter();
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory, clock: (() => { let now = 100; return () => now++; })() });
  const job = rt.start({ role: 'worker', task: 'do it', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.deepEqual(v.canonical_events.map((event) => event.type), [
    'job.created',
    'job.started',
    'worker.started',
    'model.selected',
    'worker.completed',
    'job.completed',
  ]);
  assert.deepEqual(v.canonical_events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
  assert.equal(v.canonical_events.at(-1).job_id, job.id);
  assert.doesNotMatch(JSON.stringify(v.canonical_events), /diff --git/);
});

test('optional client job id is echoed without replacing the internal workflow id', async () => {
  const a = makeAdapter();
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 'do it', cwd: '/repo', client_job_id: 'client-42' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.notEqual(v.id, 'client-42');
  assert.equal(v.client_job_id, 'client-42');
  assert.equal(v.canonical_events[0].data.client_job_id, 'client-42');
});

// ---------- escalation on FAIL tests ----------

test('FAIL tests escalate to a stronger second attempt then succeed', async () => {
  const a = makeAdapter({ workers: [FAILING, GOOD], getConfigPatch: { collaboration_mode: 'balanced', escalate_on_failure: true } });
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id);
  assert.equal(v.status, 'done');
  assert.equal(v.attempt, 2, 'two attempts ran');
  assert.equal(v.decision.step, 'accept');
  assert.equal(a.attempts[1].attempt, 1);
  assert.equal(a.attempts[1].model, undefined); // model chosen by adapter, flow passes attempt only
  const full = rt.get(job.id, { withResult: true });
  assert.equal(full.canonical_events.filter((event) => event.type === 'model.fallback').length, 1);
  assert.equal(full.canonical_events.find((event) => event.type === 'model.fallback').data.reason, 'tests_failed');
});

test('max attempts reached stops escalation without an extra run', async () => {
  // escalating twice past max_attempts=2 -> fail after attempts 0,1
  const a = makeAdapter({ workers: [FAILING, FAILING], getConfigPatch: { collaboration_mode: 'balanced', escalate_on_failure: true, worker: undefined } });
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id);
  assert.equal(v.status, 'failed');
  assert.equal(v.attempt, 2, 'exactly 2 attempts, no third');
});

test('infrastructure failure does not escalate the model', async () => {
  const a = makeAdapter({ workers: ['infra'], getConfigPatch: { collaboration_mode: 'balanced', escalate_on_failure: true } });
  // mark the sole attempt as infra
  const orig = a.executeAttempt;
  a.executeAttempt = async (spec) => ({ ...(await orig(spec)), infra: true, error: 'DEEPSEEK_API_KEY missing', status: 'failed' });
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id);
  assert.equal(v.status, 'failed');
  assert.equal(v.error_code, WORKFLOW_ERROR_CODES.ATTEMPT_INFRA_FAILURE);
  assert.equal(v.attempt, 1, 'no escalation attempt');
  const full = rt.get(job.id, { withResult: true });
  assert.equal(full.canonical_events.at(-1).type, 'job.failed');
  assert.equal(full.canonical_events.at(-1).data.error_code, WORKFLOW_ERROR_CODES.ATTEMPT_INFRA_FAILURE);
  assert.doesNotMatch(JSON.stringify(full.canonical_events), /DEEPSEEK_API_KEY/);
});

// ---------- automatic review ----------

test('automatic reviewer runs after a verified worker and parses the verdict', async () => {
  const a = makeAdapter({ getConfigPatch: { collaboration_mode: 'review-pipeline' } });
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'done');
  assert.equal(v.review.verdict, 'approve');
  assert.equal(v.review.verdict, 'approve');
  assert.equal(v.review.mutated_candidate, undefined);
  assert.deepEqual(v.canonical_events.map((event) => event.type), [
    'job.created', 'job.started', 'worker.started', 'model.selected',
    'worker.completed', 'review.started', 'model.selected',
    'review.completed', 'job.completed',
  ]);
});

for (const failedCapture of [1, 2]) {
  test(`automatic review retains workspace when capture ${failedCapture} fails`, async () => {
    const a = makeAdapter({ getConfigPatch: { collaboration_mode: 'review-pipeline' } });
    const capture = a.captureCandidate;
    let count = 0;
    a.captureCandidate = async () => ++count === failedCapture ? null : capture();
    let released = false;
    a.releaseWorkspace = async () => { released = true; return { ok: true }; };
    const rt = createWorkflowRuntime(a, { idFactory });
    const job = rt.start({ role: 'worker', task: 't', cwd: '/repo' });
    await rt.wait(job.id, 2000);
    const view = rt.get(job.id, { withResult: true });
    assert.equal(view.status, 'failed');
    assert.equal(view.error_code, 'REVIEW_EVIDENCE_UNAVAILABLE');
    assert.equal(view.workspace_retained, true);
    assert.equal(released, false);
  });
}

test('reviewer that modifies the candidate is flagged and candidate kept', async () => {
  const a = makeAdapter({ getConfigPatch: { collaboration_mode: 'review-pipeline' }, candidateOverride: true });
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  // Fail-closed: a reviewer that mutated the candidate cannot approve its own
  // mutation — the workflow must surface as failed, never as a false done.
  assert.equal(v.status, 'failed');
  assert.equal(v.error_code, 'REVIEW_CHANGES_REQUESTED');
  assert.equal(v.review.mutated_candidate, true);
  assert.equal(v.review.verdict, 'request_changes');
  assert.equal(v.candidate.fingerprint, 'fp-1', 'implementation candidate stays the pre-review snapshot');
  assert.ok(!v.canonical_events.some((event) => event.type === 'job.completed'), 'no job.completed event may exist');
});

// ---------- explicit reviewer job ----------

test('explicit reviewer role runs a single reviewer pass', async () => {
  const a = makeAdapter({ reviews: [{ status: 'done', result: REVIEW, stopReason: 'completed' }] });
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'reviewer', task: 'review x', cwd: '/repo', source: 'test', delivery: 'review' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'done');
  assert.equal(v.role, 'reviewer');
  assert.equal(v.review.verdict, 'approve');
  assert.ok(a.attempts.length === 1 && a.attempts[0].role === 'reviewer');
  assert.equal(a.attempts[0].task, 'review x', 'an explicit reviewer must inspect the caller task directly, not an empty automatic-review capsule');
});

// ---------- async parity ----------

test('blocking and async reach the same workflow final state (runtime parity)', async () => {
  const byId = { a: makeAdapter({ getConfigPatch: { collaboration_mode: 'review-pipeline' } }), b: makeAdapter({ getConfigPatch: { collaboration_mode: 'review-pipeline' } }) };
  const ra = createWorkflowRuntime(byId.a, { maxParallel: 2, idFactory });
  const rb = createWorkflowRuntime(byId.b, { maxParallel: 2, idFactory });
  // blocking
  const jb = ra.start({ role: 'worker', task: 't', cwd: '/repo', source: 'run' });
  await ra.wait(jb.id, 2000);
  const blocking = ra.get(jb.id, { withResult: true });
  // async: spawn then wait on the result
  const jn = rb.start({ role: 'worker', task: 't', cwd: '/repo', source: 'spawn' });
  await rb.wait(jn.id, 2000);
  const asyncV = rb.get(jn.id, { withResult: true });
  for (const k of ['phase', 'status', 'attempt', 'outcome.task_status', 'review.verdict', 'candidate_available']) {
    const a = k.split('.').reduce((o, p) => o?.[p], blocking);
    const b = k.split('.').reduce((o, p) => o?.[p], asyncV);
    assert.deepEqual(a, b, `parity mismatch on ${k}`);
  }
});

// ---------- concurrency queue ----------

test('max_parallel queues extra workflows and starts them as slots free', async () => {
  const a = makeAdapter({});
  let release;
  const gate = new Promise((res) => { release = res; });
  const orig = a.executeAttempt;
  let call = 0;
  a.executeAttempt = async (spec) => {
    call += 1;
    if (call <= 2) await gate; // hold A and B running
    return orig(spec);
  };
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const A = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 's' });
  const B = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 's' });
  const C = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 's' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(A.phase, JOB_PHASES.RUNNING);
  assert.equal(B.phase, JOB_PHASES.RUNNING);
  assert.equal(C.phase, JOB_PHASES.QUEUED, 'third workflow queued');
  release();
  await rt.wait(A.id, 1000); await rt.wait(B.id, 1000); await rt.wait(C.id, 1000);
  assert.equal(C.phase, JOB_PHASES.COMPLETED, 'queued workflow runs after a slot frees');
});

// ---------- cancellation ----------

test('cancelling a running workflow cancels the active attempt and never escalates', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const a = makeAdapter({});
  const orig = a.executeAttempt;
  let call = 0;
  a.executeAttempt = async (spec) => {
    if (spec.attempt === 0) { call += 1; await gate; }
    return orig(spec);
  };
  const rt = createWorkflowRuntime(a, { maxParallel: 1, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 's' });
  await new Promise((r) => setTimeout(r, 20));
  const cancelled = await rt.cancel(job.id);
  release();
  assert.equal(cancelled.phase, JOB_PHASES.CANCELLED);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(a.cancelled.includes(job.currentAttemptId ?? Object.values(job.attempts)[0]?.id) || a.cancelled.length === 1);
  await new Promise((r) => setTimeout(r, 20));
  const after = rt.get(job.id);
  assert.equal(after.phase, JOB_PHASES.CANCELLED);
  const full = rt.get(job.id, { withResult: true });
  assert.equal(full.canonical_events.at(-1).type, 'job.cancelled');
});

test('cancelling a queued workflow removes it without running', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const a = makeAdapter({});
  const orig = a.executeAttempt;
  let call = 0;
  a.executeAttempt = async (spec) => { if (call++ === 0) await gate; return orig(spec); };
  const rt = createWorkflowRuntime(a, { maxParallel: 1, idFactory });
  const A = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 's' });
  const B = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 's' }); // queued
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(B.phase, JOB_PHASES.QUEUED);
  await rt.cancel(B.id);
  release();
  await rt.wait(A.id, 2000);
  assert.equal(B.phase, JOB_PHASES.CANCELLED, 'queued job never ran');
  assert.ok(a.attempts.length === 1, 'only A executed');
});

// ---------- candidate lifecycle & reviewer inputs ----------

test('candidate capture failure retains the worktree instead of deleting it', async () => {
  const a = makeAdapter({});
  a.captureCandidate = async () => null; // capture always fails
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'done', 'business result is preserved despite capture failure');
  assert.equal(v.candidate_capture_failed, true);
  assert.equal(v.workspace_retained, true, 'worktree kept for debug, never deleted');
  assert.equal(v.candidate, null);
});

test('automatic reviewer input includes the sanitized candidate', async () => {
  const a = makeAdapter({ getConfigPatch: { collaboration_mode: 'review-pipeline' } });
  let lastView = null;
  a.buildReviewTask = (task, view) => { lastView = view; return 'review'; };
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'done');
  assert.ok(lastView && lastView.candidate, 'reviewer must receive the candidate');
  assert.ok(lastView.candidate.changed_files.includes('src/a.mjs'));
});

test('profile review strictness reaches the reviewer prompt builder', async () => {
  const a = makeAdapter({ getConfigPatch: { collaboration_mode: 'review-pipeline' } });
  let options = null;
  a.buildReviewTask = (task, view, received) => { options = received; return 'review'; };
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', review_strictness: 'strict' });
  await rt.wait(job.id, 2000);
  assert.equal(options?.strictness, 'strict');
});

test('stable profile routing disables adaptive reordering for the attempt', async () => {
  const a = makeAdapter({ getConfigPatch: { worker: { model_policy: { adaptive: { enabled: true } } } } });
  const rt = createWorkflowRuntime(a, { maxParallel: 2, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', routing: 'stable' });
  await rt.wait(job.id, 2000);
  assert.equal(a.attempts[0].policy.adaptive.enabled, false);
  assert.equal(rt.get(job.id).routing, 'stable');
});

// ---------- cleanup truthfulness ----------

test('failed worktree cleanup reports workspace_retained with a cleanup warning', async () => {
  const a = makeAdapter({ workers: ['throw'] });
  a.releaseWorkspace = async () => ({ ok: false, error: 'worktree locked: permission denied' });
  const rt = createWorkflowRuntime(a, { maxParallel: 1, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.phase, JOB_PHASES.FAILED);
  assert.equal(v.workspace_retained, true, 'failed cleanup must never claim a clean release');
  assert.match(v.cleanup_warning, /worktree locked/);
});

test('cleanup adapter exceptions surface as retained workspace with a warning', async () => {
  const a = makeAdapter({ workers: ['throw'] });
  a.releaseWorkspace = async () => { throw new Error('release exploded'); };
  const rt = createWorkflowRuntime(a, { maxParallel: 1, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id);
  assert.equal(v.workspace_retained, true);
  assert.match(v.cleanup_warning, /release exploded/);
});

test('successful cleanup reports workspace_retained false and no warning even after a failed job', async () => {
  const a = makeAdapter({ workers: ['throw'] });
  const rt = createWorkflowRuntime(a, { maxParallel: 1, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 'test' });
  await rt.wait(job.id, 2000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.phase, JOB_PHASES.FAILED);
  assert.equal(v.workspace_retained, false);
  assert.equal(v.cleanup_warning, null);
});

test('cancelled workflows still run cleanup and report a truthful release', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const a = makeAdapter({});
  const orig = a.executeAttempt;
  a.executeAttempt = async (spec) => { if (spec.attempt === 0) await gate; return orig(spec); };
  let releaseCalls = 0;
  a.releaseWorkspace = async () => { releaseCalls += 1; return { ok: true }; };
  const rt = createWorkflowRuntime(a, { maxParallel: 1, idFactory });
  const job = rt.start({ role: 'worker', task: 't', cwd: '/repo', source: 'test' });
  await new Promise((r) => setTimeout(r, 20));
  await rt.cancel(job.id);
  release();
  await new Promise((r) => setTimeout(r, 20));
  const v = rt.get(job.id);
  assert.equal(v.phase, JOB_PHASES.CANCELLED);
  assert.equal(v.workspace_retained, false);
  assert.equal(v.cleanup_warning, null);
  assert.ok(releaseCalls >= 1, 'cleanup ran for the cancelled workflow');
});

// ---------- verdict normalizer ----------

test('normalizeReviewVerdict handles free text', () => {
  assert.equal(normalizeReviewVerdict('APPROVED'), 'approve');
  assert.equal(normalizeReviewVerdict('PASS'), 'approve');
  assert.equal(normalizeReviewVerdict('Request changes: fix the tests'), 'request_changes');
  assert.equal(normalizeReviewVerdict('REJECTED'), 'request_changes');
  assert.equal(normalizeReviewVerdict('not sure'), 'inconclusive');
});
