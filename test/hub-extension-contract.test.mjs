import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hubCanonicalEvents, isLoopbackRequest, WorkerRegistry } from '../src/hub/index.mjs';
import { HUB_CAPABILITIES } from '../src/runtime-identity.mjs';

const hubSource = readFileSync(new URL('../src/hub/index.mjs', import.meta.url), 'utf8');

test('Hub advertises the extension, profile, context, evidence and event surfaces', () => {
  for (const capability of ['canonical-events', 'evidence', 'profiles', 'workspace-context', 'extension-contract']) {
    assert.ok(HUB_CAPABILITIES.includes(capability), capability);
  }
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/extension`/);
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/profiles`/);
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/workspaces`/);
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/providers`/);
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/provider-health`/);
  assert.match(hubSource, /createProviderHealthStore/);
  const providerPreviewStart = hubSource.indexOf("path: `${ROUTE_BASE}/provider`,");
  const providerPreview = providerPreviewStart >= 0 ? hubSource.slice(providerPreviewStart, providerPreviewStart + 2_400) : '';
  assert.match(providerPreview, /healthGate/);
  assert.match(providerPreview, /tombstones: lifecycleState\.tombstones/);
  assert.match(hubSource, /delete-plan/);
  assert.match(hubSource, /createProviderDeleteFileHooks/);
  assert.match(hubSource, /req\.method === 'DELETE' && parts\.length === 1/);
  assert.match(hubSource, /PROVIDER_DELETE_RESTART_SUPERVISOR_UNAVAILABLE/);
  assert.match(hubSource, /const refreshed = planProviderDelete/);
  assert.match(hubSource, /ownsCrew3210/);
  assert.match(hubSource, /const code = boundedMachineCodeFromError\(err\)/);
  assert.match(hubSource, /parts\.length === 2 && parts\[1\] === 'probe'/);
  assert.match(hubSource, /ctx\.providerProbe/);
  assert.match(hubSource, /parts\.length === 2 && parts\[1\] === 'rollback'/);
  assert.match(hubSource, /existingBackupId/);
  assert.match(hubSource, /planProviderDelete/);
  assert.match(hubSource, /buildProviderInventory/);
  assert.match(hubSource, /parts\.length === 2 && parts\[1\] === 'events'/);
  assert.match(hubSource, /saveRoleProfiles\(await readBody\(req\)\)/);
  assert.match(hubSource, /saveWorkspaceContexts\(await readBody\(req\)\)/);
  assert.match(hubSource, /buildHubExecutionRows\(liveJobs\)/);
});

test('Hub mutation surface rejects cross-site browser requests', () => {
  const request = (headers) => ({ socket: { remoteAddress: '127.0.0.1' }, headers });
  assert.equal(isLoopbackRequest(request({ host: '127.0.0.1:3210' })), true);
  assert.equal(isLoopbackRequest(request({ host: '127.0.0.1:3210', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' }, headers: { host: '[::1]:3210', origin: 'http://[::1]:3080', 'sec-fetch-site': 'same-origin' } }), true);
  assert.equal(isLoopbackRequest(request({ host: '127.0.0.1:3210', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })), false);
});

test('Hub registry lists completed jobs for live extension readiness evidence', () => {
  const hub = new WorkerRegistry({});
  hub.jobs.set('worker-1', {
    id: 'worker-1', role: 'worker', status: 'done', phase: 'completed', task: 'worker task',
    delivery_complete: true, outcome: { task_status: 'success', workspace_evidence_ok: true },
  });
  hub.jobs.set('reviewer-1', {
    id: 'reviewer-1', role: 'reviewer', status: 'done', phase: 'completed', task: 'review task',
    delivery_complete: true, outcome: { task_status: 'success', workspace_evidence_ok: true }, review: { verdict: 'approve' },
  });

  assert.deepEqual(
    hub.list().map(({ id, role, status }) => ({ id, role, status })),
    [
      { id: 'worker-1', role: 'worker', status: 'done' },
      { id: 'reviewer-1', role: 'reviewer', status: 'done' },
    ],
  );
  assert.deepEqual(
    hub.list().map(({ task_status, workspace_evidence_ok, review_verdict }) => ({ task_status, workspace_evidence_ok, review_verdict })),
    [
      { task_status: 'success', workspace_evidence_ok: true, review_verdict: null },
      { task_status: 'success', workspace_evidence_ok: true, review_verdict: 'approve' },
    ],
  );
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

test('direct Reviewer completion carries its normalized verdict in canonical evidence', () => {
  const events = hubCanonicalEvents({
    id: 'hub-r', role: 'reviewer', status: 'done', phase: 'completed', startedAt: 1, endedAt: 2,
    review: { verdict: 'approve' },
  });
  assert.equal(events.find((event) => event.type === 'review.completed').data.verdict, 'approve');
});
