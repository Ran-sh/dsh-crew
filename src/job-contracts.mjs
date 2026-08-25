// Versioned, transport-neutral contracts for one DSH Crew workflow.
//
// The workflow runtime may keep richer internal state for recovery and debug,
// but callers receive this bounded event/evidence layer by default. Full
// internal details remain available only through an explicit detail=full
// request at the MCP boundary.

export const JOB_CONTRACT_SCHEMA_VERSION = 1;

export const JOB_EVENT_TYPES = Object.freeze([
  'job.created',
  'job.started',
  'model.selected',
  'model.fallback',
  'worker.started',
  'worker.completed',
  'review.started',
  'review.completed',
  'approval.required',
  'job.completed',
  'job.failed',
  'job.cancelled',
]);

const EVENT_TYPE_SET = new Set(JOB_EVENT_TYPES);
const RESULT_STATUSES = Object.freeze(['PASS', 'FAIL', 'PARTIAL', 'BLOCKED']);

function boundedText(value, limit = 800) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function boundedStrings(values, { count = 80, length = 400 } = {}) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, count)
    .map((value) => boundedText(value, length))
    .filter(Boolean);
}

function boundedTests(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 40).map((test) => ({
    status: RESULT_STATUSES.includes(test?.status) ? test.status : boundedText(test?.status, 40),
    command: boundedText(test?.command, 300),
    summary: boundedText(test?.summary, 500),
  }));
}

/** Create one canonical, monotonically sequenced workflow event. */
export function createCanonicalJobEvent({
  jobId,
  type,
  sequence,
  at,
  role = null,
  attempt = null,
  data = {},
} = {}) {
  if (!EVENT_TYPE_SET.has(type)) throw new Error(`unknown canonical job event: ${String(type)}`);
  if (typeof jobId !== 'string' || !jobId) throw new Error('canonical job event requires jobId');
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error('canonical job event requires a positive sequence');
  return {
    schema_version: JOB_CONTRACT_SCHEMA_VERSION,
    event_id: `${jobId}:${sequence}`,
    job_id: jobId,
    sequence,
    type,
    at,
    role,
    attempt,
    data: data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : {},
  };
}

function evidenceStatus(view) {
  if (view?.status === 'cancelled' || view?.phase === 'cancelled') return 'BLOCKED';
  if (view?.status === 'failed' || view?.phase === 'failed' || view?.outcome?.execution_status === 'failed') return 'FAIL';
  if (view?.review?.verdict === 'request_changes' || view?.outcome?.task_status === 'partial') return 'PARTIAL';
  if (view?.outcome?.task_status === 'blocked') return 'BLOCKED';
  if (view?.status === 'done' && view?.outcome?.task_status === 'success') return 'PASS';
  return 'PARTIAL';
}

function compactSelectionTrace(attempts) {
  if (!Array.isArray(attempts)) return [];
  return attempts.slice(0, 16).map((attempt) => {
    const trace = attempt?.selection_trace ?? {};
    const selected = trace.selected ?? (
      attempt?.provider || attempt?.model
        ? { provider: attempt?.provider ?? null, model: attempt?.model ?? null, source: attempt?.selection_source ?? null }
        : null
    );
    const candidates = Array.isArray(trace.ordered_candidates)
      ? trace.ordered_candidates.slice(0, 32).map((candidate) => ({
        model: candidate?.model ?? null,
        provider: candidate?.provider ?? null,
        status: String(candidate?.status ?? 'CANDIDATE').toUpperCase(),
        ...(candidate?.reason ? { reason: boundedText(candidate.reason, 200) } : {}),
      }))
      : selected ? [{ model: selected.model ?? null, provider: selected.provider ?? null, status: 'SELECTED' }] : [];
    return {
      attempt: attempt?.attempt ?? null,
      role: attempt?.role ?? null,
      selected,
      selected_model: selected?.model ?? null,
      candidates,
      fallback_chain: trace.fallback_reason ? [boundedText(trace.fallback_reason, 200)] : [],
      decision_reason: selected?.source ?? attempt?.selection_source ?? null,
      fallback_reason: trace.fallback_reason ?? null,
      escalation_reason: trace.escalation_reason ?? null,
    };
  });
}

