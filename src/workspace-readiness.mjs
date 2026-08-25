// Read-only workspace preflight used by MCP and local HTTP readiness. It never
// changes branches, creates worktrees, or touches user files.

import { constants } from 'node:fs';
import { access as fsAccess } from 'node:fs/promises';
import { inspectRepository } from './workspace-isolation.mjs';

export async function assessWorkspaceReadiness({ cwd, inspect = inspectRepository, access = fsAccess } = {}) {
  if (!cwd) return { ok: true, status: 'READY', reason_code: 'WORKSPACE_NOT_REQUESTED', repo_root: null, base_revision: null };
  const repository = await inspect({ cwd });
  if (!repository?.ok) {
    return { ok: false, status: 'UNAVAILABLE', reason_code: repository?.reason ?? 'WORKSPACE_UNAVAILABLE' };
  }
  try {
    await access(repository.repoRoot, constants.W_OK);
  } catch {
    return {
      ok: true, status: 'READ_ONLY', reason_code: 'WORKSPACE_READ_ONLY',
      repo_root: repository.repoRoot, base_revision: repository.baseRevision,
    };
  }
  if (repository.dirty === true) {
    return {
      ok: true, status: 'CONFLICT', reason_code: 'WORKSPACE_DIRTY',
      repo_root: repository.repoRoot, base_revision: repository.baseRevision,
    };
  }
  return {
    ok: true, status: 'READY', reason_code: 'WORKSPACE_READY',
    repo_root: repository.repoRoot, base_revision: repository.baseRevision,
  };
}
