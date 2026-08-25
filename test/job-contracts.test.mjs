import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  JOB_EVENT_TYPES,
  buildEvidenceEnvelope,
  createCanonicalJobEvent,
  projectWorkflowView,
} from '../src/job-contracts.mjs';

const fullView = {
  id: 'wf-1',
  client_job_id: 'client-42',
  role: 'worker',
  phase: 'completed',
  status: 'done',
  attempt: 1,
  current_model: 'deepseek-v4',
  base_revision: 'abc123',
  error: null,
  error_code: null,
  failure: { schema_version: 1, category: 'none', reason_code: 'NONE' },
  workspace_retained: false,
  child_attempts: [{
    id: 'hub-1',
    role: 'worker',
    provider: 'deepseek',
    model: 'deepseek-v4',
    selection_trace: { selected: { provider: 'deepseek', model: 'deepseek-v4', source: 'priority' } },
    status: 'done',
    tokens: { input: 10, output: 5, reasoning: 2 },
  }],
  outcome: {
    execution_status: 'completed',
    task_status: 'success',
    tests_status: 'PASS',
    changes: ['src/a.mjs — changed'],
    tests: [{ status: 'PASS', command: 'node --test', summary: 'ok' }],
    risks: ['none'],
    unverified: [],
    delivery: { complete: true, missing: [], format: 'coding' },
  },
  candidate: {
    changed_files: ['src/a.mjs'],
    patch: 'SECRET_FULL_PATCH_MUST_NOT_LEAK',
    fingerprint: 'fp-1',
    base_revision: 'abc123',
  },
  review: {
    verdict: 'approve',
    findings: ['looks good'],
    evidence: ['inspected src/a.mjs'],
    risks: ['none'],
    status: 'done',
  },
  events: [{ type: 'attempt/complete', message: 'legacy raw event' }],
  canonical_events: [{
    schema_version: 1,
    event_id: 'wf-1:1',
    job_id: 'wf-1',
    sequence: 1,
    type: 'job.completed',
    at: 100,
    role: 'worker',
    attempt: 0,
    data: {},
  }],
  profile_id: 'worker-default',
  workspace_context: { workspace_id: 'demo', repo_root: '/repo' },
};

test('canonical job events use the versioned allow-list and stable envelope', () => {
  assert.ok(JOB_EVENT_TYPES.includes('job.created'));
  assert.ok(JOB_EVENT_TYPES.includes('model.fallback'));
  assert.ok(JOB_EVENT_TYPES.includes('review.completed'));

  const event = createCanonicalJobEvent({
    jobId: 'wf-1', type: 'worker.started', sequence: 2, at: 123,
    role: 'worker', attempt: 0, data: { attempt_id: 'hub-1' },
  });
  assert.deepEqual(event, {
    schema_version: 1,
    event_id: 'wf-1:2',
    job_id: 'wf-1',
    sequence: 2,
    type: 'worker.started',
    at: 123,
    role: 'worker',
    attempt: 0,
    data: { attempt_id: 'hub-1' },
  });
  assert.throws(() => createCanonicalJobEvent({
    jobId: 'wf-1', type: 'debug.dump', sequence: 3, at: 124,
  }), /unknown canonical job event/);
});

test('evidence envelope is machine-first and excludes raw result and patch text', () => {
  const evidence = buildEvidenceEnvelope(fullView);
  assert.equal(evidence.schema_version, 1);
  assert.equal(evidence.job_id, 'wf-1');
  assert.equal(evidence.client_job_id, 'client-42');
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.summary.task_status, 'success');
  assert.deepEqual(evidence.changed_files, ['src/a.mjs']);
  assert.equal(evidence.tests[0].status, 'PASS');
  assert.equal(evidence.review.verdict, 'approve');
  assert.equal(evidence.artifacts.candidate_fingerprint, 'fp-1');
  assert.equal(evidence.selection_trace[0].selected_model, 'deepseek-v4');
  assert.deepEqual(evidence.selection_trace[0].candidates, [{ model: 'deepseek-v4', provider: 'deepseek', status: 'SELECTED' }]);
  assert.deepEqual(evidence.selection_trace[0].fallback_chain, []);
  assert.equal(evidence.selection_trace[0].decision_reason, 'priority');
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /SECRET_FULL_PATCH_MUST_NOT_LEAK/);
  assert.equal('patch' in evidence, false);
  assert.equal('result' in evidence, false);
});

test('compact projection is the safe default while full detail stays available explicitly', () => {
  const compact = projectWorkflowView(fullView);
  assert.equal(compact.detail, 'compact');
  assert.equal(compact.evidence.status, 'PASS');
  assert.deepEqual(compact.canonical_events, fullView.canonical_events);
  assert.equal('candidate' in compact, false);
  assert.equal('outcome' in compact, false);
  assert.equal('review' in compact, false);
  assert.equal('events' in compact, false);
  assert.equal('child_attempts' in compact, false);
  assert.doesNotMatch(JSON.stringify(compact), /SECRET_FULL_PATCH_MUST_NOT_LEAK/);

  const full = projectWorkflowView(fullView, { detail: 'full' });
  assert.equal(full.detail, 'full');
  assert.equal(full.candidate.patch, 'SECRET_FULL_PATCH_MUST_NOT_LEAK');
});

test('incremental watch projection returns only canonical events after the cursor', () => {
  const view = {
    ...fullView,
    canonical_events: [1, 2, 3].map((sequence) => ({
      schema_version: 1, event_id: `wf-1:${sequence}`, job_id: 'wf-1', sequence,
      type: sequence === 1 ? 'job.created' : sequence === 2 ? 'job.started' : 'job.completed',
      at: sequence, role: 'worker', attempt: 0, data: {},
    })),
  };
  const compact = projectWorkflowView(view, { afterSequence: 1 });
  assert.deepEqual(compact.canonical_events.map((event) => event.sequence), [2, 3]);
  assert.equal(compact.event_cursor, 3);
  assert.equal(compact.events_truncated_before_cursor, false);
});

test('legacy Hub results are compacted from workspace_diff without leaking result or patch', () => {
  const compact = projectWorkflowView({
    id: 'hub-1', role: 'worker', phase: 'completed', status: 'done',
    result: 'SECRET_RAW_ASSISTANT_TEXT',
    outcome: { execution_status: 'completed', task_status: 'success', tests_status: 'PASS', tests: [], delivery: { complete: true } },
    workspace_diff: {
      kind: 'git',
      patch: 'SECRET_LEGACY_PATCH',
      changes: { modified: ['src/a.mjs'], deleted: ['src/old.mjs'], renamed: [], untracked: ['src/new.mjs'] },
    },
  });
  assert.deepEqual(compact.evidence.changed_files, ['src/a.mjs', 'src/old.mjs', 'src/new.mjs']);
  assert.equal('result' in compact, false);
  assert.equal('workspace_diff' in compact, false);
  assert.doesNotMatch(JSON.stringify(compact), /SECRET_RAW_ASSISTANT_TEXT|SECRET_LEGACY_PATCH/);
});
