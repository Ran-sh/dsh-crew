// Focused regression tests for the explicit reviewer acceptance gate.
//
// An explicit reviewer job must fail closed unless the reviewer result has:
//   status === 'done'
//   delivery_complete === true
//   verdict === 'approve'
// request_changes, failed execution, or an incomplete review contract must
// leave the workflow terminal failed and must never emit job.completed.
//
// Run with: node --test test/explicit-reviewer-gate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowRuntime } from '../src/workflow-runtime.mjs';
import { JOB_PHASES } from '../src/workflow.mjs';
import { normalizeGlobalConfig } from '../src/policy.mjs';

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

let wfSeq = 0;

function makeAdapter({ review } = {}) {
  const defaultReview = { status: 'done', result: REVIEW_APPROVED, stopReason: 'completed' };
  return {
    executeAttempt: async (spec) => {
      assert.equal(spec.role, 'reviewer');
      return {
        id: 'review-1',
        role: 'reviewer',
        attempt: 0,
        provider: 'p',
        model: 'm-review',
        selection_source: 'policy',
        ...(review ?? defaultReview),
      };
    },
    cancelAttempt: async () => {},
    allocateWorkspace: async (spec) => ({
      ok: true,
      execution_cwd: spec.cwd,
      base_revision: 'abc123',
      isolation: 'worktree',
      primary_workspace_dirty: false,
      handle: 'wt-1',
    }),
    captureCandidate: async () => ({
      ok: true,
      kind: 'git-worktree',
      base_revision: 'abc123',
      changed_files: [],
      patch: '',
      fingerprint: 'fp-review',
    }),
    releaseWorkspace: async () => ({ ok: true }),
    buildReviewTask: (task) => `review: ${task}`,
    getConfig: () => normalizeGlobalConfig({}),
  };
}

function idFactory() {
  return () => `explicit-review-${++wfSeq}`;
}

async function runExplicitReview(review) {
  const rt = createWorkflowRuntime(makeAdapter({ review }), { idFactory });
  const job = rt.start({ role: 'reviewer', task: 'review x', cwd: '/repo', source: 'test', delivery: 'review' });
  await rt.wait(job.id, 2000);
  return rt.get(job.id, { withResult: true });
}

test('explicit reviewer approve still finalizes as done (baseline preserved)', async () => {
  const v = await runExplicitReview({ status: 'done', result: REVIEW_APPROVED, stopReason: 'completed' });
  assert.equal(v.status, 'done');
  assert.equal(v.phase, JOB_PHASES.COMPLETED);
  assert.equal(v.review.status, 'done');
  assert.equal(v.review.delivery_complete, true);
  assert.equal(v.review.verdict, 'approve');
});

test('explicit reviewer request_changes fails the workflow (no false done)', async () => {
  const v = await runExplicitReview({ status: 'done', result: REVIEW_REQUEST_CHANGES, stopReason: 'completed' });
  assert.equal(v.status, 'failed');
  assert.equal(v.phase, JOB_PHASES.FAILED);
  assert.equal(v.error_code, 'REVIEW_CHANGES_REQUESTED');
  assert.equal(v.review.verdict, 'request_changes');
  assert.ok(v.canonical_events.some((e) => e.type === 'job.failed'), 'terminal event must be job.failed');
  assert.ok(!v.canonical_events.some((e) => e.type === 'job.completed'), 'no job.completed event may exist');
});

test('explicit reviewer incomplete review contract fails the workflow', async () => {
  const v = await runExplicitReview({ status: 'done', result: REVIEW_INCOMPLETE, stopReason: 'completed' });
  assert.equal(v.status, 'failed');
  assert.equal(v.phase, JOB_PHASES.FAILED);
  assert.equal(v.error_code, 'REVIEW_INCONCLUSIVE');
  assert.equal(v.review.delivery_complete, false);
  assert.equal(v.review.verdict, 'inconclusive');
  assert.ok(v.canonical_events.some((e) => e.type === 'job.failed'), 'terminal event must be job.failed');
  assert.ok(!v.canonical_events.some((e) => e.type === 'job.completed'), 'no job.completed event may exist');
});

test('explicit reviewer failed execution fails the workflow', async () => {
  const v = await runExplicitReview({ status: 'failed', result: '', stopReason: 'error', error: 'reviewer boom' });
  assert.equal(v.status, 'failed');
  assert.equal(v.phase, JOB_PHASES.FAILED);
  assert.equal(v.error_code, 'REVIEW_INCONCLUSIVE');
  assert.equal(v.review.delivery_complete, false);
  assert.equal(v.review.status, 'failed');
  assert.ok(v.canonical_events.some((e) => e.type === 'job.failed'), 'terminal event must be job.failed');
  assert.ok(!v.canonical_events.some((e) => e.type === 'job.completed'), 'no job.completed event may exist');
});

