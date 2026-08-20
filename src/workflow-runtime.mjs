// Workflow runtime: the single business flow for every worker dispatch, shared
// by blocking (dsh_run_worker) and async (dsh_spawn_worker) and by Hub and
// Standalone execution — the only difference between those transports is which
// adapter executes an attempt and whether the caller awaits.
//
// A Workflow Job is one logical delegation; an Attempt is one actual DSH
// worker/reviewer session within it. The runtime owns the state machine
// (phase transitions guarded by workflow.canTransition), the attempt loop
// (verify -> escalate on evidence -> reviewer pass -> finalize), candidate
// capture, review mutation detection, concurrency limiting and cancellation.
//
// All I/O is injected through `adapters`, so this module stays testable without
// DSH, a hub, git or a real filesystem. Policy decisions import the pure
// modules (policy.mjs / workflow.mjs) directly; Hub/Standalone specifics never
// appear here.

import { resolveModelPolicy, shouldAutoReview, getRoleState } from './policy.mjs';
import { buildOutcome, decideNextStep, JOB_PHASES, canTransition } from './workflow.mjs';
import { parseDeliveryReport } from './delivery.mjs';

export const WORKFLOW_ERROR_CODES = {
  ISOLATION_UNAVAILABLE: 'ISOLATION_UNAVAILABLE',
  NOT_GIT_REPOSITORY: 'NOT_GIT_REPOSITORY',
  WORKTREE_CREATE_FAILED: 'WORKTREE_CREATE_FAILED',
  CANDIDATE_CAPTURE_FAILED: 'CANDIDATE_CAPTURE_FAILED',
  WORKFLOW_CANCELLED: 'WORKFLOW_CANCELLED',
  ATTEMPT_INFRA_FAILURE: 'ATTEMPT_INFRA_FAILURE',
  REVIEWER_MUTATED_CANDIDATE: 'REVIEWER_MUTATED_CANDIDATE',
};

const TERMINAL = new Set([JOB_PHASES.COMPLETED, JOB_PHASES.FAILED, JOB_PHASES.CANCELLED, JOB_PHASES.INTERRUPTED]);

