// PR2 unified job workflow tests: structured outcome normalization, task
// classification, evidence-driven next-step decisions, and the run/spawn
// parity guarantee. Pure — no DSH, hub or worker runtime involved.
// Run with: node --test test/workflow.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorkspaceEvidence,
  JOB_PHASES,
  isTerminalPhase,
  classifyTaskStatus,
  buildOutcome,
  decideNextStep,
  parityStep,
} from '../src/workflow.mjs';

const POLICY = { escalation: { enabled: true, max_attempts: 2 } };

const GOOD_RESULT = `Done.
## Diff
- src/a.mjs — added function
## Tests
PASS — node --test — 12 passed
## Risks
none`;
const FAILING_RESULT = `Done.
## Diff
- src/a.mjs — added function
## Tests
FAIL — node --test — 1 failed
## Risks
none`;
const INCOMPLETE_RESULT = `I did it.`;
const READ_ONLY_RESULT = `Checked package metadata.
## Diff
no files changed
## Tests
PASS — read package.json — name and version confirmed
NOT RUN — build — read-only task with no code changes
## Risks
none`;

// ---------- classifyTaskStatus ----------

test('completed + PASS -> success', () => {
  assert.equal(classifyTaskStatus({ executionStatus: 'completed', testsStatus: 'PASS', deliveryComplete: true }), 'success');
});

test('process failed -> failed even with a delivery report', () => {
  assert.equal(classifyTaskStatus({ executionStatus: 'failed', testsStatus: 'PASS', deliveryComplete: true }), 'failed');
});

test('FAIL tests -> partial', () => {
  assert.equal(classifyTaskStatus({ executionStatus: 'completed', testsStatus: 'FAIL', deliveryComplete: true }), 'partial');
});

test('NOT RUN tests -> partial (unverified is visible, not success)', () => {
  assert.equal(classifyTaskStatus({ executionStatus: 'completed', testsStatus: 'NOT RUN', deliveryComplete: true }), 'partial');
});

test('missing delivery -> blocked', () => {
  assert.equal(classifyTaskStatus({ executionStatus: 'completed', deliveryComplete: false }), 'blocked');
});

// ---------- buildOutcome ----------

test('good delivery report normalizes to a structured success outcome', () => {
  const o = buildOutcome({ result: GOOD_RESULT, stopReason: 'completed' });
  assert.equal(o.execution_status, 'completed');
  assert.equal(o.task_status, 'success');
  assert.equal(o.delivery.complete, true);
  assert.ok(o.changes.length >= 1);
  assert.ok(o.tests.every((t) => ['PASS', 'FAIL', 'NOT RUN'].includes(t.status)));
  assert.equal(o.tests_status, 'PASS');
});

test('the contract no-change sentinel is not treated as a claimed file change', () => {
  const o = buildOutcome({ result: READ_ONLY_RESULT, stopReason: 'completed' });
  assert.deepEqual(o.changes, []);
  assert.equal(o.tests_status, 'NOT RUN');
});

test('workspace evidence promotes only an explicitly verified zero-change result', () => {
  const outcome = buildOutcome({ result: READ_ONLY_RESULT, stopReason: 'completed' });
  const verified = applyWorkspaceEvidence(outcome, {
    evidenceAvailable: true,
    hasChanges: false,
    allowNoChanges: true,
  });
  assert.equal(verified.workspace_evidence_ok, true);
  assert.equal(verified.no_change_verified, true);
  assert.equal(verified.task_status, 'success');

  const mismatch = applyWorkspaceEvidence(outcome, {
    evidenceAvailable: true,
    hasChanges: true,
    allowNoChanges: true,
  });
  assert.equal(mismatch.workspace_evidence_ok, false);
  assert.equal(mismatch.no_change_verified, undefined);
  assert.equal(mismatch.task_status, 'partial');
});

test('FAIL tests surface as partial with needs-escalation evidence', () => {
  const o = buildOutcome({ result: FAILING_RESULT, stopReason: 'completed' });
  assert.equal(o.task_status, 'partial');
  assert.equal(o.tests_status, 'FAIL');
});

