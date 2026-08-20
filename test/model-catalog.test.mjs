import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHarnessModelCatalog } from '../src/model-catalog.mjs';

function fakeLlm(providers, models) {
  return { listProviders: () => providers, listModels: async (id) => {
    const value = models[id];
    if (value instanceof Error) throw value;
    return value ?? [];
  } };
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
  assert.equal(JSON.stringify(result).includes('sk-nope'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('one provider model-list failure produces a partial catalog', async () => {
  const result = await readHarnessModelCatalog({
    llm: fakeLlm([{ id: 'ok', name: 'OK' }, { id: 'bad', name: 'Bad' }], { ok: [{ id: 'm', name: 'M' }], bad: new Error('token=secret') }),
  });
  assert.equal(result.partial, true);
  assert.deepEqual(result.providers[1], { id: 'bad', name: 'Bad', models: [], error: 'MODEL_LIST_FAILED' });
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
  assert.doesNotMatch(JSON.stringify(result), /secret|authorization|api_key/i);
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
