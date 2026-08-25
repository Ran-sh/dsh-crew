import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createWorkflowRuntime, normalizeReview } from '../src/workflow-runtime.mjs';
import { JOB_PHASES, canTransition } from '../src/workflow.mjs';
import { buildEffectiveRuntimeConfig, resolveAttemptTier, hubPollWaitSeconds } from '../src/mcp-runtime.mjs';

test('Hub polling uses short transport-safe waits for long-running agents', () => {
  assert.equal(hubPollWaitSeconds(1_800_000), 20);
  assert.equal(hubPollWaitSeconds(20_001), 20);
  assert.equal(hubPollWaitSeconds(1_001), 2);
  assert.equal(hubPollWaitSeconds(1), 1);
});
import { captureCandidate, inspectRepository } from '../src/workspace-isolation.mjs';

const GOOD = `Done.
## Diff
- src/a.mjs — change
## Tests
PASS — node --test — passed
## Risks
none`;

const FAILING = `Done.
## Diff
- src/a.mjs — change
## Tests
FAIL — node --test — failed
## Risks
none`;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function makeRuntimeAdapter(overrides = {}) {
  return {
    executeAttempt: async (spec) => ({
      id: `actual-${spec.attempt}`,
      role: spec.role,
      attempt: spec.attempt,
      status: 'done',
      result: GOOD,
      stopReason: 'completed',
      provider: 'p',
      model: spec.attempt > 0 ? 'strong' : 'cheap',
      selection_source: 'test',
    }),
    cancelAttempt: async () => {},
    allocateWorkspace: async (job) => ({
      ok: true,
      execution_cwd: job.requested_cwd,
      base_revision: 'base',
      isolation: 'worktree',
      primary_workspace_dirty: false,
      handle: { id: 'wt' },
    }),
    captureCandidate: async () => ({
      ok: true,
      changed_files: ['src/a.mjs'],
      patch: 'diff',
      fingerprint: 'fp',
      complete: true,
      replayable: true,
    }),
    releaseWorkspace: async () => ({ ok: true }),
    buildReviewTask: (task) => `review ${task}`,
    getConfig: () => ({ collaboration_mode: 'flash-only', escalate_on_failure: false }),
    ...overrides,
  };
}

function ids() {
  let i = 0;
  return () => `wf-hardening-${++i}`;
}

test('terminal workflow phases never transition to another phase', () => {
  assert.equal(canTransition(JOB_PHASES.COMPLETED, JOB_PHASES.CANCELLED), false);
  assert.equal(canTransition(JOB_PHASES.FAILED, JOB_PHASES.COMPLETED), false);
  assert.equal(canTransition(JOB_PHASES.CANCELLED, JOB_PHASES.FAILED), false);
  assert.equal(canTransition(JOB_PHASES.RUNNING, JOB_PHASES.FAILED), true);
});

test('attempt tier preserves explicit strong hint and upgrades escalated attempts', () => {
  assert.equal(resolveAttemptTier({ role: 'worker', attempt: 0, modelClassHint: 'flash' }), 'flash');
  assert.equal(resolveAttemptTier({ role: 'worker', attempt: 0, modelClassHint: 'pro' }), 'pro');
  assert.equal(resolveAttemptTier({ role: 'worker', attempt: 1, modelClassHint: 'flash' }), 'pro');
  assert.equal(resolveAttemptTier({ role: 'reviewer', attempt: 0, modelClassHint: 'flash' }), 'pro');
});

test('session overrides feed the canonical workflow model/review policy', () => {
  const effective = buildEffectiveRuntimeConfig(
    { collaboration_mode: 'flash-only', escalate_on_failure: false, pro_reviews_flash: false },
    { collaboration_mode: 'review-pipeline', escalate_on_failure: true, pro_reviews_flash: true },
  );
  assert.equal(effective.worker.model_policy.escalation.enabled, true);
  assert.equal(effective.review.state, 'auto');
  assert.equal(effective.review.auto_review, true);
});