test('missing delivery report -> blocked outcome, missing sections listed', () => {
  const o = buildOutcome({ result: INCOMPLETE_RESULT, stopReason: 'completed' });
  assert.equal(o.task_status, 'blocked');
  assert.equal(o.delivery.complete, false);
  assert.ok(o.delivery.missing.includes('Tests'));
});

test('execution failed -> task failed regardless of text', () => {
  const o = buildOutcome({ result: '', executionStatus: 'failed' });
  assert.equal(o.task_status, 'failed');
});

// ---------- decideNextStep ----------

test('verified worker -> accept (ready)', () => {
  const o = buildOutcome({ result: GOOD_RESULT, stopReason: 'completed' });
  const s = decideNextStep({ outcome: o, policy: POLICY, attempt: 0 });
  assert.equal(s.step, 'accept');
  assert.equal(s.phase, JOB_PHASES.READY);
});

test('failing tests -> escalate with a stronger attempt', () => {
  const o = buildOutcome({ result: FAILING_RESULT, stopReason: 'completed' });
  const s = decideNextStep({ outcome: o, policy: POLICY, attempt: 0 });
  assert.equal(s.step, 'escalate');
  assert.equal(s.phase, JOB_PHASES.ESCALATING);
});

test('incomplete delivery -> escalate', () => {
  const o = buildOutcome({ result: INCOMPLETE_RESULT, stopReason: 'completed' });
  assert.equal(decideNextStep({ outcome: o, policy: POLICY, attempt: 0 }).step, 'escalate');
});

test('review is requested after a verified attempt when the reviewer is Auto', () => {
  const o = buildOutcome({ result: GOOD_RESULT, stopReason: 'completed' });
  const s = decideNextStep({ outcome: o, policy: POLICY, attempt: 0, reviewRequested: true, reviewerAuto: true });
  assert.equal(s.step, 'review');
  assert.equal(s.phase, JOB_PHASES.REVIEWING);
});

test('review request is skipped when the reviewer is not Auto', () => {
  const o = buildOutcome({ result: GOOD_RESULT, stopReason: 'completed' });
  const s = decideNextStep({ outcome: o, policy: POLICY, attempt: 0, reviewRequested: true, reviewerAuto: false });
  assert.equal(s.step, 'accept');
});

test('escalation disabled -> verified result accepts, failed result fails', () => {
  const noEsc = { escalation: { enabled: false, max_attempts: 2 } };
  const ok = buildOutcome({ result: GOOD_RESULT, stopReason: 'completed' });
  const bad = buildOutcome({ result: FAILING_RESULT, stopReason: 'completed' });
  assert.equal(decideNextStep({ outcome: ok, policy: noEsc, attempt: 0 }).step, 'accept');
  assert.equal(decideNextStep({ outcome: bad, policy: noEsc, attempt: 0 }).step, 'fail');
});

test('max attempts reached -> fail (no infinite escalation)', () => {
  const toFail = buildOutcome({ result: INCOMPLETE_RESULT, stopReason: 'completed' });
  const s = decideNextStep({ outcome: toFail, policy: POLICY, attempt: 2 });
  assert.equal(s.step, 'fail');
  assert.equal(s.reason, 'max_attempts_reached');
});

// ---------- parity ----------

test('run and spawn reach the same next step for the same spec (parity)', () => {
  const spec = (result) => ({
    outcome: buildOutcome({ result, stopReason: 'completed' }),
    policy: POLICY,
    attempt: 0,
    reviewRequested: true,
    reviewerAuto: true,
  });
  assert.equal(parityStep(spec(GOOD_RESULT)), 'review');
  assert.equal(parityStep(spec(FAILING_RESULT)), 'escalate');
});

// ---------- phases ----------

test('terminal phases are recognized', () => {
  for (const p of [JOB_PHASES.COMPLETED, JOB_PHASES.FAILED, JOB_PHASES.CANCELLED, JOB_PHASES.INTERRUPTED]) {
    assert.equal(isTerminalPhase(p), true);
  }
  assert.equal(isTerminalPhase(JOB_PHASES.RUNNING), false);
  assert.equal(isTerminalPhase(JOB_PHASES.REVIEWING), false);
});
