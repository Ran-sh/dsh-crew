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
import { classifyFailure } from './failure-classification.mjs';
import { createCanonicalJobEvent } from './job-contracts.mjs';

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

export function normalizeReviewVerdict(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (/^(approve|approved|pass)\b/.test(s) || s === 'pass' || s === 'approve') return 'approve';
  if (/request.*chang|chang.*request|reject|needs changes/i.test(s)) return 'request_changes';
  return 'inconclusive';
}

export function normalizeReview({ attemptResult, beforeCandidate, afterCandidate } = {}) {
  const parsed = parseDeliveryReport(attemptResult?.result ?? '');
  const mutation = mutationDetected(beforeCandidate, afterCandidate);
  const reportedVerdict = normalizeReviewVerdict(parsed.sections?.Verdict ?? attemptResult?.result ?? '');
  return {
    verdict: mutation ? 'request_changes' : reportedVerdict,
    reported_verdict: reportedVerdict,
    findings: lines(parsed.sections?.['Review Findings']),
    evidence: lines(parsed.sections?.Evidence),
    risks: lines(parsed.sections?.Risks),
    delivery_complete: parsed.complete ?? false,
    model: attemptResult?.model ?? null,
    provider: attemptResult?.provider ?? null,
    selection_trace: attemptResult?.selection_trace ?? null,
    status: attemptResult?.status ?? 'failed',
    ...(mutation ? { mutated_candidate: true, invalidated: true } : {}),
  };
}

function mutationDetected(before, after) {
  if (!before) return false;
  if (before.fingerprint == null) return false;
  if (!after) return true;
  return after.fingerprint != null && before.fingerprint !== after.fingerprint;
}

function deliveryClaimsChanges(outcome) {
  return Array.isArray(outcome?.changes) && outcome.changes.length > 0;
}

function workspaceEvidenceOK(outcome, candidate) {
  if (!candidate) return true;
  const hasChanges = Array.isArray(candidate.changed_files) && candidate.changed_files.length > 0;
  if (outcome?.execution_status !== 'completed') return true;
  return deliveryClaimsChanges(outcome) === hasChanges;
}

