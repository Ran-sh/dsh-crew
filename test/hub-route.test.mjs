// Regression tests for the P0 Hub tier-enforcement fix: the tier that
// actually reaches the worker runtime must be the policy resolver's effective
// tier, not the raw (or missing) request field. Exercises resolveHubSpawnPayload
// — the exact same pure helper the hub jobs route uses — so "resolver output"
// and "spawn input" are the same object.
//
// Run with: node --test test/hub-route.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHubWorkspaceEvidence, resolveHubSpawnPayload } from '../src/hub/index.mjs';

const raw = (patch = {}) => ({ ...patch });
const cfg = (patch = {}) => ({
  default_tier: 'flash',
  tier_policy: 'auto',
  collaboration_mode: 'balanced',
  flash_state: 'auto',
  pro_state: 'auto',
  subagents_enabled: true,
  ...patch,
});

test('Case 1: pro-only + missing tier → hub.spawn receives tier=pro', () => {
  const r = resolveHubSpawnPayload(raw({ task: 'x' }), () => cfg({ collaboration_mode: 'pro-only' }));
  assert.equal(r.ok, true);
  assert.equal(r.payload.tier, 'pro');
});

test('Case 2: flash-only + missing tier → hub.spawn receives tier=flash', () => {
  const r = resolveHubSpawnPayload(raw({ task: 'x' }), () => cfg({ collaboration_mode: 'flash-only' }));
  assert.equal(r.ok, true);
  assert.equal(r.payload.tier, 'flash');
});

