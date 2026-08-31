import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeReadinessSnapshot } from '../src/runtime-readiness-snapshot.mjs';

const matrix = { rows: [
  { id: 'hub_compatibility', status: 'PASS', reason_code: 'LIVE_CHECK_PASSED' },
  { id: 'provider_lifecycle_consistent', status: 'PASS', reason_code: 'PROVIDER_LIFECYCLE_CONSISTENT' },
], summary: { PASS: 2 } };

test('runtime readiness snapshot centralizes provenance, selections, health and matrix', () => {
  const snapshot = buildRuntimeReadinessSnapshot({
    runtime: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1', capabilities: ['jobs'] },
    readinessMatrix: matrix,
    selections: { worker: { provider: 'opencode-muse', model: 'mimo-v2.5', source: 'priority' } },
    health: [{ provider: 'opencode-muse', model: 'mimo-v2.5', state: 'callable', fresh: true }],
    jobs: [{ id: 'job-1', role: 'worker', task: 'SECRET TASK', result: 'SECRET RESULT' }],
  });
  assert.equal(snapshot.schema_version, 1);
  assert.deepEqual(snapshot.runtime, { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' });
  assert.deepEqual(snapshot.worker.selected, { provider: 'opencode-muse', model: 'mimo-v2.5', source: 'priority' });
  assert.deepEqual(snapshot.worker.health, [{ provider: 'opencode-muse', model: 'mimo-v2.5', state: 'callable', fresh: true }]);
  assert.deepEqual(snapshot.readiness_matrix, matrix);
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false);
});

test('runtime readiness snapshot bounds health and ignores foreign runtime provenance', () => {
  const snapshot = buildRuntimeReadinessSnapshot({
    runtime: { execution_plane: 'standalone', profile: 'legacy', listen_port: 3080, runtime_id: 'foreign', secret: 'x' },
    health: Array.from({ length: 300 }, (_, index) => ({ provider: `p-${index}`, model: 'm', state: 'callable', fresh: true })),
  });
  assert.deepEqual(snapshot.runtime, { execution_plane: 'standalone', profile: 'legacy', listen_port: 3080, runtime_id: 'foreign' });
  assert.equal(snapshot.health.length, 128);
});
