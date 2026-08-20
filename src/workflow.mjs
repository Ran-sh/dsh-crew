// Unified job workflow: the shared state machine + structured outcome that
// every worker job goes through, whether it was started with dsh_run_worker
// (blocking) or dsh_spawn_worker (async). run and spawn differ only in whether
// the caller awaits the job; the business steps — created → running →
// verifying → (escalating | reviewing) → ready/completed/failed — are the
// same, driven by evidence rather than by which transport started the job.
//
// Everything in this module is a pure function (no DSH, hub or worker runtime,
// no I/O), so the workflow rules are unit-testable in isolation. The runtime
// layers (jobs.mjs, the hub) stamp the phase and outcome through these helpers
// so server.mjs stays a transport adapter.

import { evaluateAttempt } from './policy.mjs';
import { parseDeliveryReport } from './delivery.mjs';

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
 * leave; every transition must be listed above. Pure.
 */
export function canTransition(from, to) {
  if (isTerminalPhase(to)) return true; // any phase may be cancelled/finalized
  const fromKey = from ?? JOB_PHASES.CREATED;
  const allowed = ALLOWED_TRANSITIONS[fromKey];
  if (!allowed) return false;
  return allowed.includes(to);
}

function splitSection(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function parseTests(section) {
  return splitSection(section).map((line) => {
    const m = line.match(/^(?:[-*+]\s+)?(PASS|FAIL|NOT RUN)\s+—\s+(.+?)\s+—\s+(.+)$/);
    if (!m) return { line };
    const [, status, command, summary] = m;
    return { status, command: command.trim(), summary: summary.trim() };
  });
}

/**
 * Classify a worker run into a canonical task status. Completion of the
 * process is not success: FAIL/not-run tests and missing delivery all downgrade
 * the verdict. Returns 'success' | 'partial' | 'blocked' | 'failed'.
 */
export function classifyTaskStatus({ executionStatus = 'completed', testsStatus, deliveryComplete = true, deliveryMissing = [] } = {}) {
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
  const testsStatus = parsed.tests_status ?? deliveryMeta?.tests_status;
  const tests = parseTests(parsed.sections.Tests);
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
    changes: splitSection(parsed.sections.Diff),
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
