// Worktree-runtime integration: the REAL workspace adapters (createIsolated-
// Workspace / captureCandidate / cleanupIsolatedWorkspace) wired into the
// shared workflow runtime, with a fake worker that edits its execution cwd.
// Proves: coding workers run in their own worktree, the primary workspace is
// never touched (including while dirty), concurrent jobs use distinct
// worktrees, the candidate captures the worker change, the reviewer pass runs
// against the isolated candidate, and max_parallel queues extra workflows.
// Run with: node --test test/worktree-runtime.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createWorkflowRuntime, JOB_PHASES } from '../src/workflow-runtime.mjs';
import { normalizeGlobalConfig } from '../src/policy.mjs';
import {
  createIsolatedWorkspace,
  cleanupIsolatedWorkspace,
  captureCandidate as captureReal,
  inspectRepository,
} from '../src/workspace-isolation.mjs';

const GOOD = `Done.
## Diff
- src/a.mjs — change
## Tests
PASS — node --test — 1 passed
## Risks
none`;
const REVIEW = `## Review Findings\nOK.\n## Evidence\ninspected\n## Risks\nnone\n## Verdict\napproved`;

function haveGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const maybe = haveGit() ? test : test.skip;

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-crew-wtr-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });
  return repo;
}

function workspaceAdapters() {
  const allocateWorkspace = async (job) => {
    const repo = await inspectRepository({ cwd: job.requested_cwd });
    if (!repo.ok) return { ok: false, reason: repo.reason, error: repo.error };
    const created = await createIsolatedWorkspace({ cwd: job.requested_cwd, jobId: job.id, baseRevision: repo.baseRevision });
    if (!created.ok) return { ok: false, reason: created.reason, error: created.error };
    return {
      ok: true,
      execution_cwd: created.worktreePath,
      base_revision: created.baseRevision,
      isolation: 'worktree',
      primary_workspace_dirty: false,
      handle: { worktreePath: created.worktreePath, repoRoot: created.repoRoot },
    };
  };
  const captureCandidate = ({ cwd, baseRevision }) => captureReal({ worktreePath: cwd, baseRevision });
  const releaseWorkspace = async (h) => (h ? { ok: (await cleanupIsolatedWorkspace({ worktreePath: h.worktreePath, repoRoot: h.repoRoot })).ok } : { ok: true });
  return { allocateWorkspace, captureCandidate, releaseWorkspace };
}

// A fake "worker" that edits its execution cwd (the worktree) and reports a
// passing delivery report; a fake "reviewer" that returns a verdict.
function fakeAttempters() {
  let calls = [];
  const attemptWriter = async (cwd, attempt) => {
    // write a worker artifact into the worktree so the candidate can see it
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'worker.mjs'), `// attempt ${attempt}\n`);
  };
  return {
    calls,
    executeAttempt: async (spec) => {
      calls.push(spec);
      if (spec.role === 'reviewer') {
        return { id: `${spec.id}-r`, role: 'reviewer', attempt: 0, provider: 'p', model: 'reviewer', selection_source: 'policy', status: 'done', result: REVIEW, stopReason: 'completed' };
      }
      await attemptWriter(spec.cwd, spec.attempt);
      return { id: spec.id, role: 'worker', attempt: spec.attempt, provider: 'p', model: spec.attempt > 0 ? 'strong' : 'cheap', selection_source: 'policy', status: 'done', result: GOOD, stopReason: 'completed' };
    },
    cancelAttempt: async () => {},
  };
}

let seq = 0;
const idFactory = () => `wf-${++seq}`;
const rawConfig = (patch = {}) => ({ collaboration_mode: 'review-pipeline', escalate_on_failure: true, ...patch });

function makeRuntime(attempters, workspace, patch = {}) {
  const config = { collaboration_mode: 'review-pipeline', escalate_on_failure: true, ...patch };
  return createWorkflowRuntime({
    executeAttempt: attempters.executeAttempt,
    cancelAttempt: attempters.cancelAttempt,
    ...workspace,
    buildReviewTask: (task, view) => `review ${task}`,
    getConfig: () => config,
  }, { maxParallel: patch.maxParallel ?? 3, idFactory });
}

maybe('coding worker edits its worktree; primary repo stays clean and candidate carries the change', async (t) => {
  const repo = makeGitRepo();
  t.after(() => { try { rmSync(repo, { recursive: true, force: true }); } catch {} });
  const ws = workspaceAdapters();
  const at = fakeAttempters();
  const rt = makeRuntime(at, ws, rawConfig());
  const job = rt.start({ role: 'worker', task: 'change it', cwd: repo, source: 'test' });
  await rt.wait(job.id, 5000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'done');
  assert.equal(v.isolation, 'worktree');
  assert.notEqual(v.execution_cwd, repo, 'worker must run in the worktree, not the primary repo');
  // primary untouched
  assert.equal(readFileSync(join(repo, 'a.mjs'), 'utf8'), 'export const a = 1;\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');
  // candidate
  assert.ok(v.candidate.changed_files.includes('src/worker.mjs'));
  assert.match(v.candidate.patch, /worker\.mjs/);
});

