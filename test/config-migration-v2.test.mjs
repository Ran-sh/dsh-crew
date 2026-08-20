// v0.2 centralized legacy-config migration tests. migrateLegacyConfig is the
// single source that turns v0.1 flash/pro tier config into the canonical
// worker/reviewer/execution shape. Pure, credential-free, deterministic.
// Run with: node --test test/config-migration-v2.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateLegacyConfig, normalizeGlobalConfig, ROLE_MODEL_STRATEGIES } from '../src/policy.mjs';

const ref = (provider, model) => ({ provider, model });

test('flash-only → worker auto, review disabled, economy strategy', () => {
  const c = migrateLegacyConfig({ tier_policy: 'flash-only', flash_model_priority: [ref('a', 'm1')] });
  assert.equal(c.worker.state, 'auto');
  assert.equal(c.review.state, 'disabled');
  assert.equal(c.review.auto_review, false);
  assert.equal(c.worker.model_policy.strategy, 'economy');
  assert.deepEqual(c.worker.model_policy.priority, [ref('a', 'm1')]);
});

test('pro-only → worker auto (pro candidates), review disabled', () => {
  const c = migrateLegacyConfig({ tier_policy: 'pro-only', pro_model_priority: [ref('b', 'm2')] });
  assert.equal(c.worker.state, 'auto');
  assert.equal(c.worker.model_policy.strategy, 'quality');
  assert.deepEqual(c.worker.model_policy.priority, []);
  assert.deepEqual(c.worker.model_policy.escalation_priority, [ref('b', 'm2')]);
  assert.equal(c.review.state, 'disabled');
});

test('balanced → worker auto, review manual (pro available, no auto-review opt-in)', () => {
  const c = migrateLegacyConfig({ tier_policy: 'auto' });
  assert.equal(c.worker.state, 'auto');
  assert.equal(c.review.state, 'manual');
  assert.equal(c.review.auto_review, false);
});

test('review-pipeline → worker auto + reviewer auto + auto_review true; reviewer uses pro priority', () => {
  const c = migrateLegacyConfig({
    collaboration_mode: 'review-pipeline',
    flash_model_priority: [ref('f', 'flash-model')],
    pro_model_priority: [ref('p', 'pro-model')],
  });
  assert.equal(c.worker.state, 'auto');
  assert.equal(c.review.state, 'auto');
  assert.equal(c.review.auto_review, true);
  assert.deepEqual(c.worker.model_policy.priority, [ref('f', 'flash-model')]);
  assert.deepEqual(c.worker.model_policy.escalation_priority, [ref('p', 'pro-model')]);
  assert.deepEqual(c.review.model_policy.priority, [ref('p', 'pro-model')]);
});

test('escalate_on_failure → worker escalation enabled with max_attempts default', () => {
  const c = migrateLegacyConfig({ tier_policy: 'auto', escalate_on_failure: true });
  assert.equal(c.worker.model_policy.escalation.enabled, true);
  assert.equal(c.worker.model_policy.escalation.max_attempts, 2);
});

test('pro_reviews_flash → auto_review true', () => {
  const c = migrateLegacyConfig({ tier_policy: 'auto', pro_reviews_flash: true });
  assert.equal(c.review.auto_review, true);
  assert.equal(c.review.state, 'auto');
});

test('explicit priority never disappears during migration (user list preserved)', () => {
  const c = migrateLegacyConfig({
    collaboration_mode: 'custom',
    flash_state: 'manual',
    pro_state: 'auto',
    flash_model_priority: [ref('a', 'm1'), ref('b', 'm2')],
    pro_model_priority: [ref('c', 'm3')],
  });
  assert.deepEqual(c.worker.model_policy.priority, [ref('a', 'm1'), ref('b', 'm2')]);
  assert.deepEqual(c.worker.model_policy.escalation_priority, [ref('c', 'm3')]);
  assert.deepEqual(c.review.model_policy.priority, [ref('c', 'm3')]);
});

test('execution carries subagents switch + effort + timeout + max_parallel + isolation', () => {
  const c = migrateLegacyConfig({ subagents_enabled: false, default_effort: 'high', default_timeout_seconds: 60 });
  assert.equal(c.execution.enabled, false);
  assert.equal(c.execution.default_effort, 'high');
  assert.equal(c.execution.default_timeout_seconds, 60);
  assert.equal(c.execution.max_parallel, 3);
  assert.equal(c.execution.isolation, 'worktree');
});

test('migration never reads or returns a credential', () => {
  const c = migrateLegacyConfig({ tier_policy: 'auto', api_key: 'sk-leak' });
  assert.equal(JSON.stringify(c).includes('sk-leak'), false);
});

test('normalizeGlobalConfig attaches the same canonical worker/reviewer shape', () => {
  const c = normalizeGlobalConfig({ tier_policy: 'auto', pro_reviews_flash: true });
  assert.equal(c.worker.state, 'auto');
  assert.equal(c.review.state, 'auto');
  assert.equal(c.review.auto_review, true);
  assert.ok(ROLE_MODEL_STRATEGIES.includes(c.worker.model_policy.strategy));
});

test('migration is pure: input object untouched', () => {
  const raw = { tier_policy: 'flash-only' };
  migrateLegacyConfig(raw);
  assert.deepEqual(raw, { tier_policy: 'flash-only' });
});

test('explicit worker_state / review_state / auto_review override the derived role states', () => {
  const c = migrateLegacyConfig({ tier_policy: 'flash-only', worker_state: 'manual', review_state: 'auto', auto_review: true });
  assert.equal(c.worker.state, 'manual');
  assert.equal(c.review.state, 'auto');
  assert.equal(c.review.auto_review, true);
});

test('unset v0.2 overrides fall back to the derived states', () => {
  const c = migrateLegacyConfig({ tier_policy: 'flash-only' });
  assert.equal(c.worker.state, 'auto');
  assert.equal(c.review.state, 'disabled');
  assert.equal(c.review.auto_review, false);
});
