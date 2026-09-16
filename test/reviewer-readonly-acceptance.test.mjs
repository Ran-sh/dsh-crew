// Regression tests for read-only reviewer acceptance.
//
// A reviewer's contract is "changed nothing" and "say what you could not
// verify" — so the two rules that grade a coding worker must not double as the
// reviewer's grade:
//
//   1. the coding Tests rule. `parseDeliveryReport` reads the contract off the
//      headings present and only a coding report has a Tests obligation, but
//      `buildOutcome` parsed the Tests section unconditionally. A reviewer that
//      also listed its own coverage under `## Tests` had an honest
//      `NOT RUN — <check> — <reason>` row read as the worker's test evidence:
//      the reviewer was downgraded to `partial`, and `evidenceStatus` turned
//      that into `PARTIAL` / `TESTS_NOT_RUN` on a job that had approved.
//   2. the zero-change authorization. That one is already worker-only
//      (`applyHubWorkspaceEvidence` passes `requireNoChangeAuthorization:
//      role === 'worker'`), and these tests pin it so a reviewer is never
//      required to modify files to be accepted, while the worker gate stays.
//
// Run with: node --test test/reviewer-readonly-acceptance.test.mjs

// Must come first: the Hub appends session provenance to the home directory at
// dispatch time, and this points that at a disposable one.
import './helpers/isolated-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createWorkflowRuntime } from '../src/workflow-runtime.mjs';
import { attemptFromView } from '../src/mcp-runtime.mjs';
import { crewHarnessSessionsDir } from '../src/install/crew-paths.mjs';
import { buildOutcome, JOB_PHASES } from '../src/workflow.mjs';
import { applyHubWorkspaceEvidence } from '../src/hub/index.mjs';
import { buildEvidenceEnvelope } from '../src/job-contracts.mjs';
import { buildReviewTask } from '../src/information-flow.mjs';
import { normalizeGlobalConfig } from '../src/policy.mjs';

// The shape a real automatic reviewer produced: the review contract plus the
// worker-style Diff/Tests headings it carried over, including a NOT RUN row for
// the one check it genuinely could not repeat.
const REVIEW_WITH_DISCLOSED_NOT_RUN = `## Diff
no files changed
smoke.mjs and verify.mjs were created temporarily and deleted per the objective.

## Tests
- PASS — 18 byte length assertion — length=18
- NOT RUN — \`node verify.mjs\` exit code — the script was deleted, so it cannot be re-run; the worker reported 0

## Review Findings
The terminal state satisfies the objective.
## Evidence
the working tree is unchanged
## Risks
the script source is not recoverable
## Verdict
approved — every independently checkable hard requirement holds`;

const REVIEW_PURE = `## Review Findings
Looks good.
## Evidence
inspected src/a.mjs
## Risks
none
## Verdict
approved`;

const REVIEW_REJECT = `## Review Findings
The diff misses the edge case.
## Evidence
inspected src/a.mjs
## Risks
edge case unhandled
## Verdict
needs changes: edge case unhandled`;

const REVIEW_NO_VERDICT = `## Review Findings
Looks fine but the contract is incomplete.
## Evidence
inspected src/a.mjs
## Risks
none`;

const REVIEW_NO_CONTRACT = 'I looked at it and it seems fine.';

// A coding report that also discloses an unverified check. This is the control:
// for a worker the disclosure must still be visible and still cost the `success`.
const CODING_WITH_NOT_RUN = `## Diff
no files changed
## Tests
PASS — read package.json — name and version confirmed
NOT RUN — build — read-only task with no code changes
## Risks
none`;

// A fully verified zero-change coding report: every disclosed check passed. This
// is the shape the worker authorization gate exists for — it is only reachable
// when nothing downgraded the report first.
const CODING_ZERO_CHANGE_PASS = `## Diff
no files changed
## Tests
PASS — read package.json — name and version confirmed
## Risks
none`;

const GOOD_WORKER = `## Diff
- src/a.mjs — change
## Tests
PASS — node --test — 12 passed
## Risks
none`;

const AUTO_REVIEW = { auto_review: true, review_state: 'auto' };

let wfSeq = 0;
const idFactory = () => `wf-ro-${++wfSeq}`;