test('Case 3: pro-only + explicit tier=flash → rejected TIER_DISABLED (same semantics as the MCP server)', () => {
  // The MCP layer rejects TIER_DISABLED; the hub must not silently diverge, so
  // the shared resolver returns the same rejection with the same code.
  const r = resolveHubSpawnPayload(raw({ task: 'x', tier: 'flash' }), () => cfg({ collaboration_mode: 'pro-only' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TIER_DISABLED');
  assert.equal(r.payload, undefined);
});

test('Case 4: subagents_enabled=false → no spawn (rejected, payload undefined)', () => {
  const r = resolveHubSpawnPayload(raw({ task: 'x' }), () => cfg({ subagents_enabled: false }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUBAGENTS_DISABLED');
  assert.equal(r.payload, undefined);
});

test('Case 5: custom flash disabled / pro auto + no tier → actual tier is pro', () => {
  const r = resolveHubSpawnPayload(raw({ task: 'x' }), () => cfg({ collaboration_mode: 'custom', flash_state: 'disabled', pro_state: 'auto' }));
  assert.equal(r.ok, true);
  assert.equal(r.payload.tier, 'pro');
});

test('Case 6: both tiers disabled → no spawn', () => {
  const r = resolveHubSpawnPayload(raw({ task: 'x' }), () => cfg({ collaboration_mode: 'custom', flash_state: 'disabled', pro_state: 'disabled' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_WORKER_TIER');
  assert.equal(r.payload, undefined);
});

test('balanced + no tier + default_tier=flash → flash (existing default behavior preserved)', () => {
  const r = resolveHubSpawnPayload(raw({ task: 'x' }), () => cfg({ collaboration_mode: 'balanced', default_tier: 'flash' }));
  assert.equal(r.ok, true);
  assert.equal(r.payload.tier, 'flash');
});

test('other payload fields pass through untouched', () => {
  const r = resolveHubSpawnPayload(raw({ task: 't', effort: 'max', cwd: '/w', preset: 'minimal' }), () => cfg({ collaboration_mode: 'flash-only' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload, { task: 't', effort: 'max', cwd: '/w', preset: 'minimal', tier: 'flash' });
});

test('versioned HTTP request resolves profile, workspace, constraints and caller id', () => {
  const registry = { ok: true, profiles: {
    'worker-default': { role: 'worker', routing: 'auto', isolation: 'worktree', fallback: true, timeout_seconds: 1800, review_strictness: 'standard' },
    safe: { role: 'worker', routing: 'stable', isolation: 'worktree', fallback: false, timeout_seconds: 900, review_strictness: 'strict' },
  } };
  const workspaces = { ok: true, contexts: {
    demo: { workspace_id: 'demo', repo_root: '/repo', default_branch: 'main', instruction_files: ['AGENTS.md'], validation_hints: ['node --test'] },
  } };
  const r = resolveHubSpawnPayload({
    job_id: 'client-1', objective: 'Implement it', role: 'worker', profile: 'safe', workspace_id: 'demo',
    constraints: { timeout_seconds: 30, allow_fallback: true, allow_no_changes: true }, context_refs: ['docs/guide.md'],
  }, () => cfg(), { profileRegistry: registry, workspaceRegistry: workspaces });
  assert.equal(r.ok, true);
  assert.equal(r.payload.client_job_id, 'client-1');
  assert.equal(r.payload.cwd, '/repo');
  assert.equal(r.payload.timeout_seconds, 30);
  assert.equal(r.payload.allow_fallback, true);
  assert.equal(r.payload.allow_no_changes, true);
  assert.equal(r.payload.requested_isolation, 'worktree');
  assert.equal(r.payload.workspace_branch, 'main');
  assert.match(r.payload.task, /AGENTS\.md, docs\/guide\.md/);
});

test('versioned HTTP request rejects malformed workspace and constraints', () => {
  const profiles = { ok: true, profiles: { 'worker-default': {
    role: 'worker', routing: 'auto', isolation: 'worktree', fallback: true, timeout_seconds: 1800, review_strictness: 'standard',
  } } };
  const dependencies = { profileRegistry: profiles, workspaceRegistry: { ok: true, contexts: {} } };
  for (const payload of [
    { objective: 'x', workspace: { repo_root: '/repo', worktree: 'unsafe' } },
    { objective: 'x', workspace: { repo_root: '/repo', branch: '' } },
    { objective: 'x', workspace: { repo_root: '/repo', branch: '--lock' } },
    { objective: 'x', workspace: { repo_root: '/repo' }, constraints: { timeout_seconds: -1 } },
    { objective: 'x', workspace: { repo_root: '/repo' }, constraints: { allow_fallback: 'yes' } },
    { objective: 'x', workspace: { repo_root: '/repo' }, constraints: { allow_no_changes: 'yes' } },
  ]) {
    assert.equal(resolveHubSpawnPayload(payload, () => cfg(), dependencies).ok, false);
  }
});

test('direct Hub jobs enforce verified no-change evidence only in an isolated clean worktree', () => {
  const partial = {
    execution_status: 'completed', task_status: 'partial', changes: [],
    tests: [{ status: 'PASS' }, { status: 'NOT RUN' }],
    delivery: { complete: true },
  };
  const cleanDiff = {
    kind: 'git', dirtyBaseline: false,
    changes: { modified: [], deleted: [], renamed: [], untracked: [] },
  };
  const verified = applyHubWorkspaceEvidence({
    outcome: partial, workspaceDiff: cleanDiff, allowNoChanges: true, isolation: 'worktree',
  });
  assert.equal(verified.task_status, 'success');
  assert.equal(verified.no_change_verified, true);
  assert.equal(verified.workspace_evidence_ok, true);

  const unauthorizedSuccess = applyHubWorkspaceEvidence({
    outcome: { ...partial, task_status: 'success', tests: [{ status: 'PASS' }] },
    workspaceDiff: cleanDiff,
    allowNoChanges: false,
    isolation: 'worktree',
    role: 'worker',
  });
  assert.equal(unauthorizedSuccess.task_status, 'partial');
  assert.equal(unauthorizedSuccess.no_change_verified, undefined);

  for (const options of [
    { isolation: 'shared', workspaceDiff: cleanDiff },
    { isolation: 'worktree', workspaceDiff: { ...cleanDiff, dirtyBaseline: true } },
  ]) {
    const result = applyHubWorkspaceEvidence({ outcome: partial, allowNoChanges: true, role: 'worker', ...options });
    assert.equal(result.task_status, 'partial');
    assert.equal(result.no_change_verified, undefined);
  }
});
