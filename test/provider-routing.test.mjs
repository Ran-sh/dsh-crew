// Provider-routing unit tests: the Hub worker provider must be resolved from
// Crew config + DSH selection, never hard-locked to deepseek-official, and
// the tier→model mapping must stay untouched. Pure resolver tests (no DSH,
// no credentials) cover modes, missing selection, normalization; the
// WorkerRegistry tests verify the final spawn selection reaches the agent.
//
// Run with: node --test test/provider-routing.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGlobalConfig,
  normalizeWorkerProviderMode,
  resolveHubWorkerProvider,
  WORKER_PROVIDER_MODES,
  DEFAULT_WORKER_PROVIDER_MODE,
  POLICY_ERROR_CODES,
} from '../src/policy.mjs';
import { WorkerRegistry } from '../src/hub/index.mjs';

// ---------- resolver (pure) ----------

test('deepseek-official mode → deepseek-official regardless of DSH selection', () => {
  const r = resolveHubWorkerProvider({
    worker_provider_mode: 'deepseek-official',
    getCurrentSelection: () => ({ provider: 'opencode-go', model: 'deepseek-v4-flash' }),
  });
  assert.deepEqual(r, { ok: true, provider: 'deepseek-official', mode: 'deepseek-official' });
});

test('follow-dsh + opencode-go → opencode-go', () => {
  const r = resolveHubWorkerProvider({
    worker_provider_mode: 'follow-dsh',
    getCurrentSelection: () => ({ provider: 'opencode-go', model: 'deepseek-v4-flash' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'opencode-go');
  assert.equal(r.mode, 'follow-dsh');
});

test('follow-dsh + deepseek-official selection → deepseek-official', () => {
  const r = resolveHubWorkerProvider({
    worker_provider_mode: 'follow-dsh',
    getCurrentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'deepseek-official');
});

test('follow-dsh + missing selection → NO_DSH_PROVIDER_SELECTED', () => {
  const r = resolveHubWorkerProvider({ worker_provider_mode: 'follow-dsh', getCurrentSelection: () => undefined });
  assert.equal(r.ok, false);
  assert.equal(r.code, POLICY_ERROR_CODES.NO_DSH_PROVIDER_SELECTED);
  assert.match(r.error, /NO_DSH_PROVIDER_SELECTED|DSH provider/);
});

test('follow-dsh + empty provider in selection → NO_DSH_PROVIDER_SELECTED', () => {
  const r = resolveHubWorkerProvider({ worker_provider_mode: 'follow-dsh', getCurrentSelection: () => ({ provider: '', model: 'x' }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, POLICY_ERROR_CODES.NO_DSH_PROVIDER_SELECTED);
});

test('unknown mode → normalized to legacy-safe default (deepseek-official)', () => {
  assert.equal(normalizeWorkerProviderMode('whatever'), DEFAULT_WORKER_PROVIDER_MODE);
  assert.equal(normalizeWorkerProviderMode(undefined), DEFAULT_WORKER_PROVIDER_MODE);
  assert.equal(normalizeWorkerProviderMode('follow-dsh'), 'follow-dsh');
  assert.equal(normalizeWorkerProviderMode('deepseek-official'), 'deepseek-official');
  assert.deepEqual(Object.values(WORKER_PROVIDER_MODES).sort(), ['deepseek-official', 'follow-dsh']);
});

test('resolver never reads or returns a credential', () => {
  // A crafted selection with a key field must not leak it into the result.
  const r = resolveHubWorkerProvider({
    worker_provider_mode: 'follow-dsh',
    getCurrentSelection: () => ({ provider: 'opencode-go', model: 'deepseek-v4-flash', apiKey: 'sk-leak' }),
  });
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(r).includes('sk-leak'), false);
});

// ---------- config normalization ----------

test('old config without worker_provider_mode → deepseek-official default (no surprise switch)', () => {
  const c = normalizeGlobalConfig({ collaboration_mode: 'balanced' });
  assert.equal(c.worker_provider_mode, 'deepseek-official');
});

test('follow-dsh and deepseek-official survive normalization', () => {
  assert.equal(normalizeGlobalConfig({ worker_provider_mode: 'follow-dsh' }).worker_provider_mode, 'follow-dsh');
  assert.equal(normalizeGlobalConfig({ worker_provider_mode: 'deepseek-official' }).worker_provider_mode, 'deepseek-official');
});

test('unknown worker_provider_mode normalizes to default', () => {
  assert.equal(normalizeGlobalConfig({ worker_provider_mode: 'bogus' }).worker_provider_mode, 'deepseek-official');
});

// ---------- WorkerRegistry spawn selection ----------

function makeRegistry(selection, mode) {
  const registry = new WorkerRegistry({
    get: (key) => {
      if (key === 'loader') return { await: async () => {} };
      if (key === 'agentDefaultModel') return { currentSelection: () => selection };
      return undefined;
    },
  });
  registry.getConfig = () => ({ worker_provider_mode: mode });
  // cap the preset path so spawn returns without needing agentPresets mount
  registry.jobs?.clear?.();
  return registry;
}

function captureAgentOptions(registry) {
  // WorkerRegistry.spawn uses this.ctx.agents.create directly (a property, not
  // ctx.get), so we must expose it as a property on the mock ctx.
  const created = [];
  registry.ctx.agents = {
    create: async (opts) => {
      created.push(opts);
      return {
        agent: { whenIdle: async () => {}, followup: async () => {} },
        dispose: async () => {},
        session: {},
      };
    },
  };
  registry.ctx.sessions = { flush: async () => {} };
  return created;
}

test('Hub Case 1: follow-dsh + opencode-go + tier=flash → provider=opencode-go, model=deepseek-v4-flash', async () => {
  const reg = makeRegistry({ provider: 'opencode-go', model: 'deepseek-v4-flash' }, 'follow-dsh');
  const created = captureAgentOptions(reg);
  const job = await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/tmp' });
  assert.equal(job.tier, 'flash');
  assert.equal(job.model, 'deepseek-v4-flash');
  // The async run is fire-and-forget; give it a tick, then assert the args.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(created.length === 1, 'agents.create must be called once');
  const opts = created[0];
  assert.equal(opts.agentOptions.provider, 'opencode-go');
  assert.equal(opts.agentOptions.model, 'deepseek-v4-flash');
});

test('Hub Case 2: follow-dsh + opencode-go + tier=pro → provider=opencode-go, model=deepseek-v4-pro', async () => {
  const reg = makeRegistry({ provider: 'opencode-go', model: 'deepseek-v4-pro' }, 'follow-dsh');
  const created = captureAgentOptions(reg);
  const job = await reg.spawn({ task: 't', tier: 'pro', effort: 'off', cwd: '/tmp' });
  assert.equal(job.model, 'deepseek-v4-pro');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(created[0].agentOptions.provider, 'opencode-go');
  assert.equal(created[0].agentOptions.model, 'deepseek-v4-pro');
});

test('Hub Case 3: deepseek-official mode + DSH opencode-go → provider=deepseek-official', async () => {
  const reg = makeRegistry({ provider: 'opencode-go', model: 'deepseek-v4-flash' }, 'deepseek-official');
  const created = captureAgentOptions(reg);
  await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/tmp' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(created[0].agentOptions.provider, 'deepseek-official');
  assert.equal(created[0].agentOptions.model, 'deepseek-v4-flash');
});

test('Hub Case 4: provider changes between spawns → second worker uses the new provider', async () => {
  let selection = { provider: 'opencode-go', model: 'deepseek-v4-flash' };
  const reg = new WorkerRegistry({
    get: (key) => {
      if (key === 'loader') return { await: async () => {} };
      if (key === 'agentDefaultModel') return { currentSelection: () => selection };
      return undefined;
    },
  });
  reg.getConfig = () => ({ worker_provider_mode: 'follow-dsh' });
  const created = captureAgentOptions(reg);
  await reg.spawn({ task: 'a', tier: 'flash', effort: 'off', cwd: '/tmp' });
  await new Promise((r) => setTimeout(r, 10));
  selection = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }; // user switched in Models
  await reg.spawn({ task: 'b', tier: 'flash', effort: 'off', cwd: '/tmp' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(created.length, 2);
  assert.equal(created[0].agentOptions.provider, 'opencode-go');
  assert.equal(created[1].agentOptions.provider, 'deepseek-official');
});

test('follow-dsh + no selection → spawn rejects with NO_WORKER_MODEL_AVAILABLE, no agents.create', async () => {
  const reg = makeRegistry(undefined, 'follow-dsh');
  const created = captureAgentOptions(reg);
  await assert.rejects(
    reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/tmp' }),
    (err) => err.policyCode === 'NO_WORKER_MODEL_AVAILABLE',
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(created.length, 0, 'no worker may start without a resolved provider');
});

test('Hub uses configured provider/model priority and records the selection source', async () => {
  const reg = makeRegistry({ provider: 'default', model: 'default-model', reasoningEffort: 'high' }, 'follow-dsh');
  reg.ctx.llm = {
    listProviders: () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'default', name: 'Default' }],
    listModels: async (provider) => provider === 'b' ? [{ provider: 'b', id: 'chosen', name: 'Chosen' }] : [],
  };
  reg.getConfig = () => ({
    worker_provider_mode: 'follow-dsh',
    flash_model_priority: [{ provider: 'b', model: 'chosen' }],
    flash_model_priority_configured: true,
  });
  const created = captureAgentOptions(reg);
  const job = await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/tmp' });
  assert.equal(job.provider, 'b');
  assert.equal(job.model, 'chosen');
  assert.equal(job.selection_source, 'priority');
  assert.equal(job.reasoning_effort, undefined, 'explicit priorities preserve the target provider/model default effort');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(created[0].agentOptions, { provider: 'b', model: 'chosen' });
});

test('Hub resolves Pro from its own priority independently of Flash', async () => {
  const reg = makeRegistry({ provider: 'default', model: 'default-model' }, 'follow-dsh');
  reg.ctx.llm = {
    listProviders: () => [{ id: 'flash-provider', name: 'Flash' }, { id: 'pro-provider', name: 'Pro' }, { id: 'default', name: 'Default' }],
    listModels: async (provider) => provider === 'flash-provider'
      ? [{ id: 'flash-model', name: 'Flash Model' }]
      : provider === 'pro-provider' ? [{ id: 'pro-model', name: 'Pro Model' }] : [],
  };
  reg.getConfig = () => ({
    worker_provider_mode: 'follow-dsh',
    flash_model_priority: [{ provider: 'flash-provider', model: 'flash-model' }],
    flash_model_priority_configured: true,
    pro_model_priority: [{ provider: 'pro-provider', model: 'pro-model' }],
    pro_model_priority_configured: true,
  });
  const created = captureAgentOptions(reg);
  const job = await reg.spawn({ task: 'review', tier: 'pro', effort: 'off', cwd: '/tmp', delivery: 'review' });
  assert.equal(job.provider, 'pro-provider');
  assert.equal(job.model, 'pro-model');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(created[0].agentOptions, { provider: 'pro-provider', model: 'pro-model' });
});

test('caller cannot route around the provider policy (request provider is ignored)', async () => {
  const reg = makeRegistry({ provider: 'opencode-go', model: 'deepseek-v4-flash' }, 'deepseek-official');
  const created = captureAgentOptions(reg);
  await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/tmp', provider: 'rogue' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(created[0].agentOptions.provider, 'deepseek-official', 'provider must come from config+DSH, not the caller');
});

test('Hub keeps only the latest assistant message instead of accumulating agent prose', async () => {
  const handlers = new Map();
  const agentCtx = {
    on: (name, handler) => { handlers.set(name, handler); },
  };
  const reg = makeRegistry({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }, 'deepseek-official');
  reg.ctx.agents = {
    create: async (opts) => {
      await opts.setup(agentCtx);
      return {
        agent: {
          whenIdle: async () => {},
          followup: async () => {
            const emit = handlers.get('session/event');
            emit?.({}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'intermediate prose' }] } } });
            emit?.({}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final delivery report' }] } } });
            emit?.({}, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          },
        },
        session: {},
      };
    },
  };
  reg.ctx.sessions = { flush: async () => {} };

  const job = await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/tmp' });
  await job.promise;

  assert.equal(job.result, 'final delivery report');
  assert.equal(job.lastAssistantText, 'final delivery report');
  assert.equal(job.texts, undefined);
});