function makeRuntime({ reviews = [], getConfigPatch = {} } = {}) {
  let rIdx = 0;
  const adapter = {
    executeAttempt: async (spec) => {
      if (spec.role === 'reviewer') {
        const r = reviews[rIdx] ?? { status: 'done', result: REVIEW_PURE, stopReason: 'completed' };
        rIdx += 1;
        return {
          id: `review-${rIdx}`, role: 'reviewer', attempt: 0,
          session_id: `session-review-${rIdx}`,
          provider: 'p', model: 'm-review', selection_source: 'policy', ...r,
        };
      }
      return {
        id: 'w1', role: 'worker', attempt: spec.attempt, session_id: 'session-worker-1',
        provider: 'p', model: 'm-cheap', selection_source: 'policy',
        status: 'done', result: GOOD_WORKER, stopReason: 'completed',
      };
    },
    cancelAttempt: async () => {},
    allocateWorkspace: async (spec) => ({ ok: true, execution_cwd: spec.cwd, base_revision: 'abc123', isolation: 'worktree', primary_workspace_dirty: false, handle: 'wt-1' }),
    // Must agree with what GOOD_WORKER reports, or the workspace-evidence gate
    // fails the job before the review ever starts.
    captureCandidate: async () => ({ ok: true, kind: 'git-worktree', base_revision: 'abc123', changed_files: ['src/a.mjs'], patch: 'diff --git a/src/a.mjs b/src/a.mjs', fingerprint: 'fp-1' }),
    releaseWorkspace: async () => ({ ok: true }),
    buildReviewTask: (task, view, opts) => {
      adapter.reviewViews.push(view);
      return buildReviewTask(task, view, opts);
    },
    reviewViews: [],
    evidenceRoot: () => '/home/u/.config/dsh-crew/harness/sessions',
    getConfig: () => normalizeGlobalConfig({ ...getConfigPatch }),
  };
  adapter.runtime = createWorkflowRuntime(adapter, { idFactory });
  return adapter;
}

async function runOnce({ reviews, getConfigPatch }) {
  const adapter = makeRuntime({ reviews, getConfigPatch });
  const job = adapter.runtime.start({ role: 'worker', task: 'do it', cwd: '/repo', source: 'test' });
  await adapter.runtime.wait(job.id, 2000);
  return { view: adapter.runtime.get(job.id, { withResult: true }), adapter };
}

// ---------- 1. the coding Tests rule is not the reviewer's grade ----------

test('a review report that discloses an unverified check is still a successful outcome', () => {
  const o = buildOutcome({ result: REVIEW_WITH_DISCLOSED_NOT_RUN, stopReason: 'completed' });
  assert.equal(o.delivery.format, 'review');
  assert.equal(o.delivery.complete, true, 'the review contract itself is complete');
  assert.equal(o.tests_status, null, 'a review report has no coding Tests verdict');
  assert.deepEqual(o.tests, [], 'its Tests rows are coverage notes, not worker test evidence');
  assert.equal(o.task_status, 'success', 'an honest NOT RUN must not downgrade the reviewer');
});

test('an approved reviewer is not reported as PARTIAL through the evidence surface', () => {
  const outcome = buildOutcome({ result: REVIEW_WITH_DISCLOSED_NOT_RUN, stopReason: 'completed' });
  const envelope = buildEvidenceEnvelope({
    id: 'hub-review-1',
    role: 'reviewer',
    status: 'done',
    phase: JOB_PHASES.COMPLETED,
    outcome,
    review: { verdict: 'approve', status: 'done', delivery_complete: true, mutated_candidate: false },
  });
  assert.equal(envelope.status, 'PASS', 'approve + complete delivery must not surface as PARTIAL');
  assert.equal(envelope.summary.review_verdict, 'approve');
});

test('an inconclusive reviewer verdict does not read as PASS', () => {
  const outcome = buildOutcome({ result: REVIEW_WITH_DISCLOSED_NOT_RUN, stopReason: 'completed' });
  const envelope = buildEvidenceEnvelope({
    id: 'hub-review-2',
    role: 'reviewer',
    status: 'done',
    phase: JOB_PHASES.COMPLETED,
    outcome,
    // A complete contract that declined to approve: the verdict is the product.
    review: { verdict: 'inconclusive', status: 'done', delivery_complete: true, mutated_candidate: false },
  });
  assert.equal(envelope.status, 'PARTIAL', 'a reviewer is judged by its verdict, not by contract completeness');
});

test('a pure review contract (no Diff/Tests carried over) is unchanged', () => {
  const o = buildOutcome({ result: REVIEW_PURE, stopReason: 'completed' });
  assert.equal(o.delivery.format, 'review');
  assert.equal(o.task_status, 'success');
});

