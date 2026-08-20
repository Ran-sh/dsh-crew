// v0.2 role policy tests: role state, dispatch gates, role/tier bridging,
// automatic review decision and evidence-based escalation evaluation. Pure —
// no DSH, hub or worker runtime involved.
// Run with: node --test test/role-policy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGlobalConfig,
  migrateLegacyConfig,
  getCanonical,
  canDispatchRole,
  getRoleState,
  isRoleEnabled,
  isRoleAutoEligible,
  chooseRole,
  resolveRoleTierHint,
  resolveModelPolicy,
  shouldAutoReview,
  evaluateAttempt,
  POLICY_ERROR_CODES,
} from '../src/policy.mjs';

const base = (patch = {}) => normalizeGlobalConfig({ ...patch });
const CANON = (workerState, reviewState, extra = {}) => ({
  subagents_enabled: true,
  worker: { state: workerState, provider_mode: 'follow-dsh', model_policy: { priority: [], fallback: 'harness-default', escalation: { enabled: true, max_attempts: 2 } } },
  review: { state: reviewState, auto_review: reviewState === 'auto', provider_mode: 'follow-dsh', model_policy: { priority: [], fallback: 'harness-default' } },
  execution: { max_parallel: 3, isolation: 'worktree' },
  ...extra,
});

// ---------- getRoleState ----------

test('worker defaults to auto from legacy flash-only config', () => {
  const c = base({ collaboration_mode: 'flash-only' });
  assert.equal(getRoleState(c, 'worker'), 'auto');
  assert.equal(getRoleState(c, 'reviewer'), 'disabled');
});

test('pro-only config: worker auto, reviewer disabled', () => {
  const c = base({ collaboration_mode: 'pro-only' });
  assert.equal(getRoleState(c, 'worker'), 'auto');
  assert.equal(getRoleState(c, 'reviewer'), 'disabled');
});

test('review-pipeline config: worker + reviewer both auto', () => {
  const c = base({ collaboration_mode: 'review-pipeline' });
  assert.equal(getRoleState(c, 'worker'), 'auto');
  assert.equal(getRoleState(c, 'reviewer'), 'auto');
});

test('session role_state override beats the canonical state', () => {
  const c = CANON('auto', 'auto');
  assert.equal(getRoleState(c, 'reviewer', { reviewer_state: 'manual' }), 'manual');
  assert.equal(getRoleState(c, 'worker', { worker_state: 'disabled' }), 'disabled');
});

test('canonical config is recognized directly (getCanonical shortcut)', () => {
  const c = CANON('manual', 'auto');
  assert.equal(getCanonical(c).worker.state, 'manual');
  assert.equal(getRoleState(c, 'worker'), 'manual');
  assert.equal(isRoleEnabled(c, 'worker'), true);
  assert.equal(isRoleAutoEligible(c, 'reviewer'), true);
});

// ---------- canDispatchRole / chooseRole ----------

test('disabled role refuses both auto and explicit request', () => {
  const c = base({ collaboration_mode: 'flash-only' }); // reviewer disabled
  const r = canDispatchRole(c, 'reviewer', true);
  assert.equal(r.ok, false);
  assert.equal(r.error.policyCode, POLICY_ERROR_CODES.ROLE_DISABLED);
});

test('manual role runs only on explicit request', () => {
  const c = CANON('manual', 'auto');
  assert.equal(canDispatchRole(c, 'worker', false).ok, false);
  assert.equal(canDispatchRole(c, 'worker', true).ok, true);
});

test('auto role is callable automatically and on request', () => {
  const c = CANON('auto', 'auto');
  assert.equal(canDispatchRole(c, 'worker', false).ok, true);
  assert.equal(canDispatchRole(c, 'reviewer', true).ok, true);
});

test('subagents_enabled=false rejects every role', () => {
  const c = base({ subagents_enabled: false });
  assert.equal(canDispatchRole(c, 'worker', true).ok, false);
  assert.equal(canDispatchRole(c, 'reviewer', true).ok, false);
  const r = canDispatchRole(c, 'worker', true);
  assert.equal(r.error.policyCode, POLICY_ERROR_CODES.SUBAGENTS_DISABLED);
});

test('chooseRole defaults coding requests to worker', () => {
  const c = base({ collaboration_mode: 'flash-only' });
  const r = chooseRole(c, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.role, 'worker');
});

test('chooseRole explicit reviewer routes to reviewer and honors its gate', () => {
  const available = CANON('auto', 'auto');
  assert.equal(chooseRole(available, 'reviewer').ok, true);
  const locked = CANON('auto', 'disabled');
  const r = chooseRole(locked, 'reviewer');
  assert.equal(r.ok, false);
  assert.equal(r.error.policyCode, POLICY_ERROR_CODES.ROLE_DISABLED);
});

// ---------- role / tier bridging ----------