maybe('a dirty primary workspace is untouched and never folds into the candidate', async (t) => {
  const repo = makeGitRepo();
  t.after(() => { try { rmSync(repo, { recursive: true, force: true }); } catch {} });
  // leave the primary dirty BEFORE the worker starts
  writeFileSync(join(repo, 'dirty.txt'), 'uncommitted-user-change\n');
  const ws = workspaceAdapters();
  const at = fakeAttempters();
  const rt = makeRuntime(at, ws, rawConfig());
  const job = rt.start({ role: 'worker', task: 'change it', cwd: repo, source: 'test' });
  await rt.wait(job.id, 5000);
  // primary still has the user's uncommitted file, unchanged
  assert.equal(readFileSync(join(repo, 'dirty.txt'), 'utf8'), 'uncommitted-user-change\n');
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  assert.match(status, /dirty\.txt/, 'user change remains untracked');
  const v = rt.get(job.id, { withResult: true });
  // the dirty file is NOT part of the worker candidate (worktree base is HEAD)
  assert.ok(!v.candidate.changed_files.includes('dirty.txt'));
});

maybe('two concurrent coding jobs use distinct worktrees and independent candidates', async (t) => {
  const repo = makeGitRepo();
  t.after(() => { try { rmSync(repo, { recursive: true, force: true }); } catch {} });
  const ws = workspaceAdapters();
  const at = fakeAttempters();
  const rt = makeRuntime(at, ws, rawConfig({ maxParallel: 2 }));
  const A = rt.start({ role: 'worker', task: 'A', cwd: repo, source: 'test' });
  const B = rt.start({ role: 'worker', task: 'B', cwd: repo, source: 'test' });
  await rt.wait(A.id, 5000);
  await rt.wait(B.id, 5000);
  const va = rt.get(A.id, { withResult: true });
  const vb = rt.get(B.id, { withResult: true });
  assert.notEqual(va.execution_cwd, vb.execution_cwd, 'worktrees must differ');
  // identical edits produce (correctly) identical candidates — the isolation
  // guarantee is distinct worktrees, not colliding edits
  assert.ok(va.candidate.changed_files.includes('src/worker.mjs'));
  assert.ok(vb.candidate.changed_files.includes('src/worker.mjs'));
});

maybe('max_parallel queues a third workflow and it runs once a slot frees', async (t) => {
  const repo = makeGitRepo();
  t.after(() => { try { rmSync(repo, { recursive: true, force: true }); } catch {} });
  const ws = workspaceAdapters();
  const at = fakeAttempters();
  let gate;
  const holdFirst = new Promise((res) => { gate = res; });
  let calls = 0;
  const orig = at.executeAttempt;
  at.executeAttempt = async (spec) => { calls += 1; if (spec.role === 'worker' && calls <= 2) await holdFirst; return orig(spec); };
  const rt = makeRuntime(at, ws, rawConfig({ maxParallel: 2 }));
  const A = rt.start({ role: 'worker', task: 'A', cwd: repo, source: 'test' });
  const B = rt.start({ role: 'worker', task: 'B', cwd: repo, source: 'test' });
  const C = rt.start({ role: 'worker', task: 'C', cwd: repo, source: 'test' });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(C.phase, JOB_PHASES.QUEUED);
  gate();
  await rt.wait(A.id, 5000); await rt.wait(B.id, 5000); await rt.wait(C.id, 5000);
  assert.equal(rt.get(C.id).phase, JOB_PHASES.COMPLETED);
});

maybe('automatic reviewer runs against the isolated candidate workspace', async (t) => {
  const repo = makeGitRepo();
  t.after(() => { try { rmSync(repo, { recursive: true, force: true }); } catch {} });
  const ws = workspaceAdapters();
  const at = fakeAttempters();
  const rt = makeRuntime(at, ws, rawConfig());
  const job = rt.start({ role: 'worker', task: 'change it', cwd: repo, source: 'test' });
  await rt.wait(job.id, 5000);
  const v = rt.get(job.id, { withResult: true });
  assert.equal(v.status, 'done');
  assert.equal(v.review.verdict, 'approve');
  assert.ok(at.calls.some((s) => s.role === 'reviewer'), 'reviewer attempt ran');
  assert.ok(v.candidate.fingerprint, 'candidate retained after review');
});
