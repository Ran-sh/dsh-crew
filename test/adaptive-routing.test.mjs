import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTIVE_ROUTING_REASON_CODES,
  createAdaptiveHealthStore,
  getProcessAdaptiveHealthStore,
  normalizeAdaptiveRouting,
  rankAdaptiveCandidates,
} from '../src/adaptive-routing.mjs';
import {
  MODEL_SELECTION_REASON_CODES,
  resolveWorkerModel,
} from '../src/model-routing.mjs';
import { normalizeGlobalConfig, resolveModelPolicy } from '../src/policy.mjs';
import { recordAdaptiveJobOutcome } from '../src/hub/entry.mjs';

const provider = (id, models = []) => ({ id, name: id, models: models.map((model) => ({ id: model, name: model })) });
const catalog = (...providers) => ({ providers });
const flash = 'deepseek-v4-flash';

function record(store, ref, status, count = 1, extra = {}) {
  for (let index = 0; index < count; index++) {
    assert.equal(store.record(ref, { role: 'worker', status, latencyMs: 10_000, ...extra }), true);
  }
}

test('adaptive routing is opt-in and clamps its bounded window', () => {
  assert.deepEqual(normalizeAdaptiveRouting(), { enabled: false, window_size: 8, min_samples: 2 });
  assert.deepEqual(normalizeAdaptiveRouting({ enabled: true, window_size: 100, min_samples: 99 }), {
    enabled: true,
    window_size: 32,
    min_samples: 32,
  });
  assert.deepEqual(normalizeAdaptiveRouting({ enabled: 1, window_size: 0, min_samples: 0 }), {
    enabled: false,
    window_size: 1,
    min_samples: 1,
  });
});

test('health store keeps only bounded Crew-observed outcome and latency signals', () => {
  const store = createAdaptiveHealthStore({ maxSamples: 3 });
  const ref = { provider: 'a', model: 'm' };
  record(store, ref, 'done', 2, { error: 'must-not-be-stored', credential: 'must-not-be-stored' });
  record(store, ref, 'failed', 1, { latencyMs: 200_000 });
  record(store, ref, 'failed', 1, { stopReason: 'timeout', latencyMs: 200_000 });
  const snapshot = store.snapshot(ref, { role: 'worker', windowSize: 8 });
  assert.equal(snapshot.samples, 3);
  assert.equal(snapshot.successes, 1);
  assert.equal(snapshot.failures, 1);
  assert.equal(snapshot.timeouts, 1);
  assert.equal(snapshot.latency_bucket, 'slow');
  assert.equal(typeof snapshot.score, 'number');
  assert.equal(JSON.stringify(snapshot).includes('must-not-be-stored'), false);
});

test('Hub observer records only opt-in adaptive jobs and never stores raw error payloads', () => {
  const store = createAdaptiveHealthStore();
  const base = {
    provider: 'a', model: 'm', role: 'worker', status: 'failed', stopReason: 'error',
    startedAt: '2026-08-21T16:00:00.000Z', endedAt: '2026-08-21T16:00:05.000Z',
    error: 'raw-secret-like-error', credential: 'never-store-this',
  };
  assert.equal(recordAdaptiveJobOutcome({ ...base, selection_trace: {} }, store), false);
  assert.equal(store.snapshot({ provider: 'a', model: 'm' }).samples, 0);
  assert.equal(recordAdaptiveJobOutcome({
    ...base,
    selection_trace: { adaptive: { enabled: true } },
  }, store), true);
  const snapshot = store.snapshot({ provider: 'a', model: 'm' });
  assert.equal(snapshot.samples, 1);
  assert.equal(snapshot.failures, 1);
  assert.equal(snapshot.latency_bucket, 'fast');
  assert.equal(JSON.stringify(snapshot).includes('raw-secret-like-error'), false);
  assert.equal(JSON.stringify(snapshot).includes('never-store-this'), false);
});

test('process-local Hub health is the default resolver signal when no store is injected', () => {
  const store = getProcessAdaptiveHealthStore();
  store.clear();
  try {
    record(store, { provider: 'a', model: flash }, 'failed', 2);
    const result = resolveWorkerModel({
      tier: 'flash',
      priority: [],
      priorityConfigured: false,
      catalog: catalog(provider('a', [flash]), provider('b', [flash])),
      harnessDefault: { provider: 'a', model: 'other' },
      adaptive: { enabled: true, min_samples: 2 },
    });
    assert.equal(result.provider, 'b');
    assert.equal(result.selection_trace.adaptive.reason, ADAPTIVE_ROUTING_REASON_CODES.HEALTH_REORDERED);
    assert.equal(result.selection_trace.adaptive.decision_supported, true);
  } finally {
    store.clear();
  }
});

