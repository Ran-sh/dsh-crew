import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCatalogHealth,
  CATALOG_HEALTH_CODES,
  readHarnessModelCatalog,
} from '../src/model-catalog.mjs';

function fakeLlm(providers, models) {
  return { listProviders: () => providers, listModels: async (id) => {
    const value = models[id];
    if (value instanceof Error) throw value;
    return value ?? [];
  } };
}

function hint(health, code) {
  return health.hints.find((item) => item.code === code);
}

test('catalog reads every provider and normalizes model metadata', async () => {
  const result = await readHarnessModelCatalog({
    llm: fakeLlm([{ id: 'a', name: 'Same' }, { id: 'b', name: 'Same' }], {
      a: [{ provider: 'a', id: 'same', name: 'A Same', secret: 'no' }],
      b: [{ provider: 'b', id: 'same', name: 'B Same' }, { provider: 'b', id: 'other', name: 'Other' }],
    }),
    getCurrentSelection: () => ({ provider: 'b', model: 'same', reasoningEffort: 'high', apiKey: 'sk-nope' }),
    now: () => '2026-08-20T00:00:00.000Z',
  });
  assert.equal(result.providers.length, 2);
  assert.equal(result.model_count, 3);
  assert.deepEqual(result.harness_default, { provider: 'b', model: 'same', reasoningEffort: 'high' });
  assert.equal(result.refreshed_at, '2026-08-20T00:00:00.000Z');
  assert.deepEqual(result.health, {
    schema_version: 1,
    warning_count: 0,
    info_count: 0,
    attention: false,
    hints: [],
  });
  assert.equal(JSON.stringify(result).includes('sk-nope'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('one provider model-list failure produces a partial catalog and bounded warning', async () => {
  const result = await readHarnessModelCatalog({
    llm: fakeLlm([{ id: 'ok', name: 'OK' }, { id: 'bad', name: 'Bad' }], { ok: [{ id: 'm', name: 'M' }], bad: new Error('token=secret') }),
  });
  assert.equal(result.partial, true);
  assert.deepEqual(result.providers[1], { id: 'bad', name: 'Bad', models: [], error: 'MODEL_LIST_FAILED' });
  assert.deepEqual(hint(result.health, CATALOG_HEALTH_CODES.PROVIDER_MODEL_LIST_FAILED), {
    code: CATALOG_HEALTH_CODES.PROVIDER_MODEL_LIST_FAILED,
    level: 'warning',
    provider: 'bad',
  });
  assert.equal(result.health.attention, true);
  assert.equal(JSON.stringify(result).includes('token=secret'), false);
});

test('all provider model-list failures retain provider identities without leaking errors', async () => {
  const result = await readHarnessModelCatalog({
    llm: fakeLlm([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], {
      a: new Error('Authorization: secret-a'), b: new Error('api_key=secret-b'),
    }),
  });
  assert.equal(result.partial, true);
  assert.equal(result.provider_count, 2);
  assert.equal(result.model_count, 0);
  assert.deepEqual(result.providers.map((provider) => provider.error), ['MODEL_LIST_FAILED', 'MODEL_LIST_FAILED']);
  assert.equal(result.health.warning_count, 2);
  assert.deepEqual(result.health.hints.map((item) => item.code), [
    CATALOG_HEALTH_CODES.PROVIDER_MODEL_LIST_FAILED,
    CATALOG_HEALTH_CODES.PROVIDER_MODEL_LIST_FAILED,
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret|authorization|api_key/i);
});

test('empty effective catalog is reported without inventing expected providers', async () => {
  const result = await readHarnessModelCatalog({ llm: fakeLlm([], {}) });
  assert.equal(result.provider_count, 0);
  assert.equal(result.model_count, 0);
  assert.deepEqual(result.health.hints, [{
    code: CATALOG_HEALTH_CODES.EMPTY_CATALOG,
    level: 'warning',
  }]);
  assert.equal(result.health.attention, true);
});

test('provider with an empty advertised model list is informational, not a routing failure', async () => {
  const result = await readHarnessModelCatalog({
    llm: fakeLlm([{ id: 'dynamic', name: 'Dynamic' }], { dynamic: [] }),
    getCurrentSelection: () => ({ provider: 'dynamic', model: 'exact-id' }),
  });
  assert.deepEqual(hint(result.health, CATALOG_HEALTH_CODES.EMPTY_PROVIDER_MODELS), {
    code: CATALOG_HEALTH_CODES.EMPTY_PROVIDER_MODELS,
    level: 'info',
    provider: 'dynamic',
  });
  assert.equal(result.health.warning_count, 0);
  assert.equal(result.health.attention, false);
  assert.equal(hint(result.health, CATALOG_HEALTH_CODES.HARNESS_DEFAULT_MODEL_UNADVERTISED), undefined);
});

test('Harness Default provider missing from effective catalog is a bounded warning', () => {
  const health = analyzeCatalogHealth({
    providers: [{ id: 'available', name: 'Available', models: [{ id: 'm1', name: 'M1' }] }],
    harnessDefault: { provider: 'missing', model: 'default-model', reasoningEffort: 'high' },
  });
  assert.deepEqual(hint(health, CATALOG_HEALTH_CODES.HARNESS_DEFAULT_PROVIDER_MISSING), {
    code: CATALOG_HEALTH_CODES.HARNESS_DEFAULT_PROVIDER_MISSING,
    level: 'warning',
    provider: 'missing',
    model: 'default-model',
  });
  assert.equal(health.attention, true);
});

test('Harness Default model not advertised by an existing provider is informational only', () => {
  const health = analyzeCatalogHealth({
    providers: [{ id: 'p', name: 'P', models: [{ id: 'other', name: 'Other' }, { id: 'another', name: 'Another' }, { id: 'third', name: 'Third' }] }],
    harnessDefault: { provider: 'p', model: 'default-model' },
  });
  assert.deepEqual(hint(health, CATALOG_HEALTH_CODES.HARNESS_DEFAULT_MODEL_UNADVERTISED), {
    code: CATALOG_HEALTH_CODES.HARNESS_DEFAULT_MODEL_UNADVERTISED,
    level: 'info',
    provider: 'p',
    model: 'default-model',
  });
  assert.equal(health.warning_count, 0);
  assert.equal(health.attention, false);
});

test('single-provider small explicit catalog emits only an informational constrained signal', () => {
  const health = analyzeCatalogHealth({
    providers: [{ id: 'p', name: 'P', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }],
    harnessDefault: { provider: 'p', model: 'm1' },
  });
  assert.deepEqual(hint(health, CATALOG_HEALTH_CODES.CATALOG_CONSTRAINED), {
    code: CATALOG_HEALTH_CODES.CATALOG_CONSTRAINED,
    level: 'info',
    provider: 'p',
    signal: 'single-provider-small-explicit-catalog',
  });
  assert.equal(health.warning_count, 0);
  assert.equal(health.attention, false);
});

test('listProviders failure is a safe MODEL_CATALOG_UNAVAILABLE error', async () => {
  await assert.rejects(
    readHarnessModelCatalog({ llm: { listProviders() { throw new Error('credential leak'); } } }),
    (error) => error.code === 'MODEL_CATALOG_UNAVAILABLE' && !error.message.includes('credential'),
  );
});

test('missing Harness llm service fails safely', async () => {
  await assert.rejects(readHarnessModelCatalog({}), (error) => error.code === 'MODEL_CATALOG_UNAVAILABLE');
});