test('role=reviewer conflicts with legacy tier=flash', () => {
  const r = resolveRoleTierHint('reviewer', 'flash');
  assert.equal(r.ok, false);
  assert.equal(r.code, POLICY_ERROR_CODES.ROLE_TIER_CONFLICT);
});

test('role=reviewer pairs with tier=pro or no tier', () => {
  assert.equal(resolveRoleTierHint('reviewer', 'pro').ok, true);
  const r = resolveRoleTierHint('reviewer', undefined);
  assert.equal(r.ok, true);
  assert.equal(r.role, 'reviewer');
  assert.equal(r.tier, 'pro');
});

test('role=worker pairs with any legacy tier; no tier defaults to flash hint', () => {
  assert.deepEqual(resolveRoleTierHint('worker', 'pro'), { ok: true, role: 'worker', tier: 'pro' });
  assert.deepEqual(resolveRoleTierHint('worker', undefined), { ok: true, role: 'worker', tier: 'flash' });
  assert.deepEqual(resolveRoleTierHint(undefined, 'pro'), { ok: true, role: 'worker', tier: 'pro' });
});

// ---------- resolveModelPolicy ----------

test('resolveModelPolicy returns the worker model policy with configured flags', () => {
  const policy = resolveModelPolicy(
    CANON('auto', 'auto', { worker: { model_policy: { priority: [{ provider: 'a', model: 'm' }], priorityConfigured: true, escalation_priority: [{ provider: 'b', model: 'e' }], fallback: 'harness-default', escalation: { enabled: true, max_attempts: 2 } } } }),
    'worker', { attempt: 1 },
  );
  assert.deepEqual(policy.priority, [{ provider: 'a', model: 'm' }]);
  assert.deepEqual(policy.escalation_priority, [{ provider: 'b', model: 'e' }]);
  assert.equal(policy.attempt, 1);
  assert.equal(policy.role, 'worker');
});

test('resolveModelPolicy derives from legacy config when no canonical present', () => {
  const c = base({ tier_policy: 'auto', pro_model_priority: [{ provider: 'p', model: 'pro-model' }] });
  const reviewPolicy = resolveModelPolicy(c, 'reviewer');
  assert.deepEqual(reviewPolicy.priority, [{ provider: 'p', model: 'pro-model' }]);
});

// ---------- shouldAutoReview ----------

test('auto review requires reviewer auto + auto_review', () => {
  assert.equal(shouldAutoReview(CANON('auto', 'auto', { review: { state: 'auto', auto_review: true } })), true);
  assert.equal(shouldAutoReview(CANON('auto', 'disabled')), false);
  assert.equal(shouldAutoReview(CANON('auto', 'auto', { review: { state: 'auto', auto_review: false } })), false);
});

test('review-pipeline legacy config auto-reviews', () => {
  assert.equal(shouldAutoReview(base({ collaboration_mode: 'review-pipeline' })), true);
  assert.equal(shouldAutoReview(base({ collaboration_mode: 'balanced' })), false);
});

test('session auto_review override wins', () => {
  const c = CANON('auto', 'auto', { review: { state: 'auto', auto_review: true } });
  assert.equal(shouldAutoReview(c, { auto_review: false }), false);
  assert.equal(shouldAutoReview(CANON('auto', 'auto', { review: { state: 'auto', auto_review: false } }), { auto_review: true }), true);
});

// ---------- evaluateAttempt (PR2 evidence rules, shared pure function) ----------

test('clean verified worker accept', () => {
  assert.deepEqual(evaluateAttempt({ policy: { escalation: { enabled: true, max_attempts: 2 } } }), { decision: 'accept', reason: 'verified', escalate: false });
});

test('failed execution escalates', () => {
  assert.equal(evaluateAttempt({ execution: 'failed', policy: { escalation: { enabled: true, max_attempts: 2 } } }).decision, 'escalate');
});

test('failing tests escalate', () => {
  assert.equal(evaluateAttempt({ testsStatus: 'FAIL', policy: { escalation: { enabled: true, max_attempts: 2 } } }).decision, 'escalate');
});

test('delivery incomplete escalates', () => {
  assert.equal(evaluateAttempt({ deliveryComplete: false, policy: { escalation: { enabled: true, max_attempts: 2 } } }).decision, 'escalate');
});

test('escalation disabled never escalates', () => {
  assert.equal(evaluateAttempt({ execution: 'failed', policy: { escalation: { enabled: false, max_attempts: 2 } } }).decision, 'fail');
});

test('max attempts reached stops escalation', () => {
  const r = evaluateAttempt({ execution: 'failed', attempt: 2, policy: { escalation: { enabled: true, max_attempts: 2 } } });
  assert.equal(r.decision, 'fail');
  assert.equal(r.reason, 'max_attempts_reached');
});

test('workspace mismatch escalates (worker claims success but diff disagrees)', () => {
  assert.equal(evaluateAttempt({ workspaceEvidenceOK: false, policy: { escalation: { enabled: true, max_attempts: 2 } } }).decision, 'escalate');
});