function canAcceptVerifiedNoChange(job, outcome, candidate) {
  if (job.allow_no_changes !== true || !candidate) return false;
  if (!Array.isArray(candidate.changed_files) || candidate.changed_files.length !== 0) return false;
  if (outcome?.execution_status !== 'completed' || outcome?.delivery?.complete !== true) return false;
  if (outcome.workspace_evidence_ok !== true || deliveryClaimsChanges(outcome)) return false;
  const tests = Array.isArray(outcome.tests) ? outcome.tests : [];
  return tests.some((test) => test.status === 'PASS')
    && !tests.some((test) => test.status === 'FAIL');
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

export function normalizeMaxParallel(value, fallback = 3) {
  const fallbackValue = Number.isInteger(Number(fallback))
    ? Math.max(1, Math.min(16, Number(fallback)))
    : 3;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallbackValue;
  return Math.max(1, Math.min(16, parsed));
}

export function createWorkflowRuntime(adapters, {
  maxParallel = 3,
  idFactory = () => `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  clock = () => Date.now(),
  logger = null,
} = {}) {
  const jobs = new Map();
  const queue = [];
  let active = 0;
  let maxParallelLimit = normalizeMaxParallel(maxParallel);
  let nestedIdFactory = null;

  function nextWorkflowId() {
    if (nestedIdFactory) return nestedIdFactory();
    const generated = idFactory();
    // A few embedders provide a factory-builder for deterministic tests.
    // Normalize that legacy shape once while keeping the public id a string.
    if (typeof generated === 'function') {
      nestedIdFactory = generated;
      return nestedIdFactory();
    }
    return generated;
  }

  function log(msg) { logger?.debug?.(`workflow: ${msg}`); }

  function runtimeState() {
    return {
      max_parallel: maxParallelLimit,
      active,
      queued: queue.length,
    };
  }

  function syncLiveMaxParallel() {
    if (typeof adapters.getRuntimeControls !== 'function') return false;
    const controls = adapters.getRuntimeControls() ?? {};
    if (controls.max_parallel === undefined) return false;
    const next = normalizeMaxParallel(controls.max_parallel, maxParallelLimit);
    if (next === maxParallelLimit) return false;
    maxParallelLimit = next;
    return true;
  }

  function transition(job, to, reason) {
    if (job.phase === to) return;
    if (!canTransition(job.phase, to)) throw new Error(`illegal workflow transition ${job.phase} -> ${to}`);
    job.phase = to;
    job.events.push({ at: clock(), phase: to, type: 'phase', reason: reason ?? to });
    log(`${job.id} ${to}`);
  }

  function recordCanonical(job, type, data = {}, attempt = null, at = clock()) {
    job.canonical_event_sequence += 1;
    job.canonical_events.push(createCanonicalJobEvent({
      jobId: job.id,
      type,
      sequence: job.canonical_event_sequence,
      at,
      role: job.role,
      attempt,
      data,
    }));
  }

  function createJob(spec) {
    const now = clock();
    const job = {
      id: nextWorkflowId(),
      client_job_id: spec.client_job_id ?? null,
      role: spec.role ?? 'worker',
      delivery: spec.delivery === 'review' ? 'review' : 'coding',
      model_class_hint: spec.model_class_hint === 'pro' ? 'pro' : spec.model_class_hint === 'flash' ? 'flash' : null,
      original_task: spec.task,
      source: spec.source ?? 'api',
      requested_cwd: spec.cwd,
      requested_isolation: spec.requested_isolation ?? null,
      workspace_branch: spec.workspace_branch ?? null,
      timeout_seconds: spec.timeout_seconds ?? null,
      profile_id: spec.profile_id ?? null,
      allow_fallback: spec.allow_fallback !== false,
      allow_no_changes: spec.allow_no_changes === true,
      routing: spec.routing ?? 'auto',
      review_strictness: spec.review_strictness ?? null,
      workspace_context: spec.workspace_context ? { ...spec.workspace_context } : null,
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
      candidate_capture_failed: false,
      retain_workspace: false,
      workspace_retained: false,
      events: [{ at: now, phase: JOB_PHASES.CREATED, type: 'created' }],
      canonical_events: [],
      canonical_event_sequence: 0,
      createdAt: now,
      startedAt: now,
      endedAt: null,
      workspaceHandle: null,
      waiters: [],
    };
    recordCanonical(job, 'job.created', { client_job_id: job.client_job_id }, null, now);
    return job;
  }

  function releaseSlot() {
    active = Math.max(0, active - 1);
    drain();
  }

  function handleKickoffFailure(job, err) {
    failJob(job, err);
    releaseSlot();
  }

  function drain({ sync = true } = {}) {
    if (sync) syncLiveMaxParallel();
    while (active < maxParallelLimit && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      kickoff(job).catch((err) => handleKickoffFailure(job, err));
    }
  }

  function setMaxParallel(value) {
    maxParallelLimit = normalizeMaxParallel(value, maxParallelLimit);
    // Raising the limit admits queued work immediately. Lowering it never
    // cancels already-running work: drain simply waits until active drops below
    // the new limit.
    drain({ sync: false });
    return runtimeState();
  }

  function refreshRuntimeControls() {
    syncLiveMaxParallel();
    drain({ sync: false });
    return runtimeState();
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
    recordCanonical(job, 'job.failed', {
      error_code: job.error_code,
    });
    setTerminal(job);
  }

  async function releaseWorkspace(job) {
    if (job.retain_workspace) {
      job.workspace_retained = true;
      return;
    }
    if (!job.workspaceHandle) return;
    try {
      const r = await adapters.releaseWorkspace(job.workspaceHandle);
      if (!r || r.ok !== true) {
        // A failed cleanup leaves the isolated workspace in place; say so
        // truthfully instead of claiming a clean release.
        job.cleanup_warning = r?.error ?? 'worktree cleanup failed';
        job.workspace_retained = true;
      }
    } catch (err) {
      job.cleanup_warning = err?.message ?? String(err);
      job.workspace_retained = true;
    }
    job.workspaceHandle = null;
  }

  async function runWorkflow(job) {
    const isReviewJob = job.role === 'reviewer' || job.delivery === 'review';
    let config = {};

    try {
      config = adapters.getConfig?.() ?? {};
      const alloc = await adapters.allocateWorkspace?.(job);
      if (alloc && alloc.ok === false) {
        failJob(job, Object.assign(new Error(alloc.error ?? alloc.reason), { code: alloc.reason }));
        return;
      }
      if (alloc && alloc.ok) {
        job.workspaceHandle = alloc.handle ?? null;
        job.execution_cwd = alloc.execution_cwd ?? job.requested_cwd;
        job.isolation = alloc.isolation ?? 'worktree';
        job.base_revision = alloc.base_revision ?? null;
        job.primary_workspace_dirty = alloc.primary_workspace_dirty === true;
      }
      recordCanonical(job, 'job.started', {
        isolation: job.isolation,
        base_revision: job.base_revision,
      });
      transition(job, JOB_PHASES.RUNNING, 'start');

      if (isReviewJob) {
        transition(job, JOB_PHASES.REVIEWING, 'explicit reviewer');
        const before = alloc?.ok && alloc.isolation === 'worktree' ? await safeCapture(adapters, job.execution_cwd, job.base_revision) : null;
        const reviewTask = adapters.buildReviewTask(job.original_task, null, { strictness: job.review_strictness ?? 'standard' });
        const review = await runReviewerAttempt(job, reviewTask, config, before);
        job.review = review;
        if (job.review) transition(job, JOB_PHASES.READY, 'review complete');
        finalize(job);
        return;
      }

      let attempt = 0;
      let escalationReason = null;
      for (;;) {
        if (job.cancelling) { cancelWorkflow(job); return; }
        if (attempt > 0) transition(job, JOB_PHASES.RUNNING, `escalated attempt ${attempt}`);
        const resolvedPolicy = resolveModelPolicy(config, 'worker', { attempt });
        const fallbackPolicy = job.allow_fallback === false
          ? { ...resolvedPolicy, escalation: { ...resolvedPolicy.escalation, enabled: false } }
          : resolvedPolicy;
        const policy = job.routing === 'stable'
          ? { ...fallbackPolicy, adaptive: { ...fallbackPolicy.adaptive, enabled: false } }
          : fallbackPolicy;
        const attemptId = attemptIdFor(adapters, job.id, attempt === 0 ? '' : String(attempt));
        job.current_attempt_id = attemptId;
        job.events.push({ at: clock(), phase: job.phase, type: 'attempt/start', attempt, escalation_reason: escalationReason });
        recordCanonical(job, 'worker.started', {
          attempt_id: attemptId,
          escalation_reason: escalationReason,
        }, attempt);
        const ar = await adapters.executeAttempt({
          id: attemptId,
          workflowId: job.id,
          role: 'worker',
          attempt,
          task: job.original_task,
          cwd: job.execution_cwd,
          effort: job.effort,
          timeout_seconds: job.timeout_seconds,
          policy,
          source: job.source,
          model_class_hint: job.model_class_hint,
          escalation_reason: escalationReason,
          onAttemptStarted: (actualId) => {
            if (typeof actualId === 'string' && actualId) job.current_attempt_id = actualId;
          },
        });
        job.current_attempt_id = null;
        if (job.cancelling) { cancelWorkflow(job); return; }
        const attemptView = attemptRecord(ar, attempt);
        job.attempts.push(attemptView);
        recordCanonical(job, 'model.selected', {
          provider: attemptView.provider,
          model: attemptView.model,
          source: attemptView.selection_source,
          fallback_reason: attemptView.selection_trace?.fallback_reason ?? null,
        }, attempt);
        recordCanonical(job, 'worker.completed', {
          attempt_id: attemptView.id,
          status: attemptView.status,
          stop_reason: attemptView.stopReason,
          error_code: attemptView.error_code,
        }, attempt);
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

        // Capture the latest candidate after every attempt. Capture failure is
        // not allowed to delete the only recoverable state: retain the worktree
        // and preserve the worker business result, while surfacing the warning.
        if (alloc?.ok && alloc.isolation === 'worktree') {
          const candidate = await safeCapture(adapters, job.execution_cwd, job.base_revision);
          if (candidate === null) {
            job.candidate_capture_failed = true;
            job.retain_workspace = true;
            job.candidate = null;
            job.events.push({ at: clock(), phase: job.phase, type: 'candidate/failed', attempt, message: 'candidate capture failed; worktree retained for recovery' });
          } else {
            job.candidate = candidate;
            attemptView.candidate_fingerprint = candidate.fingerprint ?? null;
            outcome.workspace_evidence_ok = workspaceEvidenceOK(outcome, candidate);
            if (canAcceptVerifiedNoChange(job, outcome, candidate)) {
              outcome.task_status = 'success';
              outcome.no_change_verified = true;
            }
            if (candidate.complete === false || candidate.replayable === false) {
              job.retain_workspace = true;
              job.events.push({ at: clock(), phase: job.phase, type: 'candidate/incomplete', attempt, message: 'candidate is not fully replayable; worktree retained' });
            }
          }
        }
        job.outcome = outcome;

        const reviewRequested = !isReviewJob && shouldAutoReview(config);
        const reviewerAuto = getRoleState(config, 'reviewer') !== 'disabled';
        const decision = decideNextStep({ outcome, policy, attempt, reviewRequested, reviewerAuto });
        job.decision = { step: decision.step, phase: decision.phase, reason: decision.reason };
        job.events.push({ at: clock(), phase: job.phase, type: 'attempt/complete', attempt, decision: decision.step });

        if (job.cancelling) { cancelWorkflow(job); return; }
        if (decision.step === 'fail') {
          const finalAttemptCode = ar.status === 'failed' ? attemptView.error_code : null;
          failJob(job, Object.assign(new Error(`workflow failed: ${decision.reason}`), { code: finalAttemptCode }));
          return;
        }
        if (decision.step === 'escalate') {
          recordCanonical(job, 'model.fallback', {
            reason: decision.reason,
            from_attempt: attempt,
            to_attempt: attempt + 1,
          }, attempt);
          transition(job, JOB_PHASES.ESCALATING, decision.reason);
          escalationReason = decision.reason;
          attempt += 1;
          continue;
        }
        if (decision.step === 'review') {
          transition(job, JOB_PHASES.REVIEWING, 'automatic review');
          const before = job.candidate;
          const reviewTask = adapters.buildReviewTask(job.original_task, { outcome, candidate: job.candidate ?? null }, { strictness: job.review_strictness ?? 'standard' });
          const review = await runReviewerAttempt(job, reviewTask, config, before, job.execution_cwd, job.base_revision);
          job.review = review;
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
      failJob(job, err);
    } finally {
      await releaseWorkspace(job);
      releaseSlot();
    }
  }

  async function safeCapture(adapters, cwd, baseRevision) {
    if (typeof adapters.captureCandidate !== 'function') return null;
    try {
      const c = await adapters.captureCandidate({ cwd, baseRevision });
      return c && c.ok ? c : null;
    } catch { return null; }
  }

  async function runReviewerAttempt(job, task, config, beforeCandidate, cwd = job.execution_cwd, baseRevision = job.base_revision) {
    const policy = resolveModelPolicy(config, 'reviewer', { attempt: 0 });
    const attemptId = attemptIdFor(adapters, job.id, 'review');
    job.current_attempt_id = attemptId;
    job.events.push({ at: clock(), phase: job.phase, type: 'review/start' });
    recordCanonical(job, 'review.started', { attempt_id: attemptId }, 0);
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
      model_class_hint: 'pro',
      escalation_reason: null,
      onAttemptStarted: (actualId) => {
        if (typeof actualId === 'string' && actualId) job.current_attempt_id = actualId;
      },
    });
    job.current_attempt_id = null;
    const attemptView = { ...attemptRecord(ar, 0), phase: 'review' };
    job.attempts.push(attemptView);
    recordCanonical(job, 'model.selected', {
      provider: attemptView.provider,
      model: attemptView.model,
      source: attemptView.selection_source,
      fallback_reason: attemptView.selection_trace?.fallback_reason ?? null,
    }, 0);
    if (ar.status === 'failed' && attemptView.error_code) job.error_code = attemptView.error_code;
    const afterCandidate = job.isolation === 'worktree' ? await safeCapture(adapters, cwd, baseRevision) : null;
    const review = normalizeReview({ attemptResult: ar, beforeCandidate, afterCandidate });
    recordCanonical(job, 'review.completed', {
      attempt_id: attemptView.id,
      status: review.status,
      verdict: review.verdict,
      error_code: attemptView.error_code,
    }, 0);
    return review;
  }

  function finalize(job) {
    transition(job, JOB_PHASES.COMPLETED, job.review ? 'reviewed' : 'verified');
    recordCanonical(job, 'job.completed', {
      reviewed: !!job.review,
      task_status: job.outcome?.task_status ?? null,
    });
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
      selection_trace: ar.selection_trace ?? null,
      status: ar.status ?? 'failed',
      result: ar.result ?? null,
      stopReason: ar.stopReason ?? null,
      outcome: ar.outcome ?? null,
      usage: ar.usage ?? null,
      error: ar.error ?? null,
      error_code: ar.error_code ?? ar.code ?? null,
      timed_out: ar.timed_out === true,
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
    recordCanonical(job, 'job.cancelled', { active_attempt_id: activeAttempt ?? null });
    job.endedAt = clock();
    job.current_attempt_id = null;
    for (const w of job.waiters.splice(0)) w();
  }

  function workflowView(job, { withResult = false } = {}) {
    const failure = classifyFailure({
      phase: job.phase,
      status: job.status,
      errorCode: job.error_code,
      outcome: job.outcome,
      decision: job.decision,
      review: job.review,
      childAttempts: job.attempts,
    });
    const v = {
      id: job.id,
      client_job_id: job.client_job_id,
      role: job.role,
      phase: job.phase,
      status: job.status,
      attempt: job.attempts.length,
      current_model: job.attempts[job.attempts.length - 1]?.model ?? null,
      model_class_hint: job.model_class_hint,
      source: job.source,
      profile_id: job.profile_id,
      allow_no_changes: job.allow_no_changes,
      routing: job.routing,
      workspace_context: job.workspace_context ? { ...job.workspace_context } : null,
      workspace_branch: job.workspace_branch,
      timeout_seconds: job.timeout_seconds,
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
      failure,
      cleanup_warning: job.cleanup_warning ?? null,
      candidate_capture_failed: job.candidate_capture_failed === true,
      workspace_retained: job.workspace_retained === true,
      decision: job.decision,
      candidate_available: !!job.candidate,
      review_status: job.review ? job.review.status ?? null : null,
      event_cursor: job.canonical_events.at(-1)?.sequence ?? 0,
    };
    if (withResult) {
      v.child_attempts = job.attempts.map((a) => ({
        id: a.id, role: a.role, attempt: a.attempt, provider: a.provider, model: a.model,
        selection_source: a.selection_source, selection_trace: a.selection_trace ?? null,
        status: a.status, stopReason: a.stopReason,
        outcome_task: a.outcome?.task_status ?? null,
        error: a.error ?? null, error_code: a.error_code ?? null, timed_out: a.timed_out === true,
        candidate_fingerprint: a.candidate_fingerprint ?? null,
        tokens: a.usage ?? null,
      }));
      v.outcome = job.outcome;
      v.candidate = job.candidate;
      v.review = job.review;
      v.events = job.events;
      v.canonical_events = job.canonical_events.map((event) => ({ ...event, data: { ...event.data } }));
    }
    return v;
  }

  function start(spec) {
    syncLiveMaxParallel();
    const job = createJob(spec);
    jobs.set(job.id, job);
    if (active < maxParallelLimit) {
      active += 1;
      kickoff(job).catch((err) => handleKickoffFailure(job, err));
    } else {
      transition(job, JOB_PHASES.QUEUED, 'concurrency limit');
      queue.push(job);
    }
    return job;
  }

  async function kickoff(job) { await runWorkflow(job); }

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

  function list() { return [...jobs.values()].map((j) => workflowView(j)); }

  async function cancel(id) {
    const job = jobs.get(id);
    if (!job) return undefined;
    cancelWorkflow(job);
    const qi = queue.indexOf(job);
    if (qi !== -1) queue.splice(qi, 1);
    return workflowView(job);
  }

  return { start, wait, get, list, cancel, runtimeState, setMaxParallel, refreshRuntimeControls };
}

export { JOB_PHASES, TERMINAL };
