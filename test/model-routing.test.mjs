import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_SELECTION_REASON_CODES,
  modelRefKey,
  normalizeModelPriority,
  resolveModel,
  resolveWorkerModel,
} from '../src/model-routing.mjs';

const catalog = (providers) => ({ providers });
const provider = (id, models = []) => ({ id, name: id, models: models.map((model) => ({ id: model, name: model })) });
const harnessDefault = { provider: 'default-provider', model: 'default-model', reasoningEffort: 'high' };

test('fresh Flash preference selects the unique advertised deepseek-v4-flash', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [], priorityConfigured: false,
    catalog: catalog([provider('a', ['deepseek-v4-flash'])]), harnessDefault,
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'a');
  assert.equal(result.model, 'deepseek-v4-flash');
  assert.equal(result.source, 'preferred-default');
  assert.deepEqual(result.selection_trace.selected, {
    provider: 'a', model: 'deepseek-v4-flash', source: 'preferred-default',
  });
});

test('same preferred model on two providers favors the Harness Default provider', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [], priorityConfigured: false,
    catalog: catalog([provider('a', ['deepseek-v4-flash']), provider('b', ['deepseek-v4-flash'])]),
    harnessDefault: { provider: 'b', model: 'anything', reasoningEffort: 'max' },
  });
  assert.equal(result.provider, 'b');
  assert.equal(result.source, 'preferred-default');
  assert.equal('reasoningEffort' in result, false);
  assert.equal(result.selection_trace.ordered_candidates[0].reason_code, MODEL_SELECTION_REASON_CODES.PREFERRED_MODEL_AMBIGUOUS);
  assert.equal(result.selection_trace.ordered_candidates.at(-1).status, 'selected');
});

test('ambiguous preferred model without a matching default provider falls back to Harness Default', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [], priorityConfigured: false,
    catalog: catalog([provider('a', ['deepseek-v4-flash']), provider('b', ['deepseek-v4-flash']), provider('default-provider')]),
    harnessDefault,
  });
  assert.equal(result.provider, 'default-provider');
  assert.equal(result.model, 'default-model');
  assert.equal(result.source, 'harness-default');
  assert.equal(result.reasoningEffort, 'high');
  assert.equal(result.selection_trace.fallback_reason, MODEL_SELECTION_REASON_CODES.PRIMARY_CANDIDATES_EXHAUSTED);
});

test('user priority selects its first provider/model', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [{ provider: 'b', model: 'm2' }, { provider: 'a', model: 'm1' }], priorityConfigured: true,
    catalog: catalog([provider('a', ['m1']), provider('b', ['m2'])]), harnessDefault,
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'b');
  assert.equal(result.model, 'm2');
  assert.equal(result.source, 'priority');
  assert.equal(result.matchedPriorityIndex, 0);
  assert.equal(result.selection_trace.ordered_candidates.length, 1);
  assert.equal(result.selection_trace.ordered_candidates[0].status, 'selected');
});

test('removed priority provider is traced as skipped in favor of the next item', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [{ provider: 'gone', model: 'm0' }, { provider: 'a', model: 'm1' }], priorityConfigured: true,
    catalog: catalog([provider('a', ['m1'])]), harnessDefault,
  });
  assert.equal(result.provider, 'a');
  assert.equal(result.matchedPriorityIndex, 1);
  assert.deepEqual(result.selection_trace.ordered_candidates[0], {
    provider: 'gone', model: 'm0', source: 'priority', status: 'skipped',
    reason_code: MODEL_SELECTION_REASON_CODES.PROVIDER_UNAVAILABLE,
  });
  assert.equal(result.selection_trace.ordered_candidates[1].status, 'selected');
});

test('configured unadvertised model remains routable while its provider exists', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [{ provider: 'dynamic', model: 'not-listed' }], priorityConfigured: true,
    catalog: catalog([provider('dynamic', [])]), harnessDefault,
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'not-listed');
  assert.equal(result.advertised, false);
  assert.equal(result.selection_trace.ordered_candidates[0].advertised, false);
  assert.equal(result.selection_trace.ordered_candidates[0].status, 'selected');
});

test('explicitly empty priority uses Harness Default rather than the tier preference', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [], priorityConfigured: true,
    catalog: catalog([provider('a', ['deepseek-v4-flash']), provider('default-provider')]), harnessDefault,
  });
  assert.equal(result.source, 'harness-default');
  assert.equal(result.selection_trace.fallback_reason, MODEL_SELECTION_REASON_CODES.PRIMARY_CANDIDATES_EXHAUSTED);
});

test('no usable provider and no Harness Default fails explicitly with safe skip reasons', () => {
  const result = resolveWorkerModel({ tier: 'pro', priority: [{ provider: 'gone', model: 'm' }], priorityConfigured: true, catalog: catalog([]) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_WORKER_MODEL_AVAILABLE');
  assert.equal(result.message, 'No Harness model is available for the pro worker.');
  assert.equal(result.selection_trace.selected, null);
  assert.equal(result.selection_trace.ordered_candidates[0].reason_code, MODEL_SELECTION_REASON_CODES.PROVIDER_UNAVAILABLE);
  assert.equal(result.selection_trace.ordered_candidates[1].reason_code, MODEL_SELECTION_REASON_CODES.HARNESS_DEFAULT_INVALID);
  assert.equal(result.selection_trace.fallback_reason, MODEL_SELECTION_REASON_CODES.NO_AVAILABLE_MODEL);
});

test('role resolver traces escalation strategy, ordered skips and Harness Default fallback', () => {
  const result = resolveModel({
    role: 'worker',
    attempt: 1,
    policy: {
      strategy: 'balanced',
      priority: [{ provider: 'cheap', model: 'cheap-model' }],
      escalation_priority: [{ provider: 'gone', model: 'strong-1' }],
      escalation_priority_configured: true,
      fallback: 'harness-default',
    },
    catalog: catalog([provider('default-provider', ['default-model'])]),
    harnessDefault,
  });
  assert.equal(result.source, 'harness-default');
  assert.equal(result.selection_trace.role, 'worker');
  assert.equal(result.selection_trace.logical_attempt, 1);
  assert.equal(result.selection_trace.strategy, 'balanced');
  assert.equal(result.selection_trace.candidate_set, 'escalation');
  assert.equal(result.selection_trace.ordered_candidates[0].source, 'escalation-priority');
  assert.equal(result.selection_trace.ordered_candidates[0].reason_code, MODEL_SELECTION_REASON_CODES.PROVIDER_UNAVAILABLE);
  assert.equal(result.selection_trace.fallback_reason, MODEL_SELECTION_REASON_CODES.ESCALATION_CANDIDATES_EXHAUSTED);
});

test('priority normalization removes invalid and duplicate refs but distinguishes providers', () => {
  const normalized = normalizeModelPriority([
    { provider: 'a', model: 'same' }, { provider: 'a', model: 'same' },
    { provider: 'b', model: 'same' }, { provider: '', model: 'bad' }, null,
  ]);
  assert.deepEqual(normalized, [{ provider: 'a', model: 'same' }, { provider: 'b', model: 'same' }]);
  assert.notEqual(modelRefKey(normalized[0]), modelRefKey(normalized[1]));
});
