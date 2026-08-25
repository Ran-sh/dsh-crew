import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWorkspaceReadiness } from '../src/workspace-readiness.mjs';

const repo = (dirty = false) => async () => ({ ok: true, repoRoot: '/repo', baseRevision: 'abc', dirty });

test('workspace preflight distinguishes ready, conflict, read-only and unavailable', async () => {
  assert.equal((await assessWorkspaceReadiness({ cwd: '/repo', inspect: repo(false), access: async () => {} })).status, 'READY');
  assert.equal((await assessWorkspaceReadiness({ cwd: '/repo', inspect: repo(true), access: async () => {} })).status, 'CONFLICT');
  assert.equal((await assessWorkspaceReadiness({ cwd: '/repo', inspect: repo(false), access: async () => { throw new Error('denied'); } })).status, 'READ_ONLY');
  const unavailable = await assessWorkspaceReadiness({ cwd: '/bad', inspect: async () => ({ ok: false, reason: 'NOT_GIT_REPOSITORY' }) });
  assert.equal(unavailable.status, 'UNAVAILABLE');
  assert.equal(unavailable.reason_code, 'NOT_GIT_REPOSITORY');
});

test('workspace preflight treats an omitted workspace as a valid not-requested state', async () => {
  const result = await assessWorkspaceReadiness({ cwd: null });
  assert.equal(result.status, 'READY');
  assert.equal(result.reason_code, 'WORKSPACE_NOT_REQUESTED');
});