test('explicit user priority is authoritative even when health prefers another candidate', () => {
  const store = createAdaptiveHealthStore();
  record(store, { provider: 'a', model: 'm' }, 'failed', 2);
  record(store, { provider: 'b', model: 'm' }, 'done', 2);
  const ranked = rankAdaptiveCandidates([
    { provider: 'a', model: 'm' },
    { provider: 'b', model: 'm' },
  ], {
    config: { enabled: true, min_samples: 2 },
    healthStore: store,
    role: 'worker',
    explicitPriority: true,
  });
  assert.deepEqual(ranked.candidates.map((item) => item.provider), ['a', 'b']);
  assert.equal(ranked.trace.reason, ADAPTIVE_ROUTING_REASON_CODES.EXPLICIT_PRIORITY);
  assert.equal(ranked.trace.decision_supported, false);
  assert.equal(ranked.trace.applied, false);
});

test('adaptive ordering can move an unknown automatic candidate ahead of a mature unhealthy one', () => {
  const store = createAdaptiveHealthStore();
  record(store, { provider: 'a', model: 'm' }, 'failed', 2);
  const ranked = rankAdaptiveCandidates([
    { provider: 'a', model: 'm' },
    { provider: 'b', model: 'm' },
  ], {
    config: { enabled: true, min_samples: 2 },
    healthStore: store,
    role: 'worker',
  });
  assert.deepEqual(ranked.candidates.map((item) => item.provider), ['b', 'a']);
  assert.equal(ranked.trace.reason, ADAPTIVE_ROUTING_REASON_CODES.HEALTH_REORDERED);
  assert.equal(ranked.trace.decision_supported, true);
  assert.equal(ranked.trace.applied, true);
  assert.equal(ranked.trace.candidates.find((item) => item.provider === 'a').health_state, 'mature');
  assert.equal(ranked.trace.candidates.find((item) => item.provider === 'b').health_state, 'warming');
});

test('insufficient adaptive history preserves deterministic Harness Default provider preference', () => {
  const store = createAdaptiveHealthStore();
  record(store, { provider: 'a', model: flash }, 'failed', 1);
  const result = resolveWorkerModel({
    tier: 'flash',
    priority: [],
    priorityConfigured: false,
    catalog: catalog(provider('a', [flash]), provider('b', [flash])),
    harnessDefault: { provider: 'a', model: 'other' },
    adaptive: { enabled: true, min_samples: 2 },
    adaptiveHealth: store,
  });
  assert.equal(result.provider, 'a');
  assert.equal(result.source, 'preferred-default');
  assert.equal(result.selection_trace.adaptive.reason, ADAPTIVE_ROUTING_REASON_CODES.INSUFFICIENT_HISTORY);
  assert.equal(result.selection_trace.adaptive.decision_supported, false);
});

test('adaptive health can override automatic preferred-provider ambiguity and is fully traceable', () => {
  const store = createAdaptiveHealthStore();
  record(store, { provider: 'a', model: flash }, 'failed', 2, { error: 'secret-error-detail' });
  const result = resolveWorkerModel({
    tier: 'flash',
    priority: [],
    priorityConfigured: false,
    catalog: catalog(provider('a', [flash]), provider('b', [flash])),
    harnessDefault: { provider: 'a', model: 'other' },
    adaptive: { enabled: true, min_samples: 2 },
    adaptiveHealth: store,
  });
  assert.equal(result.provider, 'b');
  assert.equal(result.model, flash);
  assert.equal(result.source, 'preferred-default');
  assert.equal(result.selection_trace.adaptive.reason, ADAPTIVE_ROUTING_REASON_CODES.HEALTH_REORDERED);
  assert.equal(result.selection_trace.adaptive.decision_supported, true);
  assert.equal(result.selection_trace.ordered_candidates[0].provider, 'a');
  assert.equal(result.selection_trace.ordered_candidates[0].reason_code, MODEL_SELECTION_REASON_CODES.ADAPTIVE_DEPRIORITIZED);
  assert.deepEqual(result.selection_trace.selected, { provider: 'b', model: flash, source: 'preferred-default' });
  const serialized = JSON.stringify(result.selection_trace);
  assert.equal(serialized.includes('secret-error-detail'), false);
  assert.equal(serialized.toLowerCase().includes('credential'), false);
  assert.equal(serialized.toLowerCase().includes('quota'), false);
});

