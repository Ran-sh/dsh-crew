import test from 'node:test';
import assert from 'node:assert/strict';
import { projectModelCallability } from '../src/runtime-readiness-snapshot.mjs';

const runtime = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'r1' };
const selections = { worker: { provider: 'p', model: 'm', source: 'priority' } };
const base = { runtime, selections, now: 10_000 };

test('fresh current route health failure wins over historical success', () => {
  const result = projectModelCallability({ ...base,
    health: [{ provider: 'p', model: 'm', state: 'quota-exhausted', fresh: true, expires_at: 20_000, observed_at: 9_000 }],
    jobs: [{ role: 'worker', provider: 'p', model: 'm', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:09.000Z', execution_context: runtime }],
  });
  assert.equal(result.roles.worker.state, 'NOT_CALLABLE');
  assert.equal(result.overall, 'NOT_CALLABLE');
});

test('historical success is callable only with matching route/runtime and TTL', () => {
  const valid = projectModelCallability({ ...base,
    jobs: [{ role: 'worker', provider: 'p', model: 'm', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:09.000Z', execution_context: runtime }],
    execution_evidence_ttl_ms: 2_000,
  });
  assert.equal(valid.roles.worker.state, 'CALLABLE');
  const stale = projectModelCallability({ ...base, execution_evidence_ttl_ms: 500,
    jobs: [{ role: 'worker', provider: 'p', model: 'm', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:09.000Z', execution_context: runtime }],
  });
  assert.equal(stale.roles.worker.state, 'STALE');
  const foreign = projectModelCallability({ ...base,
    jobs: [{ role: 'worker', provider: 'p', model: 'm', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:09.000Z', execution_context: { ...runtime, runtime_id: 'old' } }],
  });
  assert.equal(foreign.roles.worker.state, 'UNKNOWN');
});

test('expired health and missing route do not become READY', () => {
  const expired = projectModelCallability({ ...base, health: [{ provider: 'p', model: 'm', state: 'callable', fresh: false, expires_at: 9_000 }] });
  assert.equal(expired.roles.worker.state, 'STALE');
  const missing = projectModelCallability({ runtime, selections: {}, health: [], jobs: [], now: 10_000 });
  assert.equal(missing.overall, 'UNKNOWN');
});
