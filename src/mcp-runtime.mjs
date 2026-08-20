// MCP-side workflow runtime wiring: builds the shared workflow runtime with
// the real Hub / Standalone attempt adapters and the git-worktree workspace
// adapter. This is the only place that knows which transport executes an
// attempt; the MCP server (src/server.mjs) only does schema, validation,
// policy gating and formatting.
//
// Behaviour decisions (escalation, review, candidate, queue, cancellation)
// live entirely in workflow-runtime.mjs; the adapters here just execute.

import { createWorkflowRuntime } from './workflow-runtime.mjs';
import { normalizeGlobalConfig } from './policy.mjs';
import {
  createIsolatedWorkspace,
  cleanupIsolatedWorkspace,
  inspectRepository,
  captureCandidate as captureIsolationCandidate,
} from './workspace-isolation.mjs';
import { startJob, waitJob, jobView, cancelJob } from './jobs.mjs';
import { hub } from './hub-client.mjs';

/** Map a Hub/Standalone job view into the AttemptResult the runtime expects. */
function attemptFromView(view, spec) {
  return {
    id: view?.id ?? spec.id,
    role: view?.role ?? spec.role ?? 'worker',
    attempt: view?.attempt ?? spec.attempt ?? 0,
    provider: view?.provider ?? null,
    model: view?.model ?? null,
    selection_source: view?.selection_source ?? null,
    status: view?.status ?? 'failed',
    result: view?.result ?? null,
    stopReason: view?.stopReason ?? null,
    outcome: view?.outcome ?? null,
    usage: view?.tokens ?? null,
    error: view?.error ?? null,
  };
}

function tierSlotFor(role) {
  return role === 'reviewer' ? 'pro' : 'flash';
}

/**
 * Build the workflow runtime used by the MCP server.
 *
 * deps:
 *   getSessionConfig()     -> session-level config (effort, timeout, mode...)
 *   resolveMode()          -> 'hub' | 'standalone'
 *   presetForTier(tier)    -> hub agent preset id for a tier slot (optional)
 *   readGlobalConfig()     -> raw global config reader
 *   buildReviewTask(task, view) -> reviewer prompt builder
 *   attemptTimeoutMs()     -> default attempt execution timeout (optional)
 */
export function buildMcpWorkflowRuntime(deps) {
  const { getSessionConfig, resolveMode, presetForTier, readGlobalConfig, buildReviewTask } = deps;
  const getConfig = () => normalizeGlobalConfig(readGlobalConfig());

  const executeAttempt = async (spec) => {
    const session = getSessionConfig?.() ?? {};
    const effort = spec.effort ?? session.default_effort ?? 'max';
    const timeoutMs = (deps.attemptTimeoutMs?.() ?? (session.default_timeout_seconds ?? 1800) * 1000);
    const tier = tierSlotFor(spec.role);
    const delivery = spec.role === 'reviewer' || spec.delivery === 'review' ? 'review' : 'coding';
    const source = spec.source ?? 'api';
    const preset = presetForTier?.(tier);

    if ((await resolveMode()) === 'hub') {
      const spawned = await hub.spawn({
        task: spec.task,
        tier,
        role: spec.role,
        attempt: spec.attempt,
        effort,
        cwd: spec.cwd,
        source,
        preset,
        delivery,
      });
      const resolved = await hub.get(spawned.id, Math.min(Math.floor(timeoutMs / 1000), 600));
      return attemptFromView(resolved, spec);
    }

    const job = startJob({
      task: spec.task,
      tier,
      role: spec.role,
      attempt: spec.attempt,
      effort,
      cwd: spec.cwd,
      timeoutMs,
      source,
      delivery,
    });
    await waitJob(job.id, timeoutMs);
    return attemptFromView(jobView(job, { withResult: true }), spec);
  };

  const cancelAttempt = async (id) => {
    if (String(id ?? '').startsWith('hub-')) {
      try { await hub.cancel(id); } catch {}
      return;
    }
    try { await cancelJob(id); } catch {}
  };

  const allocateWorkspace = async (job) => {
    const config = getConfig();
    const isolation = config.execution?.isolation ?? 'worktree';
    // Reviewer role / explicit review and shared mode never draft a candidate;
    // they run in the requested workspace.
    if (job.role === 'reviewer' || job.delivery === 'review' || isolation === 'shared') {
      return { ok: true, execution_cwd: job.requested_cwd, isolation: 'shared', base_revision: null, primary_workspace_dirty: false, handle: null };
    }
    // Coding worker under worktree isolation: fail closed when the workspace
    // is not a git repo — never silently fall back to sharing the working tree.
    const repo = await inspectRepository({ cwd: job.requested_cwd });
    if (!repo.ok) {
      return { ok: false, reason: repo.reason ?? 'ISOLATION_UNAVAILABLE', error: `coding worker needs an isolated git worktree: ${repo.error ?? repo.reason}` };
    }
    const created = await createIsolatedWorkspace({ cwd: job.requested_cwd, jobId: job.id, baseRevision: repo.baseRevision });
    if (!created.ok) {
      return { ok: false, reason: created.reason ?? 'WORKTREE_CREATE_FAILED', error: `worktree create failed: ${created.error ?? ''}` };
    }
    const baselineDirty = false; // worktrees start clean at base by construction
    void baselineDirty;
    return {
      ok: true,
      execution_cwd: created.worktreePath,
      base_revision: created.baseRevision,
      isolation: 'worktree',
      primary_workspace_dirty: false,
      handle: { worktreePath: created.worktreePath, repoRoot: created.repoRoot },
    };
  };

  const captureCandidate = async ({ cwd, baseRevision }) => captureIsolationCandidate({ worktreePath: cwd, baseRevision });

  const releaseWorkspace = async (handle) => {
    if (!handle) return { ok: true };
    try {
      const r = await cleanupIsolatedWorkspace({ worktreePath: handle.worktreePath, repoRoot: handle.repoRoot });
      return { ok: r.ok, error: r.ok ? undefined : r.error };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  };

  const initialConfig = getConfig();
  const runtime = createWorkflowRuntime(
    {
      executeAttempt,
      cancelAttempt,
      allocateWorkspace,
      captureCandidate,
      releaseWorkspace,
      buildReviewTask,
      getConfig,
    },
    {
      maxParallel: initialConfig.execution?.max_parallel ?? 3,
    },
  );

  return runtime;
}