test('adaptive evidence may resolve preferred-model ambiguity when Harness Default names another provider', () => {
  const store = createAdaptiveHealthStore();
  record(store, { provider: 'b', model: flash }, 'done', 2);
  const result = resolveWorkerModel({
    tier: 'flash',
    priority: [],
    priorityConfigured: false,
    catalog: catalog(provider('a', [flash]), provider('b', [flash]), provider('default-provider', ['default-model'])),
    harnessDefault: { provider: 'default-provider', model: 'default-model' },
    adaptive: { enabled: true, min_samples: 2 },
    adaptiveHealth: store,
  });
  assert.equal(result.provider, 'b');
  assert.equal(result.source, 'preferred-default');
  assert.equal(result.selection_trace.adaptive.decision_supported, true);
  assert.equal(result.selection_trace.fallback_reason, null);
});

test('resolver never lets adaptive health reorder an explicit provider/model priority', () => {
  const store = createAdaptiveHealthStore();
  record(store, { provider: 'a', model: 'm1' }, 'failed', 2);
  record(store, { provider: 'b', model: 'm2' }, 'done', 2);
  const result = resolveWorkerModel({
    tier: 'flash',
    priority: [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }],
    priorityConfigured: true,
    catalog: catalog(provider('a', ['m1']), provider('b', ['m2'])),
    harnessDefault: { provider: 'b', model: 'm2' },
    adaptive: { enabled: true, min_samples: 2 },
    adaptiveHealth: store,
  });
  assert.equal(result.provider, 'a');
  assert.equal(result.model, 'm1');
  assert.equal(result.matchedPriorityIndex, 0);
  assert.equal(result.selection_trace.adaptive.reason, ADAPTIVE_ROUTING_REASON_CODES.EXPLICIT_PRIORITY);
});

test('schema-v3 canonical policy preserves adaptive opt-in while legacy/default policy stays off', () => {
  const raw = {
    config_schema_version: 3,
    subagents_enabled: true,
    main_agent_mode: 'coordinator-first',
    execution: {
      enabled: true,
      default_effort: 'max',
      default_timeout_seconds: 60,
      mode: 'auto',
      max_parallel: 3,
      isolation: 'worktree',
    },
    worker: {
      state: 'auto',
      provider_mode: 'follow-dsh',
      model_policy: {
        role: 'worker',
        strategy: 'balanced',
        priority: [],
        priorityConfigured: false,
        escalation_priority: [],
        escalation_priority_configured: false,
        fallback: 'harness-default',
        escalation: { enabled: false, max_attempts: 2 },
        adaptive: { enabled: true, window_size: 12, min_samples: 3 },
      },
    },
    review: {
      state: 'disabled',
      mode: 'auto',
      auto_review: false,
      provider_mode: 'follow-dsh',
      model_policy: {
        role: 'reviewer',
        strategy: 'strong',
        priority: [],
        priorityConfigured: false,
        escalation_priority: [],
        escalation_priority_configured: false,
        fallback: 'harness-default',
        escalation: { enabled: false, max_attempts: 2 },
      },
    },
    legacy: { collaboration_mode: 'balanced', tier_policy: 'auto', flash_state: 'auto', pro_state: 'auto' },
  };

  const normalized = normalizeGlobalConfig(raw);
  assert.deepEqual(normalized.worker.model_policy.adaptive, { enabled: true, window_size: 12, min_samples: 3 });
  assert.deepEqual(resolveModelPolicy(normalized, 'worker').adaptive, { enabled: true, window_size: 12, min_samples: 3 });
  assert.deepEqual(resolveModelPolicy({}, 'worker').adaptive, { enabled: false, window_size: 8, min_samples: 2 });
});

test('schema-v4 ordering is the role-first authority for adaptive reordering', () => {
  const base = {
    config_schema_version: 4,
    subagents_enabled: true,
    execution: { enabled: true, transport: 'hub-3210', mode: 'auto', max_parallel: 3, isolation: 'worktree' },
    worker: { state: 'auto', model_policy: { priority: [], escalation_priority: [], ordering: 'health-aware', health_gate: 'hard-failures', adaptive: { enabled: false, window_size: 10, min_samples: 2 }, escalation: { enabled: false, max_attempts: 2 } } },
    review: { state: 'manual', auto_review: false, gate: 'required', model_policy: { priority: [], ordering: 'manual', adaptive: { enabled: true } } },
    legacy: { collaboration_mode: 'custom', flash_state: 'auto', pro_state: 'auto' },
  };
  const normalized = normalizeGlobalConfig(base);
  assert.equal(normalized.worker.model_policy.ordering, 'health-aware');
  assert.equal(normalized.worker.model_policy.adaptive.enabled, true);
  assert.equal(normalized.review.model_policy.ordering, 'manual');
  assert.equal(normalized.review.model_policy.adaptive.enabled, false);
  assert.equal(resolveModelPolicy(normalized, 'worker').health_gate, 'hard-failures');
});
