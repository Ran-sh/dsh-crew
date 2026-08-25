import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hubCanonicalEvents } from '../src/hub/index.mjs';
import { HUB_CAPABILITIES } from '../src/runtime-identity.mjs';

const hubSource = readFileSync(new URL('../src/hub/index.mjs', import.meta.url), 'utf8');

test('Hub advertises the extension, profile, context, evidence and event surfaces', () => {
  for (const capability of ['canonical-events', 'evidence', 'profiles', 'workspace-context', 'extension-contract']) {
    assert.ok(HUB_CAPABILITIES.includes(capability), capability);
  }
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/extension`/);
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/profiles`/);
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/workspaces`/);
  assert.match(hubSource, /parts\.length === 2 && parts\[1\] === 'events'/);
  assert.match(hubSource, /saveRoleProfiles\(await readBody\(req\)\)/);
  assert.match(hubSource, /saveWorkspaceContexts\(await readBody\(req\)\)/);
});

test('direct Hub jobs project deterministic canonical events without raw result text', () => {
  const running = hubCanonicalEvents({
    id: 'hub-1', role: 'worker', attempt: 0, status: 'running', phase: 'running',
    provider: 'p', model: 'm', selection_source: 'priority', startedAt: '2026-01-01T00:00:00Z',
  });
  assert.deepEqual(running.map((event) => event.type), ['job.created', 'job.started', 'model.selected', 'worker.started']);
  const done = hubCanonicalEvents({
    id: 'hub-1', role: 'worker', attempt: 0, status: 'done', phase: 'completed',
    provider: 'p', model: 'm', selection_source: 'priority', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z',
    result: 'SECRET RAW RESULT', outcome: { task_status: 'success' },
  });
  assert.deepEqual(done.map((event) => event.type), [
    'job.created', 'job.started', 'model.selected', 'worker.started', 'worker.completed', 'job.completed',
  ]);
  assert.doesNotMatch(JSON.stringify(done), /SECRET RAW RESULT/);
});