function lines(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Loose verdict normalizer: APPROVE / APPROVED / PASS -> approve, etc. */
export function normalizeReviewVerdict(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (/^(approve|approved|pass)\b/.test(s) || s === 'pass' || s === 'approve') return 'approve';
  if (/request.*chang|chang.*request|reject|needs changes/i.test(s)) return 'request_changes';
  return 'inconclusive';
}

/** Normalize a reviewer attempt into the canonical review record. */
export function normalizeReview({ attemptResult, beforeCandidate, afterCandidate } = {}) {
  const parsed = parseDeliveryReport(attemptResult?.result ?? '');
  const mutation = mutationDetected(beforeCandidate, afterCandidate);
  return {
    verdict: normalizeReviewVerdict(parsed.sections?.Verdict ?? attemptResult?.result ?? ''),
    findings: lines(parsed.sections?.['Review Findings']),
    evidence: lines(parsed.sections?.Evidence),
    risks: lines(parsed.sections?.Risks),
    delivery_complete: parsed.complete ?? false,
    model: attemptResult?.model ?? null,
    provider: attemptResult?.provider ?? null,
    status: attemptResult?.status ?? 'failed',
    ...(mutation ? { mutated_candidate: true } : {}),
  };
}

function mutationDetected(before, after) {
  if (!before) return false;
  if (before.fingerprint == null) return false;
  // candidate capture failing after the reviewer ran (e.g. worktree gone) is
  // also treated as evidence the reviewer could have changed something.
  if (!after) return true;
  return after.fingerprint != null && before.fingerprint !== after.fingerprint;
}

function deliveryClaimsChanges(outcome) {
  return Array.isArray(outcome?.changes) && outcome.changes.length > 0;
}

function workspaceEvidenceOK(outcome, candidate) {
  if (!candidate) return true; // non-coding or capture unavailable: no penalty
  const hasChanges = Array.isArray(candidate.changed_files) && candidate.changed_files.length > 0;
  if (outcome?.execution_status !== 'completed') return true;
  // A completed worker that claims changes must produce a candidate with
  // changes; a candidate listing changes is always acceptable evidence.
  return !deliveryClaimsChanges(outcome) || hasChanges;
}

function sumUsage(attempts) {
  const tokens = { input: 0, output: 0, reasoning: 0 };
  for (const a of attempts) {
    const u = a.usage;
    if (!u) continue;
    tokens.input += u.input ?? 0;
    tokens.output += u.output ?? 0;
    tokens.reasoning += u.reasoning ?? 0;
  }
  return tokens;
}

/**
 * Create a workflow runtime bound to `adapters`. Adapter interface:
 *
 *   executeAttempt(spec) -> AttemptResult  (spawn + resolve one session)
 *   spec = { id, workflowId, role, attempt, task, cwd, effort, policy, source }
 *   AttemptResult = { id, role, attempt, status, provider, model,
 *     selection_source, result, stopReason, outcome?, error?, usage? }
 *   cancelAttempt(id) -> Promise<void>
 *   allocateWorkspace(spec) ->
 *     { ok, execution_cwd, base_revision?, isolation, primary_workspace_dirty?, handle? }
 *     or { ok:false, reason, error }
 *   captureCandidate({ cwd, baseRevision }) -> candidate (optional; absent = no isolation)
 *   releaseWorkspace(handle) -> { ok, error? }
 *   buildReviewTask(task, attemptView) -> string
 *   getConfig() -> normalized config
 *
 * `spec` fields: role ("worker"|"reviewer"), task, effort, cwd (requested),
 * source, delivery ("coding"|"review").
 */
export function createWorkflowRuntime(adapters, {
  maxParallel = 3,
  idFactory = () => `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  clock = () => Date.now(),
  logger = null,
} = {}) {
  const jobs = new Map();
  const queue = [];
  let active = 0;

  function log(msg) { logger?.debug?.(`workflow: ${msg}`); }

  function transition(job, to, reason) {
    if (job.phase === to) return;
    if (!canTransition(job.phase, to)) {
      throw new Error(`illegal workflow transition ${job.phase} -> ${to}`);
    }
    job.phase = to;
    job.events.push({ at: clock(), phase: to, type: 'phase', reason: reason ?? to });
    log(`${job.id} ${to}`);
  }

  function createJob(spec) {
    const now = clock();
    return {
      id: idFactory(),
      role: spec.role ?? 'worker',
      delivery: spec.delivery === 'review' ? 'review' : 'coding',
      original_task: spec.task,
      source: spec.source ?? 'api',
      requested_cwd: spec.cwd,
      effort: spec.effort ?? 'max',
      phase: JOB_PHASES.CREATED,
      status: 'running',
      cancelling: false,
      execution_cwd: spec.cwd,
      isolation: 'shared',
      base_revision: null,
      primary_workspace_dirty: false,
      attempts: [],
      current_attempt_id: null,
      candidate: null,
      decision: null,
      review: null,
      outcome: null,
      error: null,
      cleanup_warning: null,
      events: [{ at: now, phase: JOB_PHASES.CREATED, type: 'created' }],
      createdAt: now,
      startedAt: now,
      endedAt: null,
      workspaceHandle: null,
      waiters: [],
    };
  }

  function releaseSlot() {
    active = Math.max(0, active - 1);
    drain();
  }

  function drain() {
    while (active < maxParallel && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      kickoff(job).catch((err) => {
        failJob(job, err);
      });
    }
  }

  function setTerminal(job) {
    if (job.status !== 'running') return;
    if (job.phase === JOB_PHASES.COMPLETED) job.status = 'done';
    else if (job.phase === JOB_PHASES.CANCELLED) job.status = 'cancelled';
    else job.status = 'failed';
    job.endedAt = clock();
    job.current_attempt_id = null;
    for (const w of job.waiters.splice(0)) w();
  }

  function failJob(job, err) {
    if (job.status !== 'running') return;
    job.error = err?.message ?? String(err);
    job.error_code = err?.code ?? err?.policyCode ?? job.error_code ?? null;
    job.phase = JOB_PHASES.FAILED;
    setTerminal(job);
    releaseSlot();
  }

  async function releaseWorkspace(job) {
    if (!job.workspaceHandle) return;
    try {
      const r = await adapters.releaseWorkspace(job.workspaceHandle);
      if (!r || r.ok !== true) job.cleanup_warning = r?.error ?? 'worktree cleanup failed';
    } catch (err) {
      job.cleanup_warning = err?.message ?? String(err);
    }
    job.workspaceHandle = null;
  }

  async function runWorkflow(job) {
    const isReviewJob = job.role === 'reviewer' || job.delivery === 'review';
    const config = adapters.getConfig?.() ?? {};

    try {
      // --- workspace allocation (worktree isolation for coding workers) ---
      const alloc = await adapters.allocateWorkspace?.(job);
      if (alloc && alloc.ok === false) {
        job.error = alloc.error ?? alloc.reason;
        job.phase = JOB_PHASES.FAILED;
        if (alloc.reason) job.error_code = alloc.reason;
        setTerminal(job);
        return;
      }
      if (alloc && alloc.ok) {
        job.workspaceHandle = alloc.handle ?? null;
        job.execution_cwd = alloc.execution_cwd ?? job.requested_cwd;
        job.isolation = alloc.isolation ?? 'worktree';
        job.base_revision = alloc.base_revision ?? null;
        job.primary_workspace_dirty = alloc.primary_workspace_dirty === true;
      }
      transition(job, JOB_PHASES.RUNNING, 'start');

      if (isReviewJob) {
        // Explicit reviewer: one reviewer pass over the workspace.
        transition(job, JOB_PHASES.REVIEWING, 'explicit reviewer');
        const before = alloc?.ok ? await safeCapture(adapters, job.execution_cwd, job.base_revision) : null;
        const reviewTask = adapters.buildReviewTask(job.original_task, null);
        const review = await runReviewerAttempt(job, reviewTask, config, before);
        job.review = review;
        if (job.review) transition(job, JOB_PHASES.READY, 'review complete');
        finalize(job);
        return;
      }

      // --- worker attempt loop with evidence-driven escalation ---
      let attempt = 0;
      for (;;) {
        if (job.cancelling) { cancelWorkflow(job); return; }
        if (attempt > 0) transition(job, JOB_PHASES.RUNNING, `escalated attempt ${attempt}`);
        const policy = resolveModelPolicy(config, 'worker', { attempt });
        const attemptId = attemptIdFor(adapters, job.id);
        job.current_attempt_id = attemptId;
        job.events.push({ at: clock(), phase: job.phase, type: 'attempt/start', attempt });
        const ar = await adapters.executeAttempt({
          id: attemptId,
          workflowId: job.id,
          role: 'worker',
          attempt,
          task: job.original_task,
          cwd: job.execution_cwd,
          effort: job.effort,
          policy,
          source: job.source,
        });
        if (job.cancelling) { cancelWorkflow(job); return; }
        job.attempts.push(attemptRecord(ar, attempt));
        // Infrastructure failures (missing key, unreachable hub, cwd invalid,
        // worktree/git problems) are NOT fixed by a stronger model.
        if (ar.infra === true) {
          failJob(job, Object.assign(new Error(ar.error ?? 'infrastructure failure'), { code: WORKFLOW_ERROR_CODES.ATTEMPT_INFRA_FAILURE }));
          return;
        }
        const outcome = ar.outcome ?? buildOutcome({
          result: ar.result ?? '',
          stopReason: ar.stopReason,
          executionStatus: ar.status === 'done' ? 'completed' : 'failed',
        });
        transition(job, JOB_PHASES.VERIFYING, `attempt ${attempt} complete`);

        // Workspace evidence: a coding worker claiming changes must show them.
        if (alloc?.ok && (job.candidate === null)) {
          const candidate = await safeCapture(adapters, job.execution_cwd, job.base_revision);
          job.candidate = candidate;
          if (candidate) outcome.workspace_evidence_ok = workspaceEvidenceOK(outcome, candidate);
          else outcome.workspace_evidence_ok = true;
        }
        job.outcome = outcome;

        const reviewRequested = !isReviewJob && shouldAutoReview(config);
        const reviewerAuto = getRoleState(config, 'reviewer') !== 'disabled';
        const decision = decideNextStep({
          outcome,
          policy,
          attempt,
          reviewRequested,
          reviewerAuto,
        });
        job.decision = { step: decision.step, phase: decision.phase, reason: decision.reason };
        job.events.push({ at: clock(), phase: job.phase, type: 'attempt/complete', attempt, decision: decision.step });

        if (job.cancelling) { cancelWorkflow(job); return; }
        if (decision.step === 'fail') {
          failJob(job, Object.assign(new Error(`workflow failed: ${decision.reason}`), { code: null }));
          return;
        }
        if (decision.step === 'escalate') {
          transition(job, JOB_PHASES.ESCALATING, decision.reason);
          attempt += 1;
          continue;
        }
        if (decision.step === 'review') {
          transition(job, JOB_PHASES.REVIEWING, 'automatic review');
          const before = job.candidate;
          const reviewTask = adapters.buildReviewTask(job.original_task, { outcome });
          const review = await runReviewerAttempt(job, reviewTask, config, before, job.execution_cwd, job.base_revision);
          job.review = review;
          // The implementation candidate stays the pre-review snapshot; the
          // reviewer workspace is discarded after release.
          transition(job, JOB_PHASES.READY, decision.reason);
          finalize(job);
          return;
        }
        transition(job, JOB_PHASES.READY, decision.reason);
        finalize(job);
        return;
      }
    } catch (err) {
      if (job.cancelling) { cancelWorkflow(job); return; }
      job.error = err?.message ?? String(err);
      job.phase = JOB_PHASES.FAILED;
      job.error_code = err?.code ?? err?.policyCode ?? null;
      setTerminal(job);
    } finally {
      await releaseWorkspace(job);
      if (job.status === 'running') {} // not reachable
      releaseSlot();
    }
  }

  async function safeCapture(adapters, cwd, baseRevision) {
    if (typeof adapters.captureCandidate !== 'function') return null;
    try {
      const c = await adapters.captureCandidate({ cwd, baseRevision });
      return c && c.ok ? c : null;
    } catch {
      return null;
    }
  }

  async function runReviewerAttempt(job, task, config, beforeCandidate, cwd = job.execution_cwd, baseRevision = job.base_revision) {
    const policy = resolveModelPolicy(config, 'reviewer', { attempt: 0 });
    const attemptId = attemptIdFor(adapters, job.id, 'review');
    job.current_attempt_id = attemptId;
    job.events.push({ at: clock(), phase: job.phase, type: 'review/start' });
    const ar = await adapters.executeAttempt({
      id: attemptId,
      workflowId: job.id,
      role: 'reviewer',
      attempt: 0,
      task,
      cwd,
      effort: job.effort,
      policy,
      source: job.source,
    });
    job.attempts.push({ ...attemptRecord(ar, 0), phase: 'review' });
    const afterCandidate = await safeCapture(adapters, cwd, baseRevision);
    return normalizeReview({ attemptResult: ar, beforeCandidate, afterCandidate });
  }

  function finalize(job) {
    transition(job, JOB_PHASES.COMPLETED, job.review ? 'reviewed' : 'verified');
    setTerminal(job);
  }

  function attemptRecord(ar, attempt) {
    return {
      id: ar.id,
      role: ar.role ?? 'worker',
      attempt,
      provider: ar.provider ?? null,
      model: ar.model ?? null,
      selection_source: ar.selection_source ?? null,
      status: ar.status ?? 'failed',
      result: ar.result ?? null,
      stopReason: ar.stopReason ?? null,
      outcome: ar.outcome ?? null,
      usage: ar.usage ?? null,
      error: ar.error ?? null,
    };
  }

  function attemptIdFor(adapters, workflowId, suffix = '') {
    return typeof adapters.attemptId === 'function'
      ? adapters.attemptId(workflowId, suffix)
      : `${workflowId}-a${suffix || '0'}`;
  }

  function cancelWorkflow(job) {
    if (job.status !== 'running') return;
    job.cancelling = true;
    job.events.push({ at: clock(), phase: job.phase, type: 'cancel' });
    const activeAttempt = job.current_attempt_id;
    if (activeAttempt) adapters.cancelAttempt?.(activeAttempt).catch(() => {});
    job.phase = JOB_PHASES.CANCELLED;
    job.status = 'cancelled';
    job.endedAt = clock();
    job.current_attempt_id = null;
    for (const w of job.waiters.splice(0)) w();
  }

  function workflowView(job, { withResult = false } = {}) {
    const v = {
      id: job.id,
      role: job.role,
      phase: job.phase,
      status: job.status,
      attempt: job.attempts.length,
      current_model: job.attempts[job.attempts.length - 1]?.model ?? null,
      source: job.source,
      requested_cwd: job.requested_cwd,
      execution_cwd: job.execution_cwd,
      isolation: job.isolation,
      base_revision: job.base_revision,
      primary_workspace_dirty: job.primary_workspace_dirty,
      startedAt: job.createdAt,
      updatedAt: job.endedAt ?? clock(),
      tokens: sumUsage(job.attempts),
      error: job.error ?? null,
      error_code: job.error_code ?? null,
      cleanup_warning: job.cleanup_warning ?? null,
      decision: job.decision,
      candidate_available: !!job.candidate,
      review_status: job.review ? job.review.status ?? null : null,
    };
    if (withResult) {
      v.child_attempts = job.attempts.map((a) => ({
        id: a.id, role: a.role, attempt: a.attempt, provider: a.provider, model: a.model,
        selection_source: a.selection_source, status: a.status, stopReason: a.stopReason,
        tokens: a.usage ?? null,
      }));
      v.outcome = job.outcome;
      v.candidate = job.candidate;
      v.review = job.review;
      v.events = job.events;
    }
    return v;
  }

  function start(spec) {
    const job = createJob(spec);
    jobs.set(job.id, job);
    if (active < maxParallel) {
      active += 1;
      kickoff(job).catch((err) => failJob(job, err));
    } else {
      transition(job, JOB_PHASES.QUEUED, 'concurrency limit');
      queue.push(job);
    }
    return job;
  }

  async function kickoff(job) {
    await runWorkflow(job);
  }

  async function wait(id, timeoutMs) {
    const job = jobs.get(id);
    if (!job) return undefined;
    if (job.status !== 'running') return job;
    await Promise.race([
      new Promise((res) => job.waiters.push(res)),
      timeoutMs > 0 ? new Promise((res) => setTimeout(res, timeoutMs)) : new Promise(() => {}),
    ]);
    return job;
  }

  function get(id, opts = {}) {
    const job = jobs.get(id);
    return job ? workflowView(job, opts) : undefined;
  }

  function list() {
    return [...jobs.values()].map((j) => workflowView(j));
  }

  async function cancel(id) {
    const job = jobs.get(id);
    if (!job) return undefined;
    cancelWorkflow(job);
    // Remove from queue if still queued and free its slot.
    const qi = queue.indexOf(job);
    if (qi !== -1) queue.splice(qi, 1);
    return workflowView(job);
  }

  return { start, wait, get, list, cancel };
}

// re-export phases so callers / tests share one definition
export { JOB_PHASES, TERMINAL };
