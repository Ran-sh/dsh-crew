import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_MODEL_ACTIVITY_ROWS, MAX_MODEL_INVOCATION_JOBS, aggregateModelInvocations } from '../src/client/task-telemetry.mjs';

test('model invocation telemetry aggregates count, sources, roles, and newest call', () => {
  const rows = aggregateModelInvocations([
    {
      id: 'older', provider: 'opencode-muse', model: 'ox-alpha-free', role: 'worker',
      source: 'codex', selection_source: 'priority', turn: 1, startedAt: '2026-08-26T01:00:00.000Z',
    },
    {
      id: 'newer', provider: 'opencode-muse', model: 'ox-alpha-free', role: 'reviewer',
      source: 'api', selection_source: 'adaptive', turn: 1, startedAt: '2026-08-26T03:00:00.000Z',
    },
    {
      id: 'other', provider: 'deepseek', model: 'v4', role: 'worker',
      source: 'claude-code', selection_source: 'harness-default', tokens: { input: 1, output: 0 }, startedAt: '2026-08-26T02:00:00.000Z',
    },
  ]);

  assert.deepEqual(rows, [
    {
      provider: 'opencode-muse', model: 'ox-alpha-free', count: 2,
      task_sources: ['api', 'codex'], selection_sources: ['adaptive', 'priority'],
      roles: ['reviewer', 'worker'], last_called_at: '2026-08-26T03:00:00.000Z',
    },
    {
      provider: 'deepseek', model: 'v4', count: 1,
      task_sources: ['claude-code'], selection_sources: ['harness-default'],
      roles: ['worker'], last_called_at: '2026-08-26T02:00:00.000Z',
    },
  ]);
});

test('telemetry ignores jobs without a concrete model and never mutates input', () => {
  const jobs = Object.freeze([
    Object.freeze({ id: 'pending', status: 'queued', provider: null, model: null }),
    Object.freeze({ id: 'selected-not-called', provider: 'skip', model: 'skip', turn: 0, startedAt: '2026-08-26T01:00:00.000Z' }),
    Object.freeze({ id: 'called', provider: 'p', model: 'm', turn: 1, source: undefined, startedAt: 'invalid' }),
  ]);
  assert.deepEqual(aggregateModelInvocations(jobs), [{
    provider: 'p', model: 'm', count: 1, task_sources: ['api'], selection_sources: ['unknown'],
    roles: ['worker'], last_called_at: null,
  }]);
});

test('telemetry bounds both the inspected job window and rendered model rows', () => {
  const jobs = Array.from({ length: MAX_MODEL_INVOCATION_JOBS + 5 }, (_, index) => ({
    id: `job-${index}`,
    provider: `provider-${index}`,
    model: `model-${index}`,
    turn: 1,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const rows = aggregateModelInvocations(jobs);
  assert.equal(rows.length, MAX_MODEL_ACTIVITY_ROWS);
  assert.ok(rows.every((row) => Number(row.model.split('-').at(-1)) >= 5));
});
