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
const READ_ONLY_PASS_RESULT = `Checked package metadata.
## Diff
no files changed
## Tests
PASS — read package.json — name and version confirmed
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

test('zero-change success requires explicit authorization even when its checks pass', () => {
  const outcome = buildOutcome({ result: READ_ONLY_PASS_RESULT, stopReason: 'completed' });
  assert.equal(outcome.task_status, 'success');

  const unauthorized = applyWorkspaceEvidence(outcome, {
    evidenceAvailable: true, hasChanges: false, allowNoChanges: false,
  });
  assert.equal(unauthorized.workspace_evidence_ok, true);
  assert.equal(unauthorized.task_status, 'partial');
  assert.equal(unauthorized.no_change_verified, undefined);

  const authorized = applyWorkspaceEvidence(outcome, {
    evidenceAvailable: true, hasChanges: false, allowNoChanges: true,
  });
  assert.equal(authorized.task_status, 'success');
  assert.equal(authorized.no_change_verified, true);
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

// ---------- the reported verdict: a temporary, verified, cleaned-up task ----------
//
// The case this guards: a worker creates a script, runs it, verifies the output,
// deletes it, and reports the checks. The report carried several PASS rows, yet
// the aggregate was null, the delivery counted as incomplete and the task was
// blocked — because the delivery parser rejected the whole Tests section over one
// line it could not read, while a second parser had already filled the visible
// evidence. One report must not get two answers.

const TEMP_TASK_RESULT = [
  'Ran the checks and cleaned up.',
  '',
  '## Diff',
  'no files changed',
  '',
  '## Tests',
  'PASS — script content check — ok',
  'PASS — stdout exact match (CP936) — ok',
  'PASS — stdout exact match (UTF-8) — ok',
  'PASS — cleanup check — path no longer exists',
  '',
  '## Risks',
  'None.',
].join('\n');

test('a verified zero-change task aggregates its evidence instead of nulling it', () => {
  const outcome = buildOutcome({ result: TEMP_TASK_RESULT, stopReason: 'completed' });
  assert.equal(outcome.tests_status, 'PASS');
  assert.equal(outcome.tests.filter((t) => t.status === 'PASS').length, 4);
  assert.equal(outcome.delivery.complete, true);
  assert.deepEqual(outcome.delivery.missing, []);
  assert.deepEqual(outcome.changes, [], 'the contract sentinel is not a claimed change');
});

test('a verified zero-change task reaches success when the caller authorised it', () => {
  const outcome = applyWorkspaceEvidence(buildOutcome({ result: TEMP_TASK_RESULT, stopReason: 'completed' }), {
    evidenceAvailable: true,
    hasChanges: false,
    allowNoChanges: true,
    requireNoChangeAuthorization: true,
  });
  assert.equal(outcome.task_status, 'success');
  assert.equal(outcome.no_change_verified, true);
  assert.equal(outcome.workspace_evidence_ok, true);
});

// The declaration a real Worker wrote for an authorized temporary task, taken
// verbatim from a live 3210 run. It says the workspace ends unchanged and then
// describes the work that was undone — which is the only way to report this kind
// of task honestly. The gate read the description as a claim that files had
// changed, disagreed with git, and failed the run as WORKSPACE_MISMATCH even
// though every check passed and the tree was provably clean.
const DESCRIPTIVE_TEMP_TASK_RESULT = [
  'Ran the checks and cleaned up.',
  '',
  '## Diff',
  '- No net file changes — `git status --porcelain` is empty and all 27 pre-existing files retain their original SHA-256 hashes.',
  '- `work/tmp-hello.ps1` — created transiently (530 bytes); **deleted**.',
  '- `work/` — directory did not exist before, was created, then **deleted** (confirmed empty first).',
  '',
  '## Tests',
  'PASS — powershell -File work/tmp-hello.ps1 (CP936) — len=4 hex=C4 E3 BA C3, exact match, no CR/LF',
  'PASS — same script under UTF-8 — len=6 hex=E4 BD A0 E5 A5 BD, round-trips to 你 好',
  'PASS — cleanup check — Test-Path work/tmp-hello.ps1 is False',
  '',
  '## Risks',
  '- The script derives 你 好 from code points, so no source encoding is assumed.',
].join('\n');

test('a transient-work description is not a claim that the changes remain', () => {
  const outcome = applyWorkspaceEvidence(buildOutcome({ result: DESCRIPTIVE_TEMP_TASK_RESULT, stopReason: 'completed' }), {
    evidenceAvailable: true,
    hasChanges: false,
    allowNoChanges: true,
    requireNoChangeAuthorization: true,
  });
  assert.equal(outcome.tests_status, 'PASS');
  assert.equal(outcome.workspace_evidence_ok, true);
  assert.equal(outcome.task_status, 'success');
  assert.equal(outcome.no_change_verified, true);
});

// The safety property behind that: recognizing more ways of saying "no net
// change" can only turn a mismatch into a match when git already proves the
// workspace is unchanged. A report that declares no changes while git reports
// real ones is still a mismatch, so nothing a worker failed to do can hide here.
test('a no-change declaration never outvotes a workspace that really changed', () => {
  const outcome = applyWorkspaceEvidence(buildOutcome({ result: DESCRIPTIVE_TEMP_TASK_RESULT, stopReason: 'completed' }), {
    evidenceAvailable: true,
    hasChanges: true,
    allowNoChanges: true,
    requireNoChangeAuthorization: true,
  });
  assert.equal(outcome.workspace_evidence_ok, false);
  assert.equal(outcome.no_change_verified, undefined);
  assert.notEqual(outcome.task_status, 'success');
});

// The same declaration stated as a closing summary. A real Worker ended its Diff
// section with "**Final state: no files changed.**" after describing the work it
// had undone, and the gate read the description as a claim that the work was
// still there.
test('a closing no-change summary is the same declaration', () => {
  const withSummary = DESCRIPTIVE_TEMP_TASK_RESULT.replace(
    '- No net file changes — `git status --porcelain` is empty and all 27 pre-existing files retain their original SHA-256 hashes.',
    '- `work/tmp-hello.ps1` — created temporarily, then deleted. **Final state: no files changed.**',
  );
  const outcome = applyWorkspaceEvidence(buildOutcome({ result: withSummary, stopReason: 'completed' }), {
    evidenceAvailable: true,
    hasChanges: false,
    allowNoChanges: true,
    requireNoChangeAuthorization: true,
  });
  assert.equal(outcome.workspace_evidence_ok, true);
  assert.equal(outcome.task_status, 'success');
  assert.equal(outcome.no_change_verified, true);
});

// ...and it must not be found inside an unrelated clause.
test('a no-change phrase inside another clause is not a declaration', () => {
  const notADeclaration = DESCRIPTIVE_TEMP_TASK_RESULT.replace(
    '- No net file changes — `git status --porcelain` is empty and all 27 pre-existing files retain their original SHA-256 hashes.',
    '- `src/app.mjs` was edited; no other files were touched.',
  );
  const outcome = applyWorkspaceEvidence(buildOutcome({ result: notADeclaration, stopReason: 'completed' }), {
    evidenceAvailable: true,
    hasChanges: false,
    allowNoChanges: true,
    requireNoChangeAuthorization: true,
  });
  assert.equal(outcome.workspace_evidence_ok, false);
  assert.equal(outcome.no_change_verified, undefined);
});

test('a report that lists changes is still a change claim', () => {
  const claimed = DESCRIPTIVE_TEMP_TASK_RESULT.replace(
    '- No net file changes — `git status --porcelain` is empty and all 27 pre-existing files retain their original SHA-256 hashes.',
    '- src/app.mjs — added the new export',
  );
  const outcome = applyWorkspaceEvidence(buildOutcome({ result: claimed, stopReason: 'completed' }), {
    evidenceAvailable: true,
    hasChanges: false,
    allowNoChanges: true,
    requireNoChangeAuthorization: true,
  });
  assert.equal(outcome.workspace_evidence_ok, false);
  assert.equal(outcome.no_change_verified, undefined);
});

test('a temporary task with a cleanup failure still fails', () => {
  const failedCleanup = TEMP_TASK_RESULT.replace('PASS — cleanup check — path no longer exists', 'FAIL — cleanup check — the temporary script is still present');
  const outcome = applyWorkspaceEvidence(buildOutcome({ result: failedCleanup, stopReason: 'completed' }), {
    evidenceAvailable: true,
    hasChanges: false,
    allowNoChanges: true,
    requireNoChangeAuthorization: true,
  });
  assert.equal(outcome.tests_status, 'FAIL');
  assert.notEqual(outcome.task_status, 'success');
  assert.equal(outcome.no_change_verified, undefined);
});

test('a temporary task with no verification evidence still fails', () => {
  const noEvidence = TEMP_TASK_RESULT.replace(/^PASS — .*$/gm, 'the script seemed fine');
  const outcome = applyWorkspaceEvidence(buildOutcome({ result: noEvidence, stopReason: 'completed' }), {
    evidenceAvailable: true,
    hasChanges: false,
    allowNoChanges: true,
    requireNoChangeAuthorization: true,
  });
  assert.equal(outcome.delivery.complete, false, 'prose is not evidence');
  assert.deepEqual(outcome.delivery.missing, ['Tests']);
  assert.notEqual(outcome.task_status, 'success');
});

test('zero changes are still refused when the caller did not authorise them', () => {
  const outcome = applyWorkspaceEvidence(buildOutcome({ result: TEMP_TASK_RESULT, stopReason: 'completed' }), {
    evidenceAvailable: true,
    hasChanges: false,
    allowNoChanges: false,
    requireNoChangeAuthorization: true,
  });
  assert.equal(outcome.no_change_verified, undefined);
  assert.notEqual(outcome.task_status, 'success');
});

test('a task that authorised nothing but changed nothing cannot claim success on prose alone', () => {
  const prose = buildOutcome({ result: '## Diff\nnothing\n## Tests\nall good\n## Risks\nnone', stopReason: 'completed' });
  const gated = applyWorkspaceEvidence(prose, { evidenceAvailable: true, hasChanges: false, allowNoChanges: true, requireNoChangeAuthorization: true });
  assert.equal(gated.task_status, 'blocked', 'a complete-looking report with no auditable test state is not delivery');
});
