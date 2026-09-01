import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProviderProbe, selectProviderProbeModel, hubCanonicalEvents, hasAvailableProviderLifecycleEvidence, hasCompleteProviderCatalogEvidence, hasCompleteProviderDeclarationEvidence, hasProviderRuntimeRestartEvidence, isLoopbackRequest, WorkerRegistry, readProviderRecoveryTransactions } from '../src/hub/index.mjs';
import { HUB_CAPABILITIES } from '../src/runtime-identity.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hubSource = readFileSync(new URL('../src/hub/index.mjs', import.meta.url), 'utf8');

test('Hub advertises the extension, profile, context, evidence and event surfaces', () => {
  for (const capability of ['canonical-events', 'evidence', 'profiles', 'workspace-context', 'extension-contract', 'provider-inventory', 'provider-lifecycle-v1', 'provider-health-v1', 'provider-probe-stream-v1', 'credential-reference-inventory-v1', 'credential-purge-v1', 'runtime-provenance-v1']) {
    assert.ok(HUB_CAPABILITIES.includes(capability), capability);
  }
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/extension`/);
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/profiles`/);
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/workspaces`/);
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/providers`/);
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/credential-references`/);
  assert.match(hubSource, /purge-plan/);
  assert.match(hubSource, /path: `\$\{ROUTE_BASE\}\/provider-health`/);
  assert.match(hubSource, /createProviderHealthStore/);
  const providerPreviewStart = hubSource.indexOf("path: `${ROUTE_BASE}/provider`,");
  const providerPreview = providerPreviewStart >= 0 ? hubSource.slice(providerPreviewStart, providerPreviewStart + 2_400) : '';
  assert.match(providerPreview, /healthGate/);
  assert.match(providerPreview, /tombstones: lifecycleState\.tombstones/);
  assert.match(hubSource, /delete-plan/);
  assert.match(hubSource, /createProviderDeleteFileHooks/);
  assert.match(hubSource, /readProviderSettingsDeclarations/);
  assert.match(hubSource, /settingsFile:/);
  assert.match(hubSource, /readProviderSourceRevisions/);
  assert.match(hubSource, /catalogAbsent/);
  assert.match(hubSource, /catalog_evidence/);
  assert.match(hubSource, /default_evidence/);
  assert.match(hubSource, /PROVIDER_DEFAULT_AUTHORITY_MISMATCH/);
  assert.match(hubSource, /catalogPresent/);
  assert.match(hubSource, /runtime_id_before/);
  assert.match(hubSource, /delete_runtime_id_before_restart/);
  assert.match(hubSource, /rollback_runtime_id_before_restart/);
  assert.match(hubSource, /setRuntimeBaseline/);
  assert.match(hubSource, /runtimeRestarted/);
  assert.match(hubSource, /PROVIDER_CATALOG_INCOMPLETE/);
  assert.match(hubSource, /readHarnessDefault/);
  assert.match(hubSource, /lifecycle_evidence/);
  assert.match(hubSource, /PROVIDER_LIFECYCLE_UNAVAILABLE/);
  assert.match(hubSource, /recovery_transactions/);
  assert.match(hubSource, /readProviderRecoveryTransactions/);
  assert.match(hubSource, /createCredentialPurgeFileHooks/);
  assert.match(hubSource, /recordCredentialPurgeOutcome/);
  assert.match(hubSource, /unverified_purges/);
  assert.match(hubSource, /lifecycle_transactions/);
  assert.match(hubSource, /req\.method === 'DELETE' && parts\.length === 1/);
  assert.match(hubSource, /PROVIDER_DELETE_RESTART_SUPERVISOR_UNAVAILABLE/);
  assert.match(hubSource, /const refreshed = planProviderDelete/);
  assert.match(hubSource, /restart_required: true/);
  assert.match(hubSource, /const code = boundedMachineCodeFromError\(err\)/);
  assert.match(hubSource, /parts\.length === 2 && parts\[1\] === 'probe'/);
  assert.match(hubSource, /providerProbe/);
  assert.match(hubSource, /createProviderProbe/);
  assert.match(hubSource, /parts\.length === 2 && parts\[1\] === 'rollback'/);
  assert.match(hubSource, /parts\.length === 2 && parts\[1\] === 'verify-delete'/);
  assert.match(hubSource, /parts\.length === 2 && parts\[1\] === 'verify-rollback'/);
  assert.match(hubSource, /deferRestart: true/);
  assert.match(hubSource, /existingBackupId/);
  assert.match(hubSource, /planProviderDelete/);
  assert.match(hubSource, /buildProviderInventory/);
  assert.match(hubSource, /buildCredentialReferenceInventory/);
  assert.match(hubSource, /executeCredentialPurge/);
  assert.match(hubSource, /parts\.length === 2 && parts\[1\] === 'events'/);
  assert.match(hubSource, /saveRoleProfiles\(await readBody\(req\)\)/);
  assert.match(hubSource, /saveWorkspaceContexts\(await readBody\(req\)\)/);
  assert.match(hubSource, /buildHubExecutionRows\(liveJobs\)/);
  assert.doesNotMatch(hubSource, /const \[modelExecution, reviewerExecution\] = buildHubExecutionRows\(liveJobs\)/);
  assert.match(hubSource, /const executionRows = buildHubExecutionRows\(liveJobs\)/);
  assert.match(hubSource, /\.\.\.executionRows/);
  assert.match(hubSource, /buildRuntimeReadinessSnapshot/);
  assert.match(hubSource, /ingress/);
});

test('Hub mutation surface rejects cross-site browser requests', () => {
  const request = (headers) => ({ socket: { remoteAddress: '127.0.0.1' }, headers });
  assert.equal(isLoopbackRequest(request({ host: '127.0.0.1:3210' })), true);
  assert.equal(isLoopbackRequest(request({ host: '127.0.0.1:3210', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' }, headers: { host: '[::1]:3210', origin: 'http://[::1]:3080', 'sec-fetch-site': 'same-origin' } }), true);
  assert.equal(isLoopbackRequest(request({ host: '127.0.0.1:3210', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })), false);
});

test('destructive provider lifecycle requires complete catalog evidence', () => {
  assert.equal(hasCompleteProviderCatalogEvidence({ ok: true, partial: false }), true);
  assert.equal(hasCompleteProviderCatalogEvidence({ ok: true, partial: true }), false);
  assert.equal(hasCompleteProviderCatalogEvidence({ ok: false, partial: false }), false);
});

test('provider lifecycle accepts only a changed 3210 runtime identity as restart evidence', () => {
  assert.equal(hasProviderRuntimeRestartEvidence('before', 'after'), true);
  assert.equal(hasProviderRuntimeRestartEvidence('same', 'same'), false);
  assert.equal(hasProviderRuntimeRestartEvidence(null, 'after'), false);
});

test('provider lifecycle fails closed when any existing declaration source is malformed', () => {
  assert.equal(hasCompleteProviderDeclarationEvidence({ ok: true, sources: { profile: { present: true }, settings: { present: false } } }), true);
  assert.equal(hasCompleteProviderDeclarationEvidence({ ok: false, sources: { settings: { present: true, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' } } }), false);
});

test('provider lifecycle does not treat corrupted lifecycle state as available evidence', () => {
  assert.equal(hasAvailableProviderLifecycleEvidence({ ok: true }), true);
  assert.equal(hasAvailableProviderLifecycleEvidence({ ok: false, code: 'PROVIDER_LIFECYCLE_UNAVAILABLE' }), false);
});

test('provider recovery keeps manifests without phase timestamps visible using file mtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-recovery-'));
  const id = '11111111-1111-4111-8111-111111111111';
  const entry = join(root, id);
  mkdirSync(entry);
  writeFileSync(join(entry, 'manifest.json'), JSON.stringify({
    schema_version: 1,
    provider_id: 'opencode-go',
    plan: { plan_id: id, provider_id: 'opencode-go' },
    files: { profile: { existed: true, managed: true }, config: { existed: true, managed: true }, lifecycle: { existed: true, managed: true } },
    phase_journal: { phase: 'DECLARATIONS_APPLYING' },
  }) + '\n');
  const transactions = readProviderRecoveryTransactions(root);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].provider_id, 'opencode-go');
  assert.equal(transactions[0].phase, 'DECLARATIONS_APPLYING');
  assert.equal(typeof transactions[0].updated_at, 'string');
});

test('provider probe adapter performs one bounded 3210 Harness stream and classifies terminal errors', async () => {
  const calls = [];
  const probe = createProviderProbe({
    llm: {
      stream(options) {
        calls.push(options);
        return (async function* stream() {
          yield { type: 'finish', reason: { kind: 'stop' } };
        }());
      },
    },
  });
  assert.equal(typeof probe, 'function');
  assert.deepEqual(await probe({ provider: 'opencode-muse', model: 'mimo-v2.5', signal: new AbortController().signal }), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'opencode-muse');
  assert.equal(calls[0].model, 'mimo-v2.5');
  assert.equal(calls[0].maxTokens, 1);
  assert.equal(calls[0].messages.length, 1);
  assert.equal(calls[0].messages[0].content[0].text, 'dsh-crew provider probe');

  const failed = createProviderProbe({
    llm: { stream: () => (async function* stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXHAUSTED' } } }; }()) },
  });
  const observed = await failed({ provider: 'p', model: 'm', signal: new AbortController().signal });
  assert.equal(observed.ok, false);
  assert.equal(observed.error.code, 'QUOTA_EXHAUSTED');
});

test('provider probe follows the configured priority for the selected provider', () => {
  const model = selectProviderProbeModel({
    providerId: 'opencode-muse',
    record: { models: ['deepseek-v4-flash', 'mimo-v2.5'] },
    config: {
      worker: { model_policy: { priority: [{ provider: 'opencode-muse', model: 'mimo-v2.5' }] } },
      flash_model_priority: [{ provider: 'opencode-muse', model: 'deepseek-v4-flash' }],
    },
  });
  assert.equal(model, 'mimo-v2.5');
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

test('Hub job views expose 3210 execution provenance when present', () => {
  const hub = new WorkerRegistry({});
  const view = hub.view({
    id: 'hub-provenance', sessionId: 'session-1', role: 'worker', tier: 'flash', provider: 'p', model: 'm',
    status: 'done', source: 'test', task: 'x', effort: 'max', startedAt: 't0', endedAt: 't1',
    execution_context: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' },
  });
  assert.deepEqual(view.execution_context, { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' });
});

test('direct Hub jobs project deterministic canonical events without raw result text', () => {
  const running = hubCanonicalEvents({
    id: 'hub-1', role: 'worker', attempt: 0, status: 'running', phase: 'running',
    provider: 'p', model: 'm', selection_source: 'priority', startedAt: '2026-01-01T00:00:00Z',
  });
  assert.deepEqual(running.map((event) => event.type), ['job.created', 'job.started', 'runtime.bound', 'model.selected', 'model.admitted', 'worker.started', 'agent.created']);
  const done = hubCanonicalEvents({
    id: 'hub-1', role: 'worker', attempt: 0, status: 'done', phase: 'completed',
    provider: 'p', model: 'm', selection_source: 'priority', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z',
    result: 'SECRET RAW RESULT', outcome: { task_status: 'success' },
  });
  assert.deepEqual(done.map((event) => event.type), [
    'job.created', 'job.started', 'runtime.bound', 'model.selected', 'model.admitted', 'worker.started', 'agent.created', 'worker.completed', 'job.completed',
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