test('the worker rule still applies to a coding report that discloses NOT RUN', () => {
  const o = buildOutcome({ result: CODING_WITH_NOT_RUN, stopReason: 'completed' });
  assert.equal(o.delivery.format, 'coding');
  assert.equal(o.tests_status, 'NOT RUN', 'the coding Tests rule must not be loosened');
  assert.equal(o.task_status, 'partial', 'an unverified worker check is still visible, not success');
});

// ---------- 2. the zero-change authorization stays worker-only ----------

test('the worker zero-change gate is retained and the reviewer gate is not applied', () => {
  const verifiedWorker = buildOutcome({ result: CODING_ZERO_CHANGE_PASS, stopReason: 'completed' });
  assert.equal(verifiedWorker.task_status, 'success', 'precondition: nothing else downgraded it');
  const diff = { kind: 'filesystem-empty', unchanged: true };

  const unauthorized = applyHubWorkspaceEvidence({
    outcome: verifiedWorker, workspaceDiff: diff, allowNoChanges: false, role: 'worker',
  });
  assert.equal(unauthorized.task_status, 'partial', 'an unauthorized worker claiming no change stays partial');
  assert.equal(unauthorized.no_change_verified, undefined);

  const authorized = applyHubWorkspaceEvidence({
    outcome: verifiedWorker, workspaceDiff: diff, allowNoChanges: true, role: 'worker',
  });
  assert.equal(authorized.no_change_verified, true, 'an authorized zero-change worker is still promoted');

  // The same verified report from a reviewer: a read-only role must never be
  // asked to authorize changing nothing.
  const reviewer = applyHubWorkspaceEvidence({
    outcome: verifiedWorker, workspaceDiff: diff, allowNoChanges: false, role: 'reviewer',
  });
  assert.equal(reviewer.task_status, 'success', 'a reviewer is never asked to authorize changing nothing');
});

// ---------- 3. full worker -> reviewer aggregation ----------

test('worker success + reviewer approve aggregates to one reviewed, successful workflow', async () => {
  const { view: v, adapter } = await runOnce({ reviews: [{ status: 'done', result: REVIEW_WITH_DISCLOSED_NOT_RUN, stopReason: 'completed' }], getConfigPatch: AUTO_REVIEW });
  assert.equal(v.status, 'done');
  assert.equal(v.phase, JOB_PHASES.COMPLETED);
  assert.equal(v.review.verdict, 'approve');
  assert.equal(v.review.delivery_complete, true);
  assert.equal(v.outcome.task_status, 'success');
  assert.ok(v.canonical_events.some((e) => e.type === 'review.completed'), 'the review must be part of the same workflow');
  assert.equal(v.canonical_events.find((e) => e.type === 'job.completed').data.reviewed, true);
  assert.ok(!v.canonical_events.some((e) => e.type === 'job.failed'));

  // The reviewer must be handed the *worker's* record, not its own.
  assert.equal(adapter.reviewViews.length, 1);
  const handed = adapter.reviewViews[0].evidence;
  assert.equal(handed.sessionId, 'session-worker-1', 'the pointer must name the reviewed attempt');
  assert.notEqual(handed.sessionId, 'session-review-1', 'never the reviewer itself');
  assert.equal(handed.root, '/home/u/.config/dsh-crew/harness/sessions');
});

test('reviewer reject blocks the aggregate workflow', async () => {
  const { view: v } = await runOnce({ reviews: [{ status: 'done', result: REVIEW_REJECT, stopReason: 'completed' }], getConfigPatch: AUTO_REVIEW });
  assert.equal(v.status, 'failed');
  assert.equal(v.error_code, 'REVIEW_CHANGES_REQUESTED');
  assert.ok(!v.canonical_events.some((e) => e.type === 'job.completed'));
});

test('a missing verdict blocks the aggregate workflow', async () => {
  const { view: v } = await runOnce({ reviews: [{ status: 'done', result: REVIEW_NO_VERDICT, stopReason: 'completed' }], getConfigPatch: AUTO_REVIEW });
  assert.equal(v.status, 'failed');
  assert.equal(v.error_code, 'REVIEW_INCONCLUSIVE');
});

test('a missing review contract blocks the aggregate workflow', async () => {
  const { view: v } = await runOnce({ reviews: [{ status: 'done', result: REVIEW_NO_CONTRACT, stopReason: 'completed' }], getConfigPatch: AUTO_REVIEW });
  assert.equal(v.status, 'failed');
  assert.equal(v.review.delivery_complete, false);
  assert.equal(v.error_code, 'REVIEW_INCONCLUSIVE');
});