function changedFilesFromView(view) {
  if (Array.isArray(view?.candidate?.changed_files)) return view.candidate.changed_files;
  const changes = view?.workspace_diff?.changes;
  if (!changes || typeof changes !== 'object') return [];
  return [...new Set([
    ...(Array.isArray(changes.modified) ? changes.modified : []),
    ...(Array.isArray(changes.deleted) ? changes.deleted : []),
    ...(Array.isArray(changes.renamed) ? changes.renamed : []),
    ...(Array.isArray(changes.untracked) ? changes.untracked : []),
  ])];
}

/**
 * Build the machine-first Result Contract for a workflow.
 *
 * Deliberately excluded: worker prose, raw provider payloads and candidate
 * patch text. The envelope contains enough evidence for orchestration while
 * artifact inspection remains an explicit follow-up operation.
 */
export function buildEvidenceEnvelope(view = {}) {
  const outcome = view.outcome ?? {};
  const candidate = view.candidate ?? {};
  const review = view.review ?? null;
  const errorMessage = boundedText(view.error, 1000);
  const changedFiles = boundedStrings(changedFilesFromView(view), { count: 120, length: 500 });
  const status = evidenceStatus(view);
  const selectionAttempts = Array.isArray(view.child_attempts) && view.child_attempts.length > 0
    ? view.child_attempts
    : (view.selection_trace || view.provider || view.model ? [view] : []);
  return {
    schema_version: JOB_CONTRACT_SCHEMA_VERSION,
    job_id: view.id ?? null,
    client_job_id: view.client_job_id ?? null,
    role: view.role ?? null,
    status,
    summary: {
      phase: view.phase ?? null,
      task_status: outcome.task_status ?? null,
      execution_status: outcome.execution_status ?? null,
      tests_status: outcome.tests_status ?? null,
      delivery_complete: outcome.delivery?.complete === true,
      review_verdict: review?.verdict ?? null,
    },
    selection_trace: compactSelectionTrace(selectionAttempts),
    changed_files: changedFiles,
    changes: boundedStrings(outcome.changes),
    tests: boundedTests(outcome.tests),
    risks: boundedStrings(outcome.risks),
    unverified: boundedStrings(outcome.unverified),
    review: review ? {
      verdict: review.verdict ?? null,
      status: review.status ?? null,
      findings: boundedStrings(review.findings),
      evidence: boundedStrings(review.evidence),
      risks: boundedStrings(review.risks),
      delivery_complete: review.delivery_complete === true,
      mutated_candidate: review.mutated_candidate === true,
    } : null,
    artifacts: {
      candidate_available: view.candidate_available === true || changedFiles.length > 0,
      candidate_fingerprint: candidate.fingerprint ?? null,
      base_revision: candidate.base_revision ?? view.base_revision ?? null,
      workspace_retained: view.workspace_retained === true,
      candidate_capture_failed: view.candidate_capture_failed === true,
    },
    errors: errorMessage || view.error_code ? [{ code: view.error_code ?? null, message: errorMessage }] : [],
  };
}

/** Project a rich internal workflow view onto compact or explicit full detail. */
export function projectWorkflowView(view, { detail = 'compact', afterSequence = 0 } = {}) {
  if (!view || typeof view !== 'object') return view;
  const evidence = buildEvidenceEnvelope(view);
  const allCanonical = Array.isArray(view.canonical_events) ? view.canonical_events : [];
  const cursor = allCanonical.at(-1)?.sequence ?? view.event_cursor ?? 0;
  const canonicalEvents = allCanonical.filter((event) => Number(event?.sequence) > afterSequence);
  const eventProjection = {
    canonical_events: canonicalEvents,
    event_cursor: cursor,
    events_truncated_before_cursor: afterSequence > 0 && canonicalEvents.length > 0
      ? canonicalEvents[0].sequence !== afterSequence + 1
      : false,
  };
  if (detail === 'full') return { ...view, ...eventProjection, detail: 'full', evidence };

  const {
    candidate: _candidate,
    outcome: _outcome,
    review: _review,
    events: _legacyEvents,
    child_attempts: _childAttempts,
    result: _rawResult,
    workspace_diff: _workspaceDiff,
    reasonDetail: _reasonDetail,
    ...safe
  } = view;
  return {
    ...safe,
    ...eventProjection,
    error: boundedText(view.error, 1000),
    cleanup_warning: boundedText(view.cleanup_warning, 1000),
    detail: 'compact',
    evidence,
  };
}
