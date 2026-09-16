// Unified job workflow: the shared state machine + structured outcome that
// every worker job goes through, whether it was started with dsh_run_worker
// (blocking) or dsh_spawn_worker (async). run and spawn differ only in whether
// the caller awaits the job; the business steps — created → running →
// verifying → (escalating | reviewing) → ready/completed/failed — are the
// same, driven by evidence rather than by which transport started the job.
//
// Everything in this module is a pure function (no DSH, hub or worker runtime,
// no I/O), so the workflow rules are unit-testable in isolation. The runtime
// layers stamp phase + outcome through these helpers so server.mjs stays a
// transport adapter.

import { evaluateAttempt } from './policy.mjs';
import { parseDeliveryReport, parseTestsSection } from './delivery.mjs';

export const JOB_PHASES = Object.freeze({
  CREATED: 'created',
  QUEUED: 'queued',
  RUNNING: 'running',
  VERIFYING: 'verifying',
  ESCALATING: 'escalating',
  REVIEWING: 'reviewing',
  READY: 'ready',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
});

const TERMINAL_PHASES = new Set([JOB_PHASES.COMPLETED, JOB_PHASES.FAILED, JOB_PHASES.CANCELLED, JOB_PHASES.INTERRUPTED]);

export function isTerminalPhase(phase) {
  return TERMINAL_PHASES.has(phase);
}

// Legal phase transitions (pure guard — the runtime never just assigns a phase).
const ALLOWED_TRANSITIONS = {
  [JOB_PHASES.CREATED]: [JOB_PHASES.QUEUED, JOB_PHASES.RUNNING, JOB_PHASES.CANCELLED, JOB_PHASES.FAILED],
  [JOB_PHASES.QUEUED]: [JOB_PHASES.RUNNING, JOB_PHASES.CANCELLED],
  [JOB_PHASES.RUNNING]: [JOB_PHASES.VERIFYING, JOB_PHASES.REVIEWING, JOB_PHASES.CANCELLED, JOB_PHASES.FAILED],
  [JOB_PHASES.VERIFYING]: [JOB_PHASES.ESCALATING, JOB_PHASES.REVIEWING, JOB_PHASES.READY, JOB_PHASES.FAILED, JOB_PHASES.CANCELLED],
  [JOB_PHASES.ESCALATING]: [JOB_PHASES.RUNNING, JOB_PHASES.CANCELLED, JOB_PHASES.FAILED],
  [JOB_PHASES.REVIEWING]: [JOB_PHASES.READY, JOB_PHASES.FAILED, JOB_PHASES.CANCELLED],
  [JOB_PHASES.READY]: [JOB_PHASES.COMPLETED, JOB_PHASES.FAILED, JOB_PHASES.CANCELLED],
};

/**
 * May a workflow transition from one phase to another? Terminal phases never
 * leave. A terminal destination is allowed only from a non-terminal phase;
 * every non-terminal transition must be listed above.
 */
export function canTransition(from, to) {
  const fromKey = from ?? JOB_PHASES.CREATED;
  if (isTerminalPhase(fromKey)) return false;
  if (isTerminalPhase(to)) return true;
  const allowed = ALLOWED_TRANSITIONS[fromKey];
  if (!allowed) return false;
  return allowed.includes(to);
}

