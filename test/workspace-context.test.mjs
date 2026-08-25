import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadWorkspaceContexts,
  resolveWorkspaceContext,
  buildWorkspaceTask,
} from '../src/workspace-context.mjs';

test('workspace registry returns bounded path references without copying file content', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-context-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'dsh-context-repo-'));
  writeFileSync(join(repo, 'AGENTS.md'), 'SECRET-SENTINEL-IN-INSTRUCTION');
  const dir = join(home, '.config', 'dsh-crew');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({ schema_version: 1, workspaces: {
    demo: { repo_root: repo, default_branch: 'main', instruction_files: ['AGENTS.md'], validation_hints: ['node --test'] },
  } }));
  const loaded = loadWorkspaceContexts({ home });
  const resolved = resolveWorkspaceContext(loaded, { workspace_id: 'demo', cwd: repo });
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.context.instruction_files, ['AGENTS.md']);
  assert.doesNotMatch(JSON.stringify(resolved), /SECRET-SENTINEL/);
  const task = buildWorkspaceTask('Implement the change.', resolved.context);
  assert.match(task, /Instruction references: AGENTS\.md/);
  assert.doesNotMatch(task, /SECRET-SENTINEL/);
});

test('workspace resolution rejects unknown ids, root mismatches, and escaping references', () => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-context-repo-'));
  const loaded = { contexts: { demo: { workspace_id: 'demo', repo_root: repo, instruction_files: ['AGENTS.md'], validation_hints: [] } } };
  assert.equal(resolveWorkspaceContext(loaded, { workspace_id: 'missing', cwd: repo }).code, 'WORKSPACE_CONTEXT_NOT_FOUND');
  assert.equal(resolveWorkspaceContext(loaded, { workspace_id: 'demo', cwd: tmpdir() }).code, 'WORKSPACE_ROOT_MISMATCH');
  const badHome = mkdtempSync(join(tmpdir(), 'dsh-context-home-'));
  const dir = join(badHome, '.config', 'dsh-crew');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({ schema_version: 1, workspaces: { bad: { repo_root: repo, instruction_files: ['../secret'] } } }));
  assert.equal(loadWorkspaceContexts({ home: badHome }).contexts.bad, undefined);
});