test('escalation refreshes candidate after every worker attempt', async () => {
  let lastAttempt = -1;
  let captures = 0;
  const adapter = makeRuntimeAdapter({
    getConfig: () => ({ collaboration_mode: 'balanced', escalate_on_failure: true }),
    executeAttempt: async (spec) => {
      lastAttempt = spec.attempt;
      return {
        id: `worker-${spec.attempt}`,
        role: 'worker',
        attempt: spec.attempt,
        status: 'done',
        result: spec.attempt === 0 ? FAILING : GOOD,
        stopReason: 'completed',
        provider: 'p',
        model: spec.attempt === 0 ? 'cheap' : 'strong',
        selection_source: 'test',
      };
    },
    captureCandidate: async () => {
      captures += 1;
      return {
        ok: true,
        changed_files: [`attempt-${lastAttempt}.mjs`],
        patch: `patch-${lastAttempt}`,
        fingerprint: `fp-${lastAttempt}`,
        complete: true,
        replayable: true,
      };
    },
  });
  const rt = createWorkflowRuntime(adapter, { maxParallel: 1, idFactory: ids() });
  const job = rt.start({ role: 'worker', model_class_hint: 'flash', task: 'fix', cwd: '/repo' });
  await rt.wait(job.id, 2000);
  const view = rt.get(job.id, { withResult: true });
  assert.equal(view.status, 'done');
  assert.equal(view.attempt, 2);
  assert.equal(captures, 2);
  assert.equal(view.candidate.fingerprint, 'fp-1');
  assert.equal(view.child_attempts[0].candidate_fingerprint, 'fp-0');
  assert.equal(view.child_attempts[1].candidate_fingerprint, 'fp-1');
});

test('latest candidate capture failure never exposes a stale earlier candidate', async () => {
  let lastAttempt = -1;
  let released = 0;
  const adapter = makeRuntimeAdapter({
    getConfig: () => ({ collaboration_mode: 'balanced', escalate_on_failure: true }),
    executeAttempt: async (spec) => {
      lastAttempt = spec.attempt;
      return {
        id: `worker-${spec.attempt}`,
        role: 'worker',
        attempt: spec.attempt,
        status: 'done',
        result: spec.attempt === 0 ? FAILING : GOOD,
        stopReason: 'completed',
        provider: 'p',
        model: spec.attempt === 0 ? 'cheap' : 'strong',
        selection_source: 'test',
      };
    },
    captureCandidate: async () => lastAttempt === 0 ? {
      ok: true,
      changed_files: ['attempt-0.mjs'],
      patch: 'patch-0',
      fingerprint: 'fp-0',
      complete: true,
      replayable: true,
    } : { ok: false, reason: 'capture failed' },
    releaseWorkspace: async () => { released += 1; return { ok: true }; },
  });
  const rt = createWorkflowRuntime(adapter, { maxParallel: 1, idFactory: ids() });
  const job = rt.start({ role: 'worker', model_class_hint: 'flash', task: 'fix then lose capture', cwd: '/repo' });
  await rt.wait(job.id, 2000);
  const view = rt.get(job.id, { withResult: true });
  assert.equal(view.status, 'done');
  assert.equal(view.attempt, 2);
  assert.equal(view.candidate_capture_failed, true);
  assert.equal(view.candidate_available, false);
  assert.equal(view.candidate, null);
  assert.equal(view.workspace_retained, true);
  assert.equal(released, 0);
  assert.equal(view.child_attempts[0].candidate_fingerprint, 'fp-0');
  assert.equal(view.child_attempts[1].candidate_fingerprint, null);
});

test('workflow cancellation targets the real adapter attempt id', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cancelled = [];
  const adapter = makeRuntimeAdapter({
    executeAttempt: async (spec) => {
      spec.onAttemptStarted?.('hub-real-123');
      await gate;
      return { id: 'hub-real-123', role: 'worker', attempt: 0, status: 'done', result: GOOD, stopReason: 'completed' };
    },
    cancelAttempt: async (id) => { cancelled.push(id); },
  });
  const rt = createWorkflowRuntime(adapter, { maxParallel: 1, idFactory: ids() });
  const job = rt.start({ role: 'worker', task: 'long', cwd: '/repo' });
  await sleep(20);
  const cancelledView = await rt.cancel(job.id);
  assert.equal(cancelledView.status, 'cancelled');
  assert.deepEqual(cancelled, ['hub-real-123']);
  release();
  await sleep(20);
  assert.equal(rt.get(job.id).status, 'cancelled');
});

