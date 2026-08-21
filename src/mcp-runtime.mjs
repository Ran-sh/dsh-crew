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

const SESSION_CONFIG_KEYS = [
  'default_tier', 'default_effort', 'mode', 'default_timeout_seconds',
  'tier_policy', 'escalate_on_failure', 'collaboration_mode', 'main_agent_mode',
  'flash_state', 'pro_state', 'pro_reviews_flash',
];

/**
 * Merge only defined session overrides onto the live global config before the
 * workflow snapshots its policy. This keeps dsh_worker_config authoritative
 * for escalation/review decisions instead of applying it only to the MCP gate.
 */
export function buildEffectiveRuntimeConfig(globalRaw = {}, session = {}) {
  const patch = {};
  for (const key of SESSION_CONFIG_KEYS) {
    if (session?.[key] !== undefined) patch[key] = session[key];
  }
  if (session?.enabled === false) patch.subagents_enabled = false;
  return normalizeGlobalConfig({ ...globalRaw, ...patch });
}

/**
 * Translate a role/workflow attempt into the legacy model-class slot needed by
 * Standalone and DeepSeek Official Hub routing. A user-requested strong worker
 * starts on Pro; every escalated worker attempt also uses the strong slot.
 */
export function resolveAttemptTier({ role = 'worker', attempt = 0, modelClassHint } = {}) {
  if (role === 'reviewer') return 'pro';
  if (Number.isInteger(attempt) && attempt > 0) return 'pro';
  if (modelClassHint === 'pro') return 'pro';
  return 'flash';
}

/** Map a Hub/Standalone job view into the AttemptResult the runtime expects. */
export function attemptFromView(view, spec) {
  return {
    id: view?.id ?? spec.id,
    role: view?.role ?? spec.role ?? 'worker',
    // `view.attempt` may be an adapter routing-attempt (see below); the
    // workflow's logical attempt number is always the spec value.
    attempt: spec.attempt ?? 0,
    provider: view?.provider ?? null,
    model: view?.model ?? null,
    selection_source: view?.selection_source ?? null,
    status: view?.status ?? 'failed',
    result: view?.result ?? null,
    stopReason: view?.stopReason ?? null,
    outcome: view?.outcome ?? null,
    usage: view?.tokens ?? null,
    error: view?.error ?? null,
    error_code: view?.error_code ?? view?.code ?? null,
  };
}

function timedOutAttempt(view, spec, timeoutMs) {
  return {
    ...attemptFromView(view, spec),
    status: 'failed',
    stopReason: 'timeout',
    error: `attempt timed out after ${Math.ceil(timeoutMs / 1000)}s and was cancelled before any retry`,
    timed_out: true,
  };
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
  const getConfig = () => buildEffectiveRuntimeConfig(readGlobalConfig(), getSessionConfig?.() ?? {});
  const getRuntimeControls = () => ({
    max_parallel: getConfig().execution?.max_parallel ?? 3,
  });

  const executeAttempt = async (spec) => {
    const session = getSessionConfig?.() ?? {};
    const effort = spec.effort ?? session.default_effort ?? 'max';
    const timeoutMs = (deps.attemptTimeoutMs?.() ?? (session.default_timeout_seconds ?? 1800) * 1000);
    const tier = resolveAttemptTier({ role: spec.role, attempt: spec.attempt, modelClassHint: spec.model_class_hint });
    const delivery = spec.role === 'reviewer' || spec.delivery === 'review' ? 'review' : 'coding';
    const source = spec.source ?? 'api';
    const preset = presetForTier?.(tier);

    if ((await resolveMode()) === 'hub') {
      // Hub follow-dsh currently uses `attempt` to choose primary vs escalation
      // model policy. For an explicit worker+pro hint, route selection through
      // the strong pool while preserving the workflow's logical attempt number
      // in the normalized AttemptResult.
      const routingAttempt = spec.role === 'worker' && spec.attempt === 0 && spec.model_class_hint === 'pro'
        ? 1
        : spec.attempt;
      const spawned = await hub.spawn({
        task: spec.task,
        tier,
        role: spec.role,
        attempt: routingAttempt,
        effort,
        cwd: spec.cwd,
        source,
        preset,
        delivery,
      });
      spec.onAttemptStarted?.(spawned.id);

      const deadline = Date.now() + timeoutMs;
      let resolved = spawned;
      while (resolved?.status === 'running') {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          let cancelled = resolved;
          try { cancelled = await hub.cancel(spawned.id); } catch {}
          return timedOutAttempt(cancelled, spec, timeoutMs);
        }
        const waitSeconds = Math.max(1, Math.min(600, Math.ceil(remainingMs / 1000)));
        resolved = await hub.get(spawned.id, waitSeconds);
      }
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
    spec.onAttemptStarted?.(job.id);
    await waitJob(job.id, timeoutMs);
    if (job.status === 'running') {
      await cancelJob(job.id).catch(() => {});
      return timedOutAttempt(jobView(job, { withResult: true }), spec, timeoutMs);
    }
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
    return {
      ok: true,
      execution_cwd: created.worktreePath,
      base_revision: created.baseRevision,
      isolation: 'worktree',
      primary_workspace_dirty: repo.dirty === true,
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
      getRuntimeControls,
    },
    {
      maxParallel: initialConfig.execution?.max_parallel ?? 3,
    },
  );

  return runtime;
}
