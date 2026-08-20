import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelRefKey,
  normalizeModelPriority,
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
  assert.deepEqual(result, { ok: true, provider: 'a', model: 'deepseek-v4-flash', source: 'preferred-default' });
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
});

test('user priority selects its first provider/model', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [{ provider: 'b', model: 'm2' }, { provider: 'a', model: 'm1' }], priorityConfigured: true,
    catalog: catalog([provider('a', ['m1']), provider('b', ['m2'])]), harnessDefault,
  });
  assert.deepEqual(result, { ok: true, provider: 'b', model: 'm2', source: 'priority', matchedPriorityIndex: 0 });
});

test('removed priority provider is skipped in favor of the next item', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [{ provider: 'gone', model: 'm0' }, { provider: 'a', model: 'm1' }], priorityConfigured: true,
    catalog: catalog([provider('a', ['m1'])]), harnessDefault,
  });
  assert.equal(result.provider, 'a');
  assert.equal(result.matchedPriorityIndex, 1);
});

test('configured unadvertised model remains routable while its provider exists', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [{ provider: 'dynamic', model: 'not-listed' }], priorityConfigured: true,
    catalog: catalog([provider('dynamic', [])]), harnessDefault,
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'not-listed');
  assert.equal(result.advertised, false);
});

test('explicitly empty priority uses Harness Default rather than the tier preference', () => {
  const result = resolveWorkerModel({
    tier: 'flash', priority: [], priorityConfigured: true,
    catalog: catalog([provider('a', ['deepseek-v4-flash']), provider('default-provider')]), harnessDefault,
  });
  assert.equal(result.source, 'harness-default');
});

test('no usable provider and no Harness Default fails explicitly', () => {
  const result = resolveWorkerModel({ tier: 'pro', priority: [{ provider: 'gone', model: 'm' }], priorityConfigured: true, catalog: catalog([]) });
  assert.deepEqual(result, { ok: false, code: 'NO_WORKER_MODEL_AVAILABLE', message: 'No Harness model is available for the pro worker.' });
});

test('priority normalization removes invalid and duplicate refs but distinguishes providers', () => {
  const normalized = normalizeModelPriority([
    { provider: 'a', model: 'same' }, { provider: 'a', model: 'same' },
    { provider: 'b', model: 'same' }, { provider: '', model: 'bad' }, null,
  ]);
  assert.deepEqual(normalized, [{ provider: 'a', model: 'same' }, { provider: 'b', model: 'same' }]);
  assert.notEqual(modelRefKey(normalized[0]), modelRefKey(normalized[1]));
});
