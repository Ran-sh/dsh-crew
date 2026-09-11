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

// ---- per-model peak/off-peak scheduling ----

const schedule = (models) => ({ timezone_offset_minutes: 480, weekdays: [1, 2, 3, 4, 5],
  peak_windows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }], models });
const monPeak = new Date('2026-09-14T02:00:00Z');   // Mon 10:00 at UTC+8
const monOffPeak = new Date('2026-09-14T11:00:00Z'); // Mon 19:00 at UTC+8

test('a peak-blocked candidate is skipped and the next model serves the job', () => {
  const result = resolveWorkerModel({
    tier: 'pro', priorityConfigured: true,
    priority: [{ provider: 'a', model: 'expensive' }, { provider: 'a', model: 'cheap' }],
    catalog: catalog([provider('a', ['expensive', 'cheap'])]), harnessDefault,
    schedule: schedule([{ provider: 'a', model: 'expensive', mode: 'block' }]),
    at: monPeak,
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'cheap', 'the job still runs on the next candidate');
  assert.equal(result.source, 'priority');
  assert.equal(result.matchedPriorityIndex, 1);
  const skipped = result.selection_trace.ordered_candidates.find((row) => row.model === 'expensive');
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason_code, MODEL_SELECTION_REASON_CODES.PEAK_RESTRICTED);
});

test('a peak-blocked model is selectable again once the window closes', () => {
  const result = resolveWorkerModel({
    tier: 'pro', priorityConfigured: true,
    priority: [{ provider: 'a', model: 'expensive' }, { provider: 'a', model: 'cheap' }],
    catalog: catalog([provider('a', ['expensive', 'cheap'])]), harnessDefault,
    schedule: schedule([{ provider: 'a', model: 'expensive', mode: 'block' }]),
    at: monOffPeak,
  });
  assert.equal(result.model, 'expensive');
  assert.equal(result.matchedPriorityIndex, 0);
});

