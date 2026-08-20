// v0.2 role-based model routing: resolveModel turns a role model policy
// (primary -> escalation -> Harness Default) into a concrete provider/model,
// with attempt controlling the candidate pool. Pure resolver tests.
// Run with: node --test test/role-routing.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, DEFAULT_ROLE_MODEL_PREFERENCES } from '../src/model-routing.mjs';

const catalog = (providers) => ({ providers });
const provider = (id, models = []) => ({ id, name: id, models: models.map((m) => ({ id: m, name: m })) });
const harnessDefault = { provider: 'default-provider', model: 'default-model', reasoningEffort: 'max' };

test('fresh worker policy picks the preferred deepseek-v4-flash default on one provider', () => {
  const r = resolveModel({
    role: 'worker', attempt: 0,
    policy: { priority: [], priorityConfigured: false, escalation_priority: [], fallback: 'harness-default', escalation: { enabled: true, max_attempts: 2 } },
    catalog: catalog([provider('a', ['deepseek-v4-flash'])]),
    harnessDefault,
  });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'deepseek-v4-flash');
  assert.equal(r.source, 'preferred-default');
  assert.equal(r.role, 'worker');
  assert.equal(r.attempt, 0);
});

test('fresh reviewer policy picks the preferred deepseek-v4-pro default', () => {
  const r = resolveModel({
    role: 'reviewer', attempt: 0,
    policy: { priority: [], priorityConfigured: false, escalation_priority: [], fallback: 'harness-default' },
    catalog: catalog([provider('a', ['deepseek-v4-pro'])]),
    harnessDefault,
  });
  assert.equal(r.ok, true);
  assert.equal(r.model, 'deepseek-v4-pro');
});

test('attempt 0 uses the worker primary priority', () => {
  const r = resolveModel({
    role: 'worker', attempt: 0,
    policy: { priority: [{ provider: 'b', model: 'cheap' }], priorityConfigured: true, escalation_priority: [{ provider: 'c', model: 'strong' }], fallback: 'harness-default' },
    catalog: catalog([provider('b', ['cheap']), provider('c', ['strong'])]),
    harnessDefault,
  });
  assert.deepEqual(r, { ok: true, provider: 'b', model: 'cheap', source: 'priority', matchedPriorityIndex: 0, role: 'worker', attempt: 0 });
});

test('attempt 1 escalates to the escalation (strong) candidate pool', () => {
  const r = resolveModel({
    role: 'worker', attempt: 1,
    policy: { priority: [{ provider: 'b', model: 'cheap' }], priorityConfigured: true, escalation_priority: [{ provider: 'c', model: 'strong' }], escalation_priority_configured: true, fallback: 'harness-default' },
    catalog: catalog([provider('b', ['cheap']), provider('c', ['strong'])]),
    harnessDefault,
  });
  assert.equal(r.provider, 'c');
  assert.equal(r.model, 'strong');
  assert.equal(r.source, 'priority');
  assert.equal(r.attempt, 1);
});

test('escalation with an empty pool falls back to Harness Default', () => {
  const r = resolveModel({
    role: 'worker', attempt: 1,
    policy: { priority: [], priorityConfigured: false, escalation_priority: [], escalation_priority_configured: false, fallback: 'harness-default' },
    catalog: catalog([provider('a', ['deepseek-v4-flash']), provider('default-provider', ['default-model'])]),
    harnessDefault,
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'default-provider');
  assert.equal(r.source, 'harness-default');
});

test('no usable provider and no Harness Default fails explicitly', () => {
  const r = resolveModel({
    role: 'reviewer', attempt: 0,
    policy: { priority: [{ provider: 'gone', model: 'm' }], priorityConfigured: true, fallback: 'harness-default' },
    catalog: catalog([]),
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_WORKER_MODEL_AVAILABLE');
  assert.match(r.message, /reviewer/);
});

test('role model preferences are fixed for worker and reviewer', () => {
  assert.equal(DEFAULT_ROLE_MODEL_PREFERENCES.worker, 'deepseek-v4-flash');
  assert.equal(DEFAULT_ROLE_MODEL_PREFERENCES.reviewer, 'deepseek-v4-pro');
});
