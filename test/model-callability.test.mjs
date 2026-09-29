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
  const stale = projectModelCallability({ ...base, execution_evidence_ttl_ms: 1_000,
    jobs: [{ role: 'worker', provider: 'p', model: 'm', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:09.000Z', execution_context: runtime }],
  });
  assert.equal(stale.roles.worker.state, 'STALE');
  const foreign = projectModelCallability({ ...base,
    jobs: [{ role: 'worker', provider: 'p', model: 'm', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:09.000Z', execution_context: { ...runtime, runtime_id: 'old' } }],
  });
  assert.equal(foreign.roles.worker.state, 'UNKNOWN');
  const foreignPlane = projectModelCallability({ ...base,
    jobs: [{ role: 'worker', provider: 'p', model: 'm', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:09.000Z', execution_context: { ...runtime, execution_plane: 'standalone' } }],
  });
  assert.equal(foreignPlane.roles.worker.state, 'UNKNOWN');
});

test('expired health and missing route do not become READY', () => {
  const expired = projectModelCallability({ ...base, health: [{ provider: 'p', model: 'm', state: 'callable', fresh: false, expires_at: 9_000, observed_at: 8_000 }] });
  assert.equal(expired.roles.worker.state, 'STALE');
  const missing = projectModelCallability({ runtime, selections: {}, health: [], jobs: [], now: 10_000 });
  assert.equal(missing.overall, 'UNKNOWN');
});

test('disabled reviewer does not block callable worker readiness', () => {
  const result = projectModelCallability({ ...base,
    enabled_roles: { worker: true, reviewer: false },
    health: [{ provider: 'p', model: 'm', state: 'callable', fresh: true, expires_at: 20_000, observed_at: 9_000 }],
  });
  assert.equal(result.roles.worker.state, 'CALLABLE');
  assert.equal(result.roles.reviewer.state, 'NOT_APPLICABLE');
  assert.equal(result.overall, 'CALLABLE');
});

test('malformed health expiry and invalid execution TTL are conservative', () => {
  const result = projectModelCallability({ ...base,
    health: [{ provider: 'p', model: 'm', state: 'callable', fresh: true, observed_at: 9_000 }],
    execution_evidence_ttl_ms: -1,
  });
  assert.equal(result.roles.worker.state, 'STALE');
  assert.equal(result.execution_evidence_ttl_ms, 300_000);
});

test('health collection failure blocks historical fallback', () => {
  const result = projectModelCallability({ ...base,
    health_status: 'UNAVAILABLE',
    jobs: [{ role: 'worker', provider: 'p', model: 'm', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:09.000Z', execution_context: runtime }],
  });
  assert.equal(result.roles.worker.state, 'UNKNOWN');
  assert.equal(result.roles.worker.reason_code, 'PROVIDER_HEALTH_UNAVAILABLE');
});

test('current route observations are order independent and newer failure wins', () => {
  const observations = [
    { provider: 'p', model: 'm', state: 'callable', fresh: true, observed_at: 9_000, expires_at: 20_000 },
    { provider: 'p', model: 'm', state: 'quota-exhausted', fresh: true, observed_at: 9_500, expires_at: 20_000 },
  ];
  for (const health of [observations, [...observations].reverse()]) {
    const result = projectModelCallability({ ...base, health });
    assert.equal(result.roles.worker.state, 'NOT_CALLABLE');
  }
});

test('future-dated execution evidence is not callable', () => {
  const result = projectModelCallability({ ...base,
    jobs: [{ role: 'worker', provider: 'p', model: 'm', status: 'done', task_status: 'success', endedAt: '1970-01-01T00:00:20.000Z', execution_context: runtime }],
  });
  assert.equal(result.roles.worker.state, 'STALE');
  assert.equal(result.roles.worker.reason_code, 'EXECUTION_EVIDENCE_FUTURE_DATED');
});

test('future-dated provider health is never callable', () => {
  const result = projectModelCallability({ ...base,
    health: [{ provider: 'p', model: 'm', state: 'callable', fresh: true, observed_at: 10_001, expires_at: 20_000 }],
  });
  assert.equal(result.roles.worker.state, 'STALE');
  assert.equal(result.roles.worker.reason_code, 'PROVIDER_HEALTH_STALE_OR_INVALID');
});

// The execution window is refreshed by real work, not by a clock. A probe at T0
// is one second from expiry at T+4m59s; a job that actually ran the route at
// T+4m59s carries validity to T+9m59s. Without this, a hub that is working reads
// as stale five minutes after its last probe — and a longer fixed TTL would only
// postpone the same false degradation.
test('a completed job renews the execution window, and work that did not run does not', () => {
  const ttl = 300_000;
  const job = (id, endedMs, extra = {}) => ({ id, role: 'worker', provider: 'p', model: 'm',
    status: 'done', task_status: 'success', endedAt: new Date(endedMs).toISOString(), execution_context: runtime, ...extra });
  const project = (now, jobs) => projectModelCallability({ ...base, now, jobs, execution_evidence_ttl_ms: ttl });

  const spanned = project(0, [job('job-1', 0)]);
  assert.equal(spanned.roles.worker.state, 'CALLABLE');
  assert.equal(spanned.roles.worker.expires_at, 300_000);
  assert.equal(project(299_000, [job('job-1', 0)]).roles.worker.state, 'CALLABLE');

  const renewed = project(299_000, [job('job-1', 0), job('job-2', 299_000)]);
  assert.equal(renewed.roles.worker.state, 'CALLABLE');
  assert.equal(renewed.roles.worker.expires_at, 599_000, 'a success at T+4m59s is valid until T+9m59s');
  assert.equal(renewed.roles.worker.last_success.job_id, 'job-2');
  assert.equal(renewed.roles.worker.observed_at, 299_000);

  // A run that did not execute the route is not evidence that it works: it neither
  // renews the window nor becomes the last success.
  const notEvidence = [
    job('job-failed', 299_000, { task_status: 'failed' }),
    job('job-cancelled', 299_000, { status: 'cancelled' }),
    job('job-running', 299_000, { status: 'running', task_status: null }),
    job('job-reviewer', 299_000, { role: 'reviewer' }),
    job('job-other-model', 299_000, { model: 'm2' }),
  ];
  const withNoise = project(299_000, [job('job-1', 0), ...notEvidence]);
  assert.equal(withNoise.roles.worker.state, 'CALLABLE', 'the earlier success still governs');
  assert.equal(withNoise.roles.worker.last_success.job_id, 'job-1');
  assert.equal(withNoise.roles.worker.expires_at, 300_000);

  const pastWindow = project(300_001, [job('job-1', 0), ...notEvidence]);
  assert.equal(pastWindow.roles.worker.state, 'STALE', 'no success beyond the TTL means stale, not renewed');
  assert.equal(pastWindow.roles.worker.reason_code, 'EXECUTION_EVIDENCE_EXPIRED');
});

// The window belongs to the runtime that earned it. A job from the hub this one
// replaced says nothing about this hub, so it must not renew it — a restart would
// otherwise inherit callability from a process that no longer exists.
test('a previous hub runtime cannot renew the current execution window', () => {
  const ttl = 300_000;
  const job = (id, endedMs, executionContext) => ({ id, role: 'worker', provider: 'p', model: 'm',
    status: 'done', task_status: 'success', endedAt: new Date(endedMs).toISOString(), execution_context: executionContext });
  const result = projectModelCallability({ ...base, now: 299_000, execution_evidence_ttl_ms: ttl,
    jobs: [job('job-1', 0, runtime), job('job-old-hub', 299_000, { ...runtime, runtime_id: 'old' })],
  });
  assert.equal(result.roles.worker.state, 'CALLABLE');
  assert.equal(result.roles.worker.last_success.job_id, 'job-1', 'the old hub\'s success is not this hub\'s');
  assert.equal(result.roles.worker.expires_at, 300_000, 'and it does not extend this hub\'s window');
});
