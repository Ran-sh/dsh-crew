// Pure, secret-free failure classification for workflow and MCP results.
//
// Classification consumes structured status/codes/outcomes only. It never
// parses raw exception text, provider responses, credentials, quotas or logs.

export const FAILURE_CATEGORIES = Object.freeze([
  'none',
  'policy',
  'compatibility',
  'provider',
  'runtime',
  'verification',
  'cancelled',
]);

export const FAILURE_REASON_CODES = Object.freeze({
  NONE: 'NONE',
  CANCELLED: 'CANCELLED',
  ATTEMPT_TIMEOUT: 'ATTEMPT_TIMEOUT',
  RUNTIME_FAILURE: 'RUNTIME_FAILURE',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  TESTS_FAILED: 'TESTS_FAILED',
  TESTS_NOT_RUN: 'TESTS_NOT_RUN',
  DELIVERY_INCOMPLETE: 'DELIVERY_INCOMPLETE',
  WORKSPACE_MISMATCH: 'WORKSPACE_MISMATCH',
  TASK_BLOCKED: 'TASK_BLOCKED',
  TASK_PARTIAL: 'TASK_PARTIAL',
  REVIEW_CHANGES_REQUESTED: 'REVIEW_CHANGES_REQUESTED',
  REVIEW_INCONCLUSIVE: 'REVIEW_INCONCLUSIVE',
  POLICY_REJECTED: 'POLICY_REJECTED',
  HUB_INCOMPATIBLE: 'HUB_INCOMPATIBLE',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
});

const PROVIDER_CODES = new Set([
  'NO_DSH_PROVIDER_SELECTED',
  'NO_WORKER_MODEL_AVAILABLE',
  'MODEL_CATALOG_UNAVAILABLE',
  'PROVIDER_CATALOG_UNAVAILABLE',
  'PROVIDER_CATALOG_HEALTH_WARNING',
]);

const POLICY_CODES = new Set([
  'SUBAGENTS_DISABLED',
  'TIER_DISABLED',
  'NO_AUTO_TIER',
  'NO_WORKER_TIER',
  'PRO_NOT_AUTO',
  'VISION_DISABLED',
  'ROLE_DISABLED',
  'ROLE_NOT_AUTO',
  'ROLE_TIER_CONFLICT',
]);

const COMPATIBILITY_CODES = new Set([
  'HUB_UNREACHABLE',
  'HUB_HTTP_ERROR',
  'HUB_SERVICE_MISMATCH',
  'HUB_PROTOCOL_MISSING',
  'HUB_PROTOCOL_MISMATCH',
  'HUB_CAPABILITY_MISSING',
]);

const RUNTIME_CODES = new Set([
  'ISOLATION_UNAVAILABLE',
  'NOT_GIT_REPOSITORY',
  'GIT_NOT_FOUND',
  'GIT_TIMEOUT',
  'GIT_ERROR',
  'WORKTREE_LOCKED',
  'WORKTREE_CREATE_FAILED',
  'CANDIDATE_CAPTURE_FAILED',
  'ATTEMPT_INFRA_FAILURE',
]);

function normalizedCode(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function result(category, reasonCode, { sourceCode = null, terminalReason = null } = {}) {
  return {
    schema_version: 1,
    category,
    reason_code: reasonCode,
    ...(sourceCode ? { source_code: sourceCode } : {}),
    ...(terminalReason ? { terminal_reason: terminalReason } : {}),
  };
}

function verificationRoot({ outcome, review } = {}) {
  if (review?.verdict === 'request_changes') return FAILURE_REASON_CODES.REVIEW_CHANGES_REQUESTED;
  if (review?.verdict === 'inconclusive' && review?.status === 'failed') return FAILURE_REASON_CODES.REVIEW_INCONCLUSIVE;
  if (outcome?.tests_status === 'FAIL') return FAILURE_REASON_CODES.TESTS_FAILED;
  if (outcome?.delivery?.complete === false) return FAILURE_REASON_CODES.DELIVERY_INCOMPLETE;
  if (outcome?.workspace_evidence_ok === false) return FAILURE_REASON_CODES.WORKSPACE_MISMATCH;
  if (outcome?.task_status === 'blocked') return FAILURE_REASON_CODES.TASK_BLOCKED;
  if (outcome?.tests_status === 'NOT RUN') return FAILURE_REASON_CODES.TESTS_NOT_RUN;
  if (outcome?.task_status === 'partial') return FAILURE_REASON_CODES.TASK_PARTIAL;
  return null;
}

/**
 * Classify one workflow/result snapshot.
 *
 * Precedence is intentional:
 * 1) cancellation is explicit user/runtime intent;
 * 2) stable compatibility/provider/policy codes identify the failing boundary;
 * 3) timeout/runtime execution failures outrank verification;
 * 4) verification uses the business evidence that caused escalation/failure;
 * 5) otherwise the result is `none`.
 *
 * `decision.reason` is retained only as a bounded terminal reason (for example
 * max_attempts_reached); it never replaces the underlying verification cause.
 */
export function classifyFailure({
  phase = null,
  status = null,
  errorCode = null,
  outcome = null,
  decision = null,
  review = null,
  childAttempts = [],
} = {}) {
  const code = normalizedCode(errorCode);
  const terminalReason = normalizedCode(decision?.reason);

  if (phase === 'cancelled' || status === 'cancelled' || code === 'WORKFLOW_CANCELLED') {
    return result('cancelled', FAILURE_REASON_CODES.CANCELLED, {
      sourceCode: code === 'WORKFLOW_CANCELLED' ? code : null,
      terminalReason,
    });
  }

  if (code && COMPATIBILITY_CODES.has(code)) {
    return result('compatibility', code, { sourceCode: code, terminalReason });
  }
  if (code && PROVIDER_CODES.has(code)) {
    return result('provider', FAILURE_REASON_CODES.PROVIDER_UNAVAILABLE, { sourceCode: code, terminalReason });
  }
  if (code && POLICY_CODES.has(code)) {
    return result('policy', FAILURE_REASON_CODES.POLICY_REJECTED, { sourceCode: code, terminalReason });
  }

  const attempts = Array.isArray(childAttempts) ? childAttempts : [];
  if (attempts.some((attempt) => attempt?.timed_out === true || attempt?.stopReason === 'timeout')) {
    return result('runtime', FAILURE_REASON_CODES.ATTEMPT_TIMEOUT, { terminalReason });
  }
  if (code && RUNTIME_CODES.has(code)) {
    return result('runtime', code, { sourceCode: code, terminalReason });
  }
  if (outcome?.execution_status === 'failed') {
    return result('runtime', FAILURE_REASON_CODES.EXECUTION_FAILED, { terminalReason });
  }

  const verification = verificationRoot({ outcome, review });
  if (verification) return result('verification', verification, { terminalReason });

  if (phase === 'failed' || status === 'failed') {
    return result('runtime', FAILURE_REASON_CODES.RUNTIME_FAILURE, {
      sourceCode: code,
      terminalReason,
    });
  }

  return result('none', FAILURE_REASON_CODES.NONE);
}

/** Classify an immediate MCP rejection before a workflow exists. */
export function classifyFailureCode(code) {
  return classifyFailure({ status: 'failed', errorCode: code });
}
