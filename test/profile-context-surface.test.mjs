import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../src/workflow-runtime.mjs', import.meta.url), 'utf8');

test('blocking and async MCP requests expose the same profile and workspace fields', () => {
  assert.match(server, /import \{ loadRoleProfiles, resolveRoleProfile \} from '\.\/role-profiles\.mjs'/);
  assert.match(server, /import \{ loadWorkspaceContexts, resolveWorkspaceContext, buildWorkspaceTask, addContextReferences, isSafeBranchName \} from '\.\/workspace-context\.mjs'/);
  assert.ok((server.match(/profile: profileSchema/g) ?? []).length >= 2);
  assert.ok((server.match(/workspace_id: workspaceIdSchema/g) ?? []).length >= 2);
  assert.ok((server.match(/context_refs: contextRefsSchema/g) ?? []).length >= 2);
  assert.ok((server.match(/job_id: clientJobIdSchema/g) ?? []).length >= 2);
  assert.ok((server.match(/workspace: workspaceSchema/g) ?? []).length >= 2);
  assert.ok((server.match(/constraints: constraintsSchema/g) ?? []).length >= 2);
  assert.match(server, /constraints\?\.timeout_seconds \?\? timeout_seconds \?\? profileValue\.timeout_seconds/);
  assert.match(server, /constraints\?\.allow_fallback \?\? profileValue\.fallback/);
  assert.match(server, /constraints\?\.allow_no_changes === true/);
});

test('session config exposes profiles and the narrow extension contract', () => {
  assert.match(server, /role_profiles:/);
  assert.match(server, /extension_contract:/);
});

test('workflow snapshots profile/context metadata and honors profile fallback policy', () => {
  assert.match(runtime, /profile_id: spec\.profile_id/);
  assert.match(runtime, /workspace_context: spec\.workspace_context/);
  assert.match(runtime, /client_job_id: spec\.client_job_id/);
  assert.match(runtime, /workspace_branch: spec\.workspace_branch/);
  assert.match(runtime, /job\.allow_fallback === false/);
  assert.match(runtime, /allow_no_changes: spec\.allow_no_changes === true/);
});

test('readonly profiles are isolated instead of sharing the primary workspace', () => {
  const mcpRuntime = readFileSync(new URL('../src/mcp-runtime.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(mcpRuntime, /job\.requested_isolation === 'readonly' \|\| job\.requested_isolation === 'shared'/);
  assert.match(mcpRuntime, /job\.requested_isolation === 'shared'/);
  assert.match(mcpRuntime, /createIsolatedWorkspace/);
});

test('result polling accepts an event cursor for incremental canonical watch', () => {
  assert.match(server, /after_sequence: z\.number\(\)\.int\(\)\.min\(0\)/);
  assert.match(server, /projectWorkflowView\(view, \{ detail, afterSequence: after_sequence \}\)/);
});