test('failure releases exactly one concurrency slot', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  const adapter = makeRuntimeAdapter({
    executeAttempt: async (spec) => {
      calls += 1;
      if (spec.task === 'A') {
        return { id: 'infra-A', role: 'worker', attempt: 0, status: 'failed', result: '', error: 'infra', infra: true };
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return { id: `ok-${spec.task}`, role: 'worker', attempt: 0, status: 'done', result: GOOD, stopReason: 'completed' };
    },
  });
  const rt = createWorkflowRuntime(adapter, { maxParallel: 1, idFactory: ids() });
  const A = rt.start({ role: 'worker', task: 'A', cwd: '/repo' });
  const B = rt.start({ role: 'worker', task: 'B', cwd: '/repo' });
  const C = rt.start({ role: 'worker', task: 'C', cwd: '/repo' });
  await sleep(50);
  assert.equal(rt.get(A.id).status, 'failed');
  assert.equal(maxInFlight, 1, 'double release must not start B and C together');
  assert.equal(rt.get(C.id).phase, JOB_PHASES.QUEUED);
  release();
  await rt.wait(B.id, 2000);
  await rt.wait(C.id, 2000);
  assert.equal(calls, 3);
  assert.equal(rt.get(C.id).status, 'done');
});

test('reviewer mutation invalidates an approval', () => {
  const review = normalizeReview({
    attemptResult: {
      status: 'done',
      result: '## Review Findings\nlooks good\n## Evidence\nchecked\n## Risks\nnone\n## Verdict\napproved',
    },
    beforeCandidate: { fingerprint: 'before' },
    afterCandidate: { fingerprint: 'after' },
  });
  assert.equal(review.reported_verdict, 'approve');
  assert.equal(review.verdict, 'request_changes');
  assert.equal(review.mutated_candidate, true);
  assert.equal(review.invalidated, true);
});

test('incomplete candidate retains isolated worktree', async () => {
  let released = 0;
  const adapter = makeRuntimeAdapter({
    captureCandidate: async () => ({
      ok: true,
      changed_files: ['large.bin'],
      patch: '[NEW BINARY FILE]',
      fingerprint: 'binary-fp',
      complete: false,
      replayable: false,
      incomplete_reasons: ['binary_untracked:large.bin'],
    }),
    releaseWorkspace: async () => { released += 1; return { ok: true }; },
  });
  const rt = createWorkflowRuntime(adapter, { maxParallel: 1, idFactory: ids() });
  const job = rt.start({ role: 'worker', task: 'binary', cwd: '/repo' });
  await rt.wait(job.id, 2000);
  const view = rt.get(job.id, { withResult: true });
  assert.equal(view.status, 'done');
  assert.equal(view.workspace_retained, true);
  assert.equal(released, 0);
});

function haveGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-crew-hardening-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'hardening@test'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'hardening'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  return repo;
}

const gitTest = haveGit() ? test : test.skip;

gitTest('inspectRepository reports primary workspace dirtiness', async (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  assert.equal((await inspectRepository({ cwd: repo })).dirty, false);
  writeFileSync(join(repo, 'user-change.txt'), 'dirty\n');
  assert.equal((await inspectRepository({ cwd: repo })).dirty, true);
});

gitTest('binary or truncated candidate is marked non-replayable', async (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'asset.bin'), Buffer.from([0, 1, 2, 3, 4]));
  const binary = await captureCandidate({ worktreePath: repo, baseRevision: base });
  assert.equal(binary.ok, true);
  assert.equal(binary.complete, false);
  assert.equal(binary.replayable, false);
  assert.ok(binary.incomplete_reasons.some((r) => r.startsWith('binary_untracked:')));

  rmSync(join(repo, 'asset.bin'));
  writeFileSync(join(repo, 'a.txt'), 'x'.repeat(5000));
  const truncated = await captureCandidate({ worktreePath: repo, baseRevision: base, limit: 128 });
  assert.equal(truncated.patch_truncated, true);
  assert.equal(truncated.complete, false);
  assert.ok(truncated.incomplete_reasons.includes('patch_truncated'));
});

test('server forwards effective model class to both run and spawn workflows', () => {
  const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const source = readFileSync(serverPath, 'utf8');
  const matches = source.match(/model_class_hint:\s*effTier/g) ?? [];
  assert.equal(matches.length, 2);
});