// A reviewer's read-only-ness has to be provable in whichever workspace it was
// given. A shared workspace has no allocator worktree to compare against, so the
// client has to fingerprint the tree around the attempt itself; without that the
// reviewer is the one actor whose edits nothing observes, and an editing reviewer
// was accepted as `approve`.
function makeSharedAdapter({ fingerprints = [] } = {}) {
  const adapters = makeAdapter();
  let captures = 0;
  adapters.allocateWorkspace = async (spec) => ({
    ok: true,
    execution_cwd: spec.cwd,
    base_revision: null,
    isolation: 'shared',
    primary_workspace_dirty: false,
    handle: null,
  });
  adapters.captureCandidate = async () => {
    const fingerprint = fingerprints[captures] ?? fingerprints.at(-1) ?? 'fp-shared';
    captures += 1;
    return {
      ok: true,
      kind: 'git-worktree',
      base_revision: 'abc123',
      changed_files: [],
      patch: '',
      fingerprint,
    };
  };
  return { adapters, captures: () => captures };
}

async function runSharedReview(adapterOptions) {
  const { adapters, captures } = makeSharedAdapter(adapterOptions);
  const rt = createWorkflowRuntime(adapters, { idFactory });
  const job = rt.start({ role: 'reviewer', task: 'review x', cwd: '/repo', source: 'test', delivery: 'review' });
  await rt.wait(job.id, 2000);
  return { view: rt.get(job.id, { withResult: true }), captures };
}

test('a shared-workspace reviewer that mutates the tree is not accepted as approve', async () => {
  const { view, captures } = await runSharedReview({ fingerprints: ['fp-before', 'fp-after'] });
  assert.equal(view.status, 'failed');
  assert.equal(view.error_code, 'REVIEW_CHANGES_REQUESTED');
  assert.equal(view.review.mutated_candidate, true);
  assert.equal(view.review.invalidated, true);
  assert.equal(view.review.verdict, 'request_changes');
  assert.ok(captures() >= 2, 'shared isolation must fingerprint the tree around the review');
  assert.ok(!view.canonical_events.some((e) => e.type === 'job.completed'), 'no job.completed event may exist');
});

test('a shared-workspace reviewer that leaves the tree untouched is still accepted', async () => {
  const { view, captures } = await runSharedReview({ fingerprints: ['fp-same', 'fp-same'] });
  assert.equal(view.status, 'done');
  assert.equal(view.review.verdict, 'approve');
  assert.equal(view.review.mutated_candidate, undefined);
  assert.ok(captures() >= 2, 'shared isolation must fingerprint the tree around the review');
});

test('a reviewer with no capturable evidence fails closed in a shared workspace too', async () => {
  const adapters = makeAdapter();
  adapters.allocateWorkspace = async (spec) => ({
    ok: true,
    execution_cwd: spec.cwd,
    base_revision: null,
    isolation: 'shared',
    primary_workspace_dirty: false,
    handle: null,
  });
  adapters.captureCandidate = async () => null;
  const rt = createWorkflowRuntime(adapters, { idFactory });
  const job = rt.start({ role: 'reviewer', task: 'review x', cwd: '/repo', source: 'test', delivery: 'review' });
  await rt.wait(job.id, 2000);
  const view = rt.get(job.id, { withResult: true });
  assert.equal(view.status, 'failed');
  assert.equal(view.error_code, 'REVIEW_EVIDENCE_UNAVAILABLE');
  assert.equal(view.workspace_retained, false, 'a shared workspace was never Crew-owned, so nothing is retained');
  assert.ok(!view.canonical_events.some((e) => e.type === 'job.completed'));
});

for (const stage of ['before', 'after']) {
  for (const failure of ['null', 'missing-fingerprint', 'throw']) {
    test(`explicit review rejects ${failure} ${stage} evidence and retains workspace`, async () => {
      const adapters = makeAdapter();
      const capture = adapters.captureCandidate;
      const execute = adapters.executeAttempt;
      let captures = 0;
      let executions = 0;
      let releases = 0;
      adapters.captureCandidate = async () => {
        if (++captures === (stage === 'before' ? 1 : 2)) {
          if (failure === 'throw') throw new Error('capture unavailable');
          return failure === 'null' ? null : { ok: true };
        }
        return capture();
      };
      adapters.executeAttempt = async (spec) => { executions++; return execute(spec); };
      adapters.releaseWorkspace = async () => { releases++; return { ok: true }; };
      const rt = createWorkflowRuntime(adapters, { idFactory });
      const job = rt.start({ role: 'reviewer', task: 'review', cwd: '/repo' });
      await rt.wait(job.id, 2000);
      const view = rt.get(job.id, { withResult: true });
      assert.equal(view.status, 'failed');
      assert.equal(view.error_code, 'REVIEW_EVIDENCE_UNAVAILABLE');
      assert.equal(view.workspace_retained, true);
      assert.equal(releases, 0);
      assert.equal(executions, stage === 'before' ? 0 : 1);
      assert.ok(!view.canonical_events.some(e => e.type === 'job.completed'));
    });
  }
}
