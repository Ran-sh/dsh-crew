import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkerModel } from '../src/model-routing.mjs';

const catalog = {
  providers: [
    { id: 'p1', models: [{ id: 'm1' }] },
    { id: 'p2', models: [{ id: 'm2' }] },
  ],
};

const priority = [{ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' }];

function health(states) {
  return { get: (provider, model) => ({
    provider, model, state: states[`${provider}/${model}`] ?? 'unprobed', fresh: true,
  }) };
}

test('hard health gate skips a fresh quota failure but preserves manual order', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority, priorityConfigured: true, catalog,
    healthStore: health({ 'p1/m1': 'quota-exhausted', 'p2/m2': 'callable' }),
    healthGate: 'hard-failures', allowFallback: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual({ provider: result.provider, model: result.model }, { provider: 'p2', model: 'm2' });
  assert.equal(result.matchedPriorityIndex, 1);
  assert.equal(result.selection_trace.ordered_candidates[0].status, 'skipped');
  assert.equal(result.selection_trace.ordered_candidates[0].reason_code, 'QUOTA_EXHAUSTED');
});

test('health gate fails closed when fallback is disabled', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [priority[0]], priorityConfigured: true, catalog,
    healthStore: health({ 'p1/m1': 'credential-missing' }),
    healthGate: 'hard-failures', allowFallback: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_BLOCKED_CREDENTIAL');
  assert.equal(result.selection_trace.ordered_candidates[0].reason_code, 'CREDENTIAL_MISSING');
});

test('tombstoned providers are never selected even when catalogued', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority, priorityConfigured: true, catalog,
    healthGate: 'hard-failures', allowFallback: true,
    tombstones: { p1: 'absent' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'p2');
  assert.equal(result.selection_trace.ordered_candidates[0].reason_code, 'PROVIDER_TOMBSTONED');
});

test('fresh preferred-default selection also honors health gate and fallback policy', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [], priorityConfigured: false,
    preferredModelId: 'm1', catalog,
    healthStore: health({ 'p1/m1': 'quota-exhausted' }),
    healthGate: 'hard-failures', allowFallback: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_BLOCKED_QUOTA');
  assert.equal(result.selection_trace.ordered_candidates[0].reason_code, 'QUOTA_EXHAUSTED');
});
