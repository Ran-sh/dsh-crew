import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRegistry } from '../src/hub/index.mjs';
import { jobView } from '../src/jobs.mjs';
import { attemptFromView } from '../src/mcp-runtime.mjs';
import { buildDirectSelectionTrace } from '../src/model-routing.mjs';
import { createWorkflowRuntime } from '../src/workflow-runtime.mjs';

function modelPolicy(role, { escalation = false } = {}) {
  return {
    role,
    strategy: role === 'reviewer' ? 'strong' : 'balanced',
    priority: [],
    priorityConfigured: true,
    escalation_priority: [],
    escalation_priority_configured: true,
    fallback: 'harness-default',
    escalation: { enabled: escalation, max_attempts: 2 },
  };
}

function config() {
  return {
    subagents_enabled: true,
    main_agent_mode: 'coordinator-first',
    execution: { enabled: true, default_effort: 'max', default_timeout_seconds: 60, mode: 'auto', max_parallel: 3, isolation: 'shared' },
    worker: { state: 'auto', provider_mode: 'deepseek-official', model_policy: modelPolicy('worker', { escalation: true }) },
    review: { state: 'disabled', mode: 'auto', auto_review: false, provider_mode: 'deepseek-official', model_policy: modelPolicy('reviewer') },
  };
}

function surfaceJob(trace) {
  return {
    id: 'job-1', sessionId: 'session-1', role: 'worker', attempt: 0, phase: 'running', tier: 'flash',
    provider: 'p', model: 'm', selection_source: 'priority', selection_trace: trace,
    effort: 'max', reasoning_effort: 'max', status: 'running', source: 'api', task: 'task', cwd: '/tmp',
    turn: 0, step: 0, currentTool: null, toolCalls: 0, tokens: { input: 0, output: 0, reasoning: 0 },
    startedAt: 'now', endedAt: null, delivery_complete: false, workspaceDiff: null,
  };
}

test('Hub and standalone job views expose the same structured selection trace field', () => {
  const trace = buildDirectSelectionTrace({
    role: 'worker', logicalAttempt: 0, modelClassHint: 'flash', strategy: 'test',
    provider: 'p', model: 'm', source: 'priority',
  });
  const raw = surfaceJob(trace);
  const hubView = new WorkerRegistry({}).view(raw);
  const standaloneView = jobView(raw);
  assert.deepEqual(hubView.selection_trace, trace);
  assert.deepEqual(standaloneView.selection_trace, trace);
  assert.equal(hubView.selection_source, 'priority');
  assert.equal(standaloneView.selection_source, 'priority');
});

test('MCP normalization enriches transport trace with logical workflow context', () => {
  const view = {
    id: 'hub-1', role: 'worker', attempt: 1,
    provider: 'p', model: 'm', selection_source: 'priority', status: 'done', result: 'ok',
    selection_trace: buildDirectSelectionTrace({
      role: 'worker', logicalAttempt: 1, strategy: 'balanced', candidateSet: 'escalation',
      provider: 'p', model: 'm', source: 'priority',
    }),
  };
  const normalized = attemptFromView(view, {
    id: 'wf-a1', role: 'worker', attempt: 1, model_class_hint: 'pro', escalation_reason: 'tests_failed',
  });
  assert.equal(normalized.attempt, 1);
  assert.equal(normalized.selection_trace.logical_attempt, 1);
  assert.equal(normalized.selection_trace.model_class_hint, 'pro');
  assert.equal(normalized.selection_trace.escalation_reason, 'tests_failed');
  assert.deepEqual(normalized.selection_trace.selected, { provider: 'p', model: 'm', source: 'priority' });
});

test('workflow passes the exact escalation reason into the next attempt and result metadata', async () => {
  const specs = [];
  const runtime = createWorkflowRuntime({
    getConfig: () => config(),
    allocateWorkspace: async (job) => ({ ok: true, execution_cwd: job.requested_cwd, isolation: 'shared', handle: null }),
    releaseWorkspace: async () => ({ ok: true }),
    buildReviewTask: () => 'review',
    executeAttempt: async (spec) => {
      specs.push(spec);
      const first = spec.attempt === 0;
      return {
        id: spec.id,
        role: spec.role,
        provider: first ? 'cheap' : 'strong',
        model: first ? 'm1' : 'm2',
        selection_source: 'priority',
        selection_trace: buildDirectSelectionTrace({
          role: spec.role,
          logicalAttempt: spec.attempt,
          modelClassHint: spec.model_class_hint,
          strategy: 'balanced',
          candidateSet: first ? 'primary' : 'escalation',
          provider: first ? 'cheap' : 'strong',
          model: first ? 'm1' : 'm2',
          source: 'priority',
          escalationReason: spec.escalation_reason,
        }),
        status: 'done',
        result: first ? '## Diff\n- x\n## Tests\nFAIL — test — failed\n## Risks\n- x' : '## Diff\n- x\n## Tests\nPASS — test — ok\n## Risks\n- none',
        outcome: first
          ? { execution_status: 'completed', task_status: 'partial', tests_status: 'FAIL', delivery: { complete: true }, changes: [] }
          : { execution_status: 'completed', task_status: 'success', tests_status: 'PASS', delivery: { complete: true }, changes: [] },
      };
    },
  });

  const started = runtime.start({ task: 'do it', cwd: '/tmp', role: 'worker', model_class_hint: 'flash' });
  await runtime.wait(started.id, 1000);
  const result = runtime.get(started.id, { withResult: true });

  assert.equal(specs.length, 2);
  assert.equal(specs[0].escalation_reason, null);
  assert.equal(specs[1].escalation_reason, 'tests_failed');
  assert.equal(result.status, 'done');
  assert.equal(result.child_attempts.length, 2);
  assert.equal(result.child_attempts[1].selection_trace.escalation_reason, 'tests_failed');
  assert.equal(result.child_attempts[1].selection_trace.logical_attempt, 1);
});