// The third state the operator asked for: restricted in name only. The model is
// still used during peak, and the trace records that it was.
test('a warn-mode model stays selectable during peak and is flagged', () => {
  const result = resolveWorkerModel({
    tier: 'pro', priorityConfigured: true,
    priority: [{ provider: 'a', model: 'watched' }, { provider: 'a', model: 'cheap' }],
    catalog: catalog([provider('a', ['watched', 'cheap'])]), harnessDefault,
    schedule: schedule([{ provider: 'a', model: 'watched', mode: 'warn' }]),
    at: monPeak,
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'watched', 'warn must not divert the selection');
  assert.equal(result.peak_advisory, true);
  const selected = result.selection_trace.ordered_candidates.at(-1);
  assert.equal(selected.status, 'selected');
  assert.equal(selected.reason_code, MODEL_SELECTION_REASON_CODES.PEAK_ADVISORY);
});

test('an unrestricted model is unaffected by another model being blocked', () => {
  const result = resolveWorkerModel({
    tier: 'pro', priorityConfigured: true,
    priority: [{ provider: 'a', model: 'unlisted' }],
    catalog: catalog([provider('a', ['unlisted'])]), harnessDefault,
    schedule: schedule([{ provider: 'a', model: 'other', mode: 'block' }]),
    at: monPeak,
  });
  assert.equal(result.model, 'unlisted');
  assert.equal(result.peak_advisory, undefined);
});

test('an explicit no-fallback dispatch reports the block instead of diverting', () => {
  const result = resolveWorkerModel({
    tier: 'pro', priorityConfigured: true,
    priority: [{ provider: 'a', model: 'expensive' }, { provider: 'a', model: 'cheap' }],
    catalog: catalog([provider('a', ['expensive', 'cheap'])]), harnessDefault,
    allowFallback: false,
    schedule: schedule([{ provider: 'a', model: 'expensive', mode: 'block' }]),
    at: monPeak,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MODEL_BLOCKED_PEAK');
});

test('a block also applies along the preferred-default path', () => {
  const result = resolveWorkerModel({
    tier: 'pro', priority: [], priorityConfigured: false,
    catalog: catalog([provider('a', ['deepseek-v4-pro']), provider('default-provider', ['default-model'])]),
    harnessDefault,
    schedule: schedule([{ provider: 'a', model: 'deepseek-v4-pro', mode: 'block' }]),
    at: monPeak,
  });
  assert.equal(result.ok, true);
  assert.notEqual(result.model, 'deepseek-v4-pro', 'the preferred default must not slip past a block');
  assert.equal(result.source, 'harness-default', 'it falls through to the Harness Default');
  const blocked = result.selection_trace.ordered_candidates.find((row) => row.model === 'deepseek-v4-pro');
  assert.equal(blocked.reason_code, MODEL_SELECTION_REASON_CODES.PEAK_RESTRICTED);
});

test('routing without a schedule is unchanged', () => {
  const result = resolveWorkerModel({
    tier: 'pro', priorityConfigured: true,
    priority: [{ provider: 'a', model: 'expensive' }],
    catalog: catalog([provider('a', ['expensive'])]), harnessDefault,
    at: monPeak,
  });
  assert.equal(result.model, 'expensive');
  assert.equal(result.peak_advisory, undefined);
});

// ---- Oracle review regressions ----

// D1: filtering computes a peak verdict per candidate, but only the surviving
// candidate object used to be kept, so a `warn` selected through the
// multi-provider path lost its advisory entirely.
test('a warn verdict survives the multi-provider preferred-default path', () => {
  const result = resolveWorkerModel({
    tier: 'pro', priority: [], priorityConfigured: false,
    catalog: catalog([provider('a', ['deepseek-v4-pro']), provider('b', ['deepseek-v4-pro'])]),
    harnessDefault: { provider: 'a', model: 'deepseek-v4-pro' },
    schedule: schedule([{ provider: 'a', model: 'deepseek-v4-pro', mode: 'warn' }]),
    at: monPeak,
  });
  assert.equal(result.ok, true);
  assert.equal(result.peak_advisory, true, 'the advisory must reach the caller');
  const selected = result.selection_trace.ordered_candidates.find((row) => row.status === 'selected');
  assert.equal(selected.reason_code, MODEL_SELECTION_REASON_CODES.PEAK_ADVISORY);
});

// D2: when filtering leaves exactly one admissible candidate but removes the one
// matching the Harness Default provider, both the deterministic and adaptive
// choices were empty, so the survivor was reported ambiguous and the resolver
// fell through to Harness Default — which was itself blocked — and failed.
test('a lone admissible candidate is selected rather than called ambiguous', () => {
  const result = resolveWorkerModel({
    tier: 'pro', priority: [], priorityConfigured: false,
    catalog: catalog([provider('a', ['deepseek-v4-pro']), provider('b', ['deepseek-v4-pro'])]),
    harnessDefault: { provider: 'a', model: 'deepseek-v4-pro' },
    schedule: schedule([{ provider: 'a', model: 'deepseek-v4-pro', mode: 'block' }]),
    at: monPeak,
  });
  assert.equal(result.ok, true, 'an admissible candidate existed and must be used');
  assert.equal(result.provider, 'b');
  assert.equal(result.model, 'deepseek-v4-pro');
});

// D4: a candidate rejected for a concrete reason must appear once, with that
// reason — not again as ambiguous.
test('a blocked preferred candidate is recorded once, with its real reason', () => {
  const result = resolveWorkerModel({
    tier: 'pro', priority: [], priorityConfigured: false,
    catalog: catalog([provider('a', ['deepseek-v4-pro']), provider('b', ['deepseek-v4-pro'])]),
    harnessDefault: { provider: 'a', model: 'deepseek-v4-pro' },
    schedule: schedule([
      { provider: 'a', model: 'deepseek-v4-pro', mode: 'block' },
      { provider: 'b', model: 'deepseek-v4-pro', mode: 'block' },
    ]),
    at: monPeak,
  });
  const rows = result.selection_trace.ordered_candidates
    .filter((row) => row.provider === 'a' && row.model === 'deepseek-v4-pro');
  assert.equal(rows.length, 1, 'a rejected candidate must not be recorded twice');
  assert.equal(rows[0].reason_code, MODEL_SELECTION_REASON_CODES.PEAK_RESTRICTED);
});
