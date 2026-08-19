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

test('follow-dsh + no selection → spawn rejects with NO_DSH_PROVIDER_SELECTED, no agents.create', async () => {
  const reg = makeRegistry(undefined, 'follow-dsh');
  const created = captureAgentOptions(reg);
  await assert.rejects(
    reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/tmp' }),
    (err) => err.policyCode === POLICY_ERROR_CODES.NO_DSH_PROVIDER_SELECTED,
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(created.length, 0, 'no worker may start without a resolved provider');
});

test('caller cannot route around the provider policy (request provider is ignored)', async () => {
  const reg = makeRegistry({ provider: 'opencode-go', model: 'deepseek-v4-flash' }, 'deepseek-official');
  const created = captureAgentOptions(reg);
  await reg.spawn({ task: 't', tier: 'flash', effort: 'off', cwd: '/tmp', provider: 'rogue' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(created[0].agentOptions.provider, 'deepseek-official', 'provider must come from config+DSH, not the caller');
});