function splitSection(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// A line that asserts the workspace ends unchanged. The report sections are
// prose, so this has to recognize the assertion inside a sentence rather than
// only as a whole line: "No net file changes — git status is empty" is the same
// claim as "no changes", and it is the *better* report.
const NO_CHANGE_ASSERTION_RE = new RegExp(
  '^(?:'
  + 'no\\s+(?:net\\s+)?(?:files?|changes?)\\b'
  + '|nothing\\s+(?:was\\s+)?(?:changed|modified|added|removed|deleted)\\b'
  + '|none\\s+(?:of\\s+the\\s+)?(?:files?|changes?)\\b'
  + '|workspace\\s+(?:is\\s+|remains\\s+)?(?:unchanged|clean)\\b'
  + '|(?:the\\s+)?(?:final\\s+|net\\s+)?(?:file\\s+)?changes?\\s*[:—-]\\s*(?:none|no\\b|empty)'
  + '|无(?:文件)?变更|没有(?:文件)?变更|未(?:更改|修改)任何文件|工作区(?:保持)?不变'
  + ')',
);

function isNoChangeAssertion(line) {
  const normalized = line
    .replace(/^(?:[-*+]\s+)+/, '')
    .replace(/[`"'“”‘’*_]/g, '')
    .replace(/[.!。！]+$/, '')
    .trim()
    .toLowerCase();
  if (normalized === '') return false;
  // The assertion is usually a whole line, but a report may also end with it —
  // "**Final state: no files changed.**" is the same declaration stated as a
  // summary. Testing each sentence and clause is what finds it without matching
  // a phrase that merely appears inside an unrelated one.
  return normalized
    .split(/\s*(?:[.:;,—–()\[\]]|->)\s*/)
    .some((fragment) => fragment !== '' && NO_CHANGE_ASSERTION_RE.test(fragment.trim()));
}

// Whether the report claims the workspace holds changes. A report that asserts
// the workspace ends unchanged is not claiming any, whatever else it describes:
// an authorized task that creates something, verifies it and removes it must
// describe that transient work, and describing it is not a claim that it is
// still there. This can only ever turn a mismatch into a match when the
// workspace really is unchanged — if it did change, `claimsChanges === false`
// against real changes is still a mismatch, so no actual change is hidden.
function deliveryClaimsChanges(outcome) {
  if (outcome?.no_change_declared === true) return false;
  return Array.isArray(outcome?.changes) && outcome.changes.length > 0;
}

export function applyWorkspaceEvidence(outcome, {
  evidenceAvailable = false,
  hasChanges = false,
  allowNoChanges = false,
  requireNoChangeAuthorization = true,
} = {}) {
  const next = { ...outcome };
  const claimsChanges = deliveryClaimsChanges(next);
  if (evidenceAvailable && next.execution_status === 'completed') {
    next.workspace_evidence_ok = claimsChanges === hasChanges;
  }
  const tests = Array.isArray(next.tests) ? next.tests : [];
  const verifiedNoChange = requireNoChangeAuthorization === true
    && evidenceAvailable === true
    && allowNoChanges === true
    && hasChanges === false
    && claimsChanges === false
    && next.execution_status === 'completed'
    && next.workspace_evidence_ok === true
    && next.delivery?.complete === true
    && tests.some((test) => test.status === 'PASS')
    && !tests.some((test) => test.status === 'FAIL');
  if (verifiedNoChange) {
    next.task_status = 'success';
    next.no_change_verified = true;
  } else if (requireNoChangeAuthorization === true && claimsChanges === false && next.task_status === 'success') {
    next.task_status = 'partial';
    delete next.no_change_verified;
  }
  return next;
}

function parseChanges(section) {
  // The declaration lines are dropped so the remaining list is what the report
  // says about files; the no-change assertion itself is kept out of it.
  return splitSection(section).filter((line) => !isNoChangeAssertion(line));
}

// The Tests section is parsed by the delivery contract's own parser. This module
// used to carry a second, looser one, so one report could show PASS entries to the
// caller while the delivery gate saw no Tests section at all.

/**
 * Classify a worker run into a canonical task status. Completion of the
 * process is not success: FAIL/not-run tests and missing delivery all downgrade
 * the verdict. Returns 'success' | 'partial' | 'blocked' | 'failed'.
 */
export function classifyTaskStatus({ executionStatus = 'completed', testsStatus, deliveryComplete = true, deliveryMissing = [] } = {}) {
  void deliveryMissing;
  if (executionStatus !== 'completed') return 'failed';
  if (testsStatus === 'FAIL') return 'partial';
  if (!deliveryComplete) return 'blocked';
  if (testsStatus === 'NOT RUN') return 'partial';
  return 'success';
}

/**
 * Normalize a worker's final message (+ delivery metadata) into the canonical
 * structured outcome the workflow consumes. The Markdown Delivery Report stays
 * the human-readable layer; this is the runtime's internal standard.
 */
export function buildOutcome({ result = '', deliveryMeta, executionStatus, stopReason, deliveryMissing } = {}) {
  const parsed = parseDeliveryReport(result);
  // The aggregate status and the visible entries come from one parse, so they can
  // no longer disagree about whether the Tests section is evidence.
  //
  // `parseDeliveryReport` already decided which contract this message answered —
  // it reads the format off the headings that are present, and only a coding
  // report has a Tests obligation. A review report has no Tests rule, so a
  // reviewer that also lists what it checked under `## Tests` is describing its
  // own coverage; reading those rows with the worker's rule made an honest
  // `NOT RUN — <check> — <reason>`, which is exactly the answer the contract asks
  // for when something cannot be verified, downgrade the reviewer to `partial`
  // and surface `TESTS_NOT_RUN`. The role was penalised for the disclosure the
  // contract requires, so the coding Tests rule now applies only to coding
  // reports. The format decision stays in one place: this consumes it.
  const reviewReport = parsed.format === 'review';
  const parsedTests = reviewReport
    ? { valid: false, status: undefined, tests: [] }
    : parseTestsSection(parsed.sections.Tests);
  // `deliveryMeta` is the same report read a second way, so for a review it can
  // only reintroduce the verdict the gate above just dropped. It is a fallback
  // for coding reports, not a way around the format gate.
  const testsStatus = reviewReport
    ? undefined
    : (parsedTests.status ?? parsed.tests_status ?? deliveryMeta?.tests_status);
  const tests = parsedTests.tests;
  const execStatus = executionStatus ?? (stopReason === 'completed' ? 'completed' : 'failed');
  return {
    execution_status: execStatus,
    task_status: classifyTaskStatus({
      executionStatus: execStatus,
      testsStatus,
      deliveryComplete: parsed.complete,
      deliveryMissing: deliveryMissing ?? parsed.missing,
    }),
    confidence: null,
    needs_escalation: false,
    changes: parseChanges(parsed.sections.Diff),
    // The report's net claim about the workspace, read from the section as
    // written. It cannot be inferred from `changes`: that list is filtered, so
    // the declaration line is gone from it by the time anyone looks, and the
    // lines that remain describe work the report already said it undid.
    no_change_declared: splitSection(parsed.sections.Diff).some(isNoChangeAssertion),
    tests,
    tests_status: testsStatus ?? null,
    risks: splitSection(parsed.sections.Risks),
    unverified: splitSection(parsed.sections.Unverified),
    delivery: {
      complete: parsed.complete,
      missing: [...(parsed.missing ?? [])],
      format: parsed.format,
      sections: [...(parsed.present ?? [])],
    },
  };
}

/**
 * Decide what happens next after a worker attempt completes. Pure: consumes
 * the canonical outcome + the role's model policy + the attempt number, and
 * returns the workflow step (accept / escalate / review / fail) with a reason.
 * This is the single rule for blocking AND async jobs — server.mjs only
 * transports the result.
 */
export function decideNextStep({ outcome, policy, attempt = 0, reviewRequested = false, reviewerAuto = false } = {}) {
  const o = outcome ?? {};
  const evaluation = evaluateAttempt({
    execution: o.execution_status,
    taskStatus: o.task_status,
    testsStatus: o.tests_status,
    deliveryComplete: o.delivery?.complete,
    workspaceEvidenceOK: o.workspace_evidence_ok !== false,
    policy,
    attempt,
  });
  if (evaluation.decision === 'escalate') {
    return { step: 'escalate', phase: JOB_PHASES.ESCALATING, reason: evaluation.reason, evaluation };
  }
  if (reviewRequested && reviewerAuto && evaluation.decision === 'accept') {
    return { step: 'review', phase: JOB_PHASES.REVIEWING, reason: 'review requested', evaluation };
  }
  if (evaluation.decision === 'accept') {
    return { step: 'accept', phase: JOB_PHASES.READY, reason: 'verified', evaluation };
  }
  return { step: 'fail', phase: JOB_PHASES.FAILED, reason: evaluation.reason ?? 'no accept path', evaluation };
}

/**
 * Pure run/spawn parity check helper: given the same spec + outcome, blocking
 * and async jobs must reach the same next step. Exported for tests so the
 * "run and spawn share one workflow" guarantee is asserted directly.
 */
export function parityStep(spec) {
  return decideNextStep(spec).step;
}