// ---------- 4. the reviewer can reach the original execution record ----------

test('the review capsule names the reviewed attempt persisted execution record', () => {
  const prompt = buildReviewTask('objective', {
    outcome: { task_status: 'success', tests_status: 'PASS', delivery: { complete: true }, changes: [], tests: [], risks: [] },
    candidate: {},
    evidence: { sessionId: 'session-worker-1', root: '/home/u/.config/dsh-crew/harness/sessions' },
  });
  assert.match(prompt, /Persisted execution record/);
  assert.match(prompt, /session-worker-1/);
  assert.match(prompt, /\/home\/u\/\.config\/dsh-crew\/harness\/sessions/);
  assert.match(prompt, /tool\/result/);
  assert.match(prompt, /28 B5 2F FD/, 'the multi-frame zstd detail must be stated, not rediscovered');
  assert.match(prompt, /NOT RUN/);
});

test('the capsule degrades to the previous form when the store cannot be named', () => {
  const withNothing = buildReviewTask('objective', { outcome: {}, candidate: {} });
  assert.doesNotMatch(withNothing, /Persisted execution record/);
  const halfKnown = buildReviewTask('objective', { outcome: {}, candidate: {}, evidence: { sessionId: 'session-worker-1', root: null } });
  assert.doesNotMatch(halfKnown, /Persisted execution record/, 'a half-known location must not print a dead path');
});

test('the transport carries the Hub session id through to the attempt record', () => {
  const attempt = attemptFromView(
    { id: 'hub-1', sessionId: 'session-hub-42', role: 'worker', status: 'done', provider: 'p', model: 'm' },
    { role: 'worker', attempt: 0 },
  );
  assert.equal(attempt.session_id, 'session-hub-42', 'a dropped session id makes the pointer unbuildable');

  const withoutSession = attemptFromView({ id: 'hub-2', role: 'worker', status: 'done' }, { role: 'worker', attempt: 0 });
  assert.equal(withoutSession.session_id, null, 'an absent session id stays absent rather than becoming undefined text');
});

test('the evidence root is the Harness session store, not the legacy one', () => {
  const dir = crewHarnessSessionsDir({ home: '/home/u' });
  assert.equal(dir, path.join('/home/u', '.config', 'dsh-crew', 'harness', 'sessions'));
  assert.notEqual(dir, path.join('/home/u', '.config', 'dsh-crew', 'sessions'), 'the legacy DSH_SESSION_ROOT is not the store');
});

test('the pointer stays off when an attempt reports no session id', () => {
  // Guards the renderer, not the standalone transport end-to-end: this builds
  // the view by hand. What it establishes is that the half-known shape cannot
  // print. That shape is the one the retired standalone path would produce —
  // `mode` accepts only auto|hub, and its `DSH_SESSION_ROOT` is a different
  // store from the Crew harness one this pointer names — so wiring a session id
  // in there later must also point the store, or the capsule would advertise a
  // directory that does not hold the attempt's record.
  const standalone = buildReviewTask('objective', {
    outcome: { task_status: 'success', tests_status: 'PASS', delivery: { complete: true }, changes: [], tests: [], risks: [] },
    candidate: {},
    evidence: { sessionId: null, root: '/home/u/.config/dsh-crew/harness/sessions' },
  });
  assert.doesNotMatch(standalone, /Persisted execution record/);
  assert.match(standalone, /inspect the candidate directly/i, 'the plain capsule is still produced');

  // And the transport genuinely reports null rather than an empty string, which
  // is what makes the guard above reachable.
  assert.equal(attemptFromView({ id: 'job-1', role: 'worker', status: 'done' }, { role: 'worker', attempt: 0 }).session_id, null);
});

test('the execution-record pointer is a pointer, not an embedded transcript', () => {
  const prompt = buildReviewTask('objective', {
    outcome: { task_status: 'success', changes: [], tests: [], risks: [] },
    candidate: { patch: 'SECRET_PATCH_SENTINEL' },
    raw_result: 'SECRET_TRANSCRIPT_SENTINEL',
    evidence: { sessionId: 'session-worker-1', root: '/store' },
  });
  assert.match(prompt, /session-worker-1/, 'the pointer itself is present');
  assert.doesNotMatch(prompt, /SECRET_PATCH_SENTINEL/, 'the full patch stays out');
  assert.doesNotMatch(prompt, /SECRET_TRANSCRIPT_SENTINEL/, 'the raw transcript stays out');
});
