// MCP stdio server exposing the DSH worker pool to Claude Code / Codex.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startJob, waitJob, cancelJob, listJobs, getJob, jobView } from './jobs.mjs';
import { hubStatus, hub } from './hub-client.mjs';
import { hubCompatibilityMessage, resolveHubExecutionMode } from './hub-compatibility.mjs';
import { RUNTIME_VERSION, getHubRuntimeIdentity } from './runtime-identity.mjs';
import { resolveWorkerModel } from './model-routing.mjs';
import { runtimeActivationMetadata } from './runtime-controls.mjs';
import { buildConfigReadinessMatrix } from './config-readiness.mjs';
import { classifyFailure, classifyFailureCode } from './failure-classification.mjs';
import {
  normalizeGlobalConfig,
  deriveLegacyConfig,
  getEffectiveTierState,
  getRoutingGuidance,
  chooseDefaultTier,
  canDispatchRole,
  resolveRoleTierHint,
  shouldAutoReview,
} from './policy.mjs';
import { buildMcpWorkflowRuntime } from './mcp-runtime.mjs';
import { buildReviewTask } from './information-flow.mjs';
import { projectWorkflowView } from './job-contracts.mjs';
import { loadRoleProfiles, resolveRoleProfile } from './role-profiles.mjs';
import { loadWorkspaceContexts, resolveWorkspaceContext, buildWorkspaceTask, addContextReferences, isSafeBranchName } from './workspace-context.mjs';
import { buildExtensionContract } from './extension-contract.mjs';
import { assessWorkspaceReadiness } from './workspace-readiness.mjs';
import { detectOrchestrator } from './orchestrator.mjs';

const server = new McpServer({ name: 'dsh-crew', version: RUNTIME_VERSION });

const tierSchema = z.enum(['flash', 'pro']).optional().describe('Legacy worker tier (compatibility only): Flash/Pro now act as a model-class hint, not a role. Prefer role=worker / role=reviewer; the backend resolves the actual provider/model from the Model Policy.');
const roleSchema = z.enum(['worker', 'reviewer']).optional().describe('Dispatch role: worker executes implementation / fixes / tests / search; reviewer independently reviews a completed implementation. A coding request defaults to worker; reviewer runs on explicit request or via the automatic review workflow.');
const effortSchema = z.enum(['off', 'high', 'max']).optional().describe('Reasoning effort for the worker. Omit to use the session default.');
const detailSchema = z.enum(['compact', 'full']).default('compact').describe('compact returns the bounded Result Contract; full explicitly includes raw workflow/candidate details for debugging.');
const profileSchema = z.string().max(64).optional().describe('Versioned Worker/Reviewer profile id; defaults by role.');
const workspaceIdSchema = z.string().max(64).optional().describe('Workspace Context id from Crew-owned workspaces.json.');
const contextRefsSchema = z.array(z.string().max(256)).max(32).optional().describe('Additional workspace-relative instruction references; contents are not copied.');
const clientJobIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional().describe('Optional caller id echoed in events and evidence; Crew still assigns its own workflow id.');
const workspaceSchema = z.object({
  repo_root: z.string().optional(),
  branch: z.string().refine(isSafeBranchName, 'invalid git branch name').optional(),
  worktree: z.enum(['auto', 'existing', 'none']).optional(),
}).optional().describe('Per-job workspace overrides. auto isolates coding Workers; existing/none use the supplied workspace.');
const constraintsSchema = z.object({
  timeout_seconds: z.number().int().positive().max(7200).optional(),
  allow_fallback: z.boolean().optional(),
  allow_no_changes: z.boolean().optional().describe('Explicitly allow a verified read-only or analysis job to succeed with zero workspace changes.'),
}).optional().describe('Per-job constraints override profile and session defaults.');

// Session-level configuration. This MCP server process lives exactly as long
// as one Claude Code / Codex session, so plain memory IS session scope.
// Initial values come from the global config (~/.config/dsh-crew/config.json,
// edited on the DSH settings page); dsh_worker_config overrides per session.
// All dispatch decisions (dsh_run_worker AND dsh_spawn_worker, hub AND
// production dispatches go through the 3210-only policy resolver in
// src/policy.mjs; the historical standalone path is retained only for
// read/migration compatibility and is never selected for execution.
import { readGlobalConfig } from './install/install.mjs';
const initialGlobalConfig = normalizeGlobalConfig(readGlobalConfig());
const legacyDefaults = deriveLegacyConfig(initialGlobalConfig);
const currentGlobalConfig = () => normalizeGlobalConfig(readGlobalConfig());
const sessionConfig = {
  enabled: true,
  default_tier: legacyDefaults.default_tier,
  default_effort: legacyDefaults.default_effort,
  mode: legacyDefaults.mode === 'standalone' ? 'hub' : legacyDefaults.mode, // auto | hub; legacy standalone is migrated to hub
  default_timeout_seconds: legacyDefaults.default_timeout_seconds,
  tier_policy: undefined,
  escalate_on_failure: legacyDefaults.escalate_on_failure,
  preset_flash: legacyDefaults.preset_flash ?? 'default',
  preset_pro: legacyDefaults.preset_pro ?? 'default',
  collaboration_mode: undefined,
  main_agent_mode: undefined,
  flash_state: undefined,
  pro_state: undefined,
  pro_reviews_flash: undefined,
};

function resetSessionConfig() {
  Object.assign(sessionConfig, {
    enabled: true,
    default_tier: legacyDefaults.default_tier,
    default_effort: legacyDefaults.default_effort,
    mode: legacyDefaults.mode === 'standalone' ? 'hub' : legacyDefaults.mode,
    default_timeout_seconds: legacyDefaults.default_timeout_seconds,
    tier_policy: undefined,
    escalate_on_failure: legacyDefaults.escalate_on_failure,
    preset_flash: legacyDefaults.preset_flash ?? 'default',
    preset_pro: legacyDefaults.preset_pro ?? 'default',
    collaboration_mode: undefined,
    main_agent_mode: undefined,
    flash_state: undefined,
    pro_state: undefined,
    pro_reviews_flash: undefined,
  });
}

function presetForTier(tier) {
  const p = tier === 'flash' ? sessionConfig.preset_flash : sessionConfig.preset_pro;
  return !p || p === 'default' ? undefined : p;
}

function text(obj) {
  let payload = obj;
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.failure === undefined) {
    if (obj.code) {
      payload = { ...obj, failure: classifyFailureCode(obj.code) };
    } else if (obj.status !== undefined || obj.phase !== undefined || obj.outcome !== undefined || obj.error_code !== undefined) {
      payload = {
        ...obj,
        failure: classifyFailure({
          phase: obj.phase,
          status: obj.status,
          errorCode: obj.error_code,
          outcome: obj.outcome,
          decision: obj.decision,
          review: obj.review,
          childAttempts: obj.child_attempts,
        }),
      };
    }
  }
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}

const ORCHESTRATOR = detectOrchestrator();

function policyRejection(decision) {
  return text({
    error: decision.error.message,
    code: decision.error.policyCode,
    note: 'DSH Crew policy rejection — report this to the user instead of doing the task yourself.',
  });
}

function dispatchDisabled() {
  return text({
    error: 'worker dispatch is disabled for this session (set via dsh_worker_config). Report this to the user instead of doing the task yourself.',
    code: 'SUBAGENTS_DISABLED',
  });
}

async function resolveMode() {
  const status = await hubStatus();
  const decision = resolveHubExecutionMode(sessionConfig.mode, status, { productionOnly: true });
  if (!decision.ok) {
    throw Object.assign(new Error(decision.error), {
      code: decision.code,
      hubStatus: status,
    });
  }
  return decision.mode;
}

const workflowRuntime = buildMcpWorkflowRuntime({
  getSessionConfig: () => sessionConfig,
  resolveMode,
  presetForTier,
  readGlobalConfig,
  buildReviewTask,
  attemptTimeoutMs: () => (sessionConfig.default_timeout_seconds ?? 1800) * 1000,
});

function dispatchError(code, details = {}) {
  return { ok: false, response: text({ error: details.error ?? code, code, ...details }) };
}

function prepareDispatch({ task, role, tier, legacy_tier, effort, cwd, timeout_seconds, profile, workspace_id, context_refs, job_id, workspace: workspaceOverride, constraints }) {
  const globalConfig = currentGlobalConfig();
  const profileRegistry = loadRoleProfiles();
  if (!profileRegistry.ok) return dispatchError('PROFILE_FILE_INVALID', { errors: profileRegistry.errors });
  const profileRole = profile ? profileRegistry.profiles?.[profile]?.role : undefined;
  const requestedRole = role ?? profileRole;
  const hint = resolveRoleTierHint(requestedRole, legacy_tier ?? tier);
  if (!hint.ok) return dispatchError(hint.code, { error: hint.error });
  const effRole = hint.role;
  const resolvedProfile = resolveRoleProfile(profileRegistry, profile, effRole);
  if (!resolvedProfile.ok) return dispatchError(resolvedProfile.code, resolvedProfile);

  let effTier;
  let decision;
  if (requestedRole === undefined) {
    decision = chooseDefaultTier(globalConfig, legacy_tier ?? tier, sessionConfig);
    if (!decision.ok) return { ok: false, response: policyRejection(decision) };
    effTier = decision.tier;
  } else {
    decision = canDispatchRole(globalConfig, effRole, true, sessionConfig);
    if (!decision.ok) return { ok: false, response: policyRejection(decision) };
    if (effRole === 'reviewer') effTier = 'pro';
    else if (legacy_tier !== undefined) effTier = legacy_tier;
    else if (tier !== undefined) effTier = tier;
    else { const slot = chooseDefaultTier(globalConfig, undefined, sessionConfig); effTier = slot.ok ? slot.tier : 'flash'; }
  }

  const workDir = workspaceOverride?.repo_root ?? cwd ?? process.cwd();
  const workspace = resolveWorkspaceContext(loadWorkspaceContexts(), { workspace_id, cwd: workDir });
  if (!workspace.ok) return dispatchError(workspace.code, workspace);
  const withRefs = addContextReferences(workspace.context, context_refs, { cwd: workDir });
  if (!withRefs.ok) return dispatchError(withRefs.code);
  const profileValue = resolvedProfile.profile;
  const effectiveTimeout = constraints?.timeout_seconds ?? timeout_seconds ?? profileValue.timeout_seconds ?? sessionConfig.default_timeout_seconds;
  const requestedIsolation = workspaceOverride?.worktree === 'auto'
    ? 'worktree'
    : workspaceOverride?.worktree === 'existing' || workspaceOverride?.worktree === 'none'
      ? 'shared'
      : profileValue.isolation;
  return {
    ok: true,
    role: effRole,
    timeout: effectiveTimeout,
    spec: {
      client_job_id: job_id ?? null,
      role: effRole,
      delivery: effRole === 'reviewer' ? 'review' : 'coding',
      model_class_hint: effTier,
      task: buildWorkspaceTask(task, withRefs.context),
      cwd: workDir,
      effort: effort ?? sessionConfig.default_effort,
      source: ORCHESTRATOR,
      profile_id: resolvedProfile.profile_id,
      requested_isolation: requestedIsolation,
      workspace_branch: workspaceOverride?.branch ?? withRefs.context?.default_branch ?? null,
      timeout_seconds: effectiveTimeout,
      allow_fallback: constraints?.allow_fallback ?? profileValue.fallback,
      allow_no_changes: constraints?.allow_no_changes === true,
      routing: profileValue.routing,
      review_strictness: profileValue.review_strictness,
      workspace_context: withRefs.context,
    },
  };
}

server.registerTool('dsh_run_worker', {
  title: 'Run DSH worker (blocking)',
  description: 'Delegate a task to a DSH (DeepSeek Harness) coding agent and wait for its final result. The worker is a full DSH agent with its own tools and sandbox. Pass role=worker for implementation and role=reviewer for an independent review pass. Disabled roles are refused by the DSH Crew policy; Manual roles only run when explicitly requested. Blocks until the worker finishes.',
  inputSchema: {
    task: z.string().describe('Full task description for the worker, self-contained'),
    role: roleSchema,
    tier: tierSchema,
    legacy_tier: tierSchema.describe('Legacy model-class hint (flash | pro), forwarded verbatim by deprecated ds-flash/ds-pro aliases; only influences which model class backs a worker role, never the role gate'),
    effort: effortSchema,
    cwd: z.string().optional().describe('Workspace directory for the worker (defaults to current project)'),
    timeout_seconds: z.number().int().positive().max(7200).optional(),
    job_id: clientJobIdSchema,
    workspace: workspaceSchema,
    constraints: constraintsSchema,
    profile: profileSchema,
    workspace_id: workspaceIdSchema,
    context_refs: contextRefsSchema,
    detail: detailSchema,
  },
}, async ({ task, role, tier, legacy_tier, effort, cwd, timeout_seconds, profile, workspace_id, context_refs, job_id, workspace, constraints, detail }) => {
  if (!sessionConfig.enabled) return dispatchDisabled();
  const prepared = prepareDispatch({ task, role, tier, legacy_tier, effort, cwd, timeout_seconds, profile, workspace_id, context_refs, job_id, workspace, constraints });
  if (!prepared.ok) return prepared.response;
  const wf = workflowRuntime.start(prepared.spec);
  await workflowRuntime.wait(wf.id, prepared.timeout * 1000);
  const view = workflowRuntime.get(wf.id, { withResult: true });
  if (view.status === 'running') {
    return text({ ...projectWorkflowView(view, { detail }), note: `still running after ${prepared.timeout}s; poll with dsh_worker_result`, status: 'running' });
  }
  if (view.phase === 'failed') {
    return text({ ...projectWorkflowView(view, { detail }), note: 'workflow failed — see error / error_code.', status: 'failed' });
  }
  return text({ ...projectWorkflowView(view, { detail }), note: prepared.role === 'reviewer' ? 'review complete' : 'workflow complete' });
});

server.registerTool('dsh_worker_config', {
  title: 'Session worker configuration',
  description: 'Read or update session-level worker settings: enable/disable dispatch, default tier/effort/timeout, execution mode, tier policy, escalation, collaboration mode, per-tier state and review behavior. Call with no arguments to read the current configuration, runtime control state, activation boundaries, global defaults, session overrides, effective policy and routing guidance. Settings last for this session only.',
  inputSchema: {
    enabled: z.boolean().optional().describe('false = refuse all worker dispatch this session'),
    default_tier: z.enum(['flash', 'pro']).optional(),
    default_effort: z.enum(['off', 'high', 'max']).optional(),
    mode: z.enum(['auto', 'hub']).optional().describe('Execution mode. Production dispatch always uses the isolated 3210 Crew Harness; standalone is retained only as a legacy read/migration value.'),
    default_timeout_seconds: z.number().int().positive().max(7200).optional(),
    tier_policy: z.enum(['auto', 'flash-only', 'pro-only']).optional().describe('session hard clamp: flash-only / pro-only pin every dispatch to one tier'),
    escalate_on_failure: z.boolean().optional().describe('allow an unverified worker attempt to retry through the stronger model policy (applies to run and spawn)'),
    preset_flash: z.string().optional().describe('hub-mode agent preset for flash workers (preset id, or "default")'),
    preset_pro: z.string().optional().describe('hub-mode agent preset for pro workers (preset id, or "default")'),
    collaboration_mode: z.enum(['flash-only', 'pro-only', 'balanced', 'review-pipeline', 'custom']).optional().describe('session override of the global collaboration mode'),
    main_agent_mode: z.enum(['direct-allowed', 'coordinator-first', 'dispatcher-only']).optional().describe('session override of the host routing guidance'),
    flash_state: z.enum(['disabled', 'manual', 'auto']).optional().describe('session override of the flash tier state (custom mode)'),
    pro_state: z.enum(['disabled', 'manual', 'auto']).optional().describe('session override of the pro tier state (custom mode)'),
    pro_reviews_flash: z.boolean().optional().describe('enable the automatic reviewer after a verified worker workflow (applies to run and spawn)'),
    reset: z.boolean().optional().describe('true = restore all defaults first'),
  },
}, async ({ reset, ...patch }) => {
  if (reset) resetSessionConfig();
  if (patch.tier_policy === 'auto') {
    sessionConfig.tier_policy = undefined;
    sessionConfig.collaboration_mode = 'balanced';
    delete patch.tier_policy;
  }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) sessionConfig[k] = v;
  return text(await buildConfigReport());
});

const SAFE_GLOBAL_KEYS = [
  'default_tier', 'default_effort', 'mode', 'default_timeout_seconds', 'hub_url',
  'tier_policy', 'escalate_on_failure', 'subagents_enabled', 'collaboration_mode',
  'main_agent_mode', 'flash_state', 'pro_state', 'flash_roles', 'pro_roles',
  'pro_reviews_flash', 'worker_provider_mode', 'vision_enabled', 'imagegen_enabled',
  'flash_model_priority', 'flash_model_priority_configured', 'flash_model_fallback',
  'pro_model_priority', 'pro_model_priority_configured', 'pro_model_fallback',
  'vision_provider', 'vision_model', 'imagegen_provider',
  'preset_flash', 'preset_pro',
];

async function buildConfigReport() {
  const globalConfig = currentGlobalConfig();
  const legacy = deriveLegacyConfig(globalConfig);
  const flashState = getEffectiveTierState(globalConfig, 'flash', sessionConfig);
  const proState = getEffectiveTierState(globalConfig, 'pro', sessionConfig);
  const defaultDecision = chooseDefaultTier(globalConfig, undefined, sessionConfig);
  const overrides = {};
  for (const [k, v] of Object.entries(sessionConfig)) if (v !== undefined) overrides[k] = v;
  const collaborationMode = sessionConfig.collaboration_mode ?? globalConfig.collaboration_mode;
  const mainAgentMode = sessionConfig.main_agent_mode ?? globalConfig.main_agent_mode;
  const runtimeControls = workflowRuntime.refreshRuntimeControls();
  const activationBoundaries = globalConfig.config_activation ?? runtimeActivationMetadata();
  const hubCompatibility = await hubStatus({ force: true });
  let effectiveWorkerProvider = null;
  let effectiveWorkerSelection = { flash: null, pro: null };
  let providerResolutionError;
  let providerCatalogChecked = false;
  let providerCatalogBody = null;
  let providerInventoryChecked = false;
  let providerInventoryBody = null;
  let hubJobsChecked = false;
  let hubJobsBody = null;
  const workerProviderMode = globalConfig.worker_provider_mode ?? 'deepseek-official';
  if (workerProviderMode === 'deepseek-official') {
    effectiveWorkerSelection = {
      flash: { provider: 'deepseek-official', model: 'deepseek-v4-flash', source: 'legacy-strict' },
      pro: { provider: 'deepseek-official', model: 'deepseek-v4-pro', source: 'legacy-strict' },
    };
  } else if (hubCompatibility.compatible) {
    try {
      providerCatalogChecked = true;
      const res = await fetch(`${globalConfig.hub_url}/_dsh/dsh-crew/models`, { signal: AbortSignal.timeout(800) });
      const body = await res.json();
      providerCatalogBody = body;
      if (!body?.ok) providerResolutionError = body?.error ?? 'Unable to read Harness model catalog.';
      else for (const tier of ['flash', 'pro']) {
        const selected = resolveWorkerModel({
          tier,
          priority: globalConfig[`${tier}_model_priority`],
          priorityConfigured: globalConfig[`${tier}_model_priority_configured`],
          fallback: globalConfig[`${tier}_model_fallback`],
          catalog: body,
          harnessDefault: body.harness_default,
        });
        effectiveWorkerSelection[tier] = selected.ok
          ? { provider: selected.provider, model: selected.model, source: selected.source }
          : { code: selected.code, error: selected.message };
      }
    } catch (err) {
      providerCatalogChecked = true;
      providerResolutionError = err?.message ?? String(err);
    }
  } else if (hubCompatibility.reachable) {
    providerResolutionError = hubCompatibilityMessage(hubCompatibility);
  }
  if (hubCompatibility.compatible) {
    try {
      providerInventoryChecked = true;
      const inventoryRes = await fetch(`${globalConfig.hub_url}/_dsh/dsh-crew/providers`, { signal: AbortSignal.timeout(800) });
      providerInventoryBody = inventoryRes.ok
        ? await inventoryRes.json()
        : { ok: false, code: 'PROVIDER_INVENTORY_UNAVAILABLE' };
    } catch {
      providerInventoryChecked = true;
      providerInventoryBody = { ok: false, code: 'PROVIDER_INVENTORY_UNAVAILABLE' };
    }
  }
  if (hubCompatibility.compatible) {
    try {
      hubJobsChecked = true;
      const jobsRes = await fetch(`${globalConfig.hub_url}/_dsh/dsh-crew/jobs`, { signal: AbortSignal.timeout(800) });
      hubJobsBody = await jobsRes.json();
    } catch {
      hubJobsChecked = true;
    }
  }
  effectiveWorkerProvider = effectiveWorkerSelection.flash?.provider ?? null;
  const readinessMatrix = buildConfigReadinessMatrix({
    hubCompatibility,
    workerProviderMode,
    providerCatalogChecked,
    providerCatalogBody,
    providerInventoryChecked,
    providerInventoryBody,
    hubJobsChecked,
    hubJobsBody,
  });
  const roleProfiles = loadRoleProfiles();
  const workspaceReadiness = await assessWorkspaceReadiness({ cwd: process.cwd() });
  const extensionContract = buildExtensionContract({
    config: {
      ...globalConfig,
      subagents_enabled: sessionConfig.enabled !== false && globalConfig.subagents_enabled !== false,
      worker_state: globalConfig.worker_state,
      review_state: globalConfig.review_state,
      escalate_on_failure: sessionConfig.escalate_on_failure ?? legacy.escalate_on_failure,
    },
    readinessMatrix,
    workspace: workspaceReadiness,
    profiles: roleProfiles,
    runtime: getHubRuntimeIdentity(),
  });
  return {
    enabled: sessionConfig.enabled,
    default_tier: sessionConfig.default_tier ?? legacy.default_tier,
    default_effort: sessionConfig.default_effort ?? legacy.default_effort,
    mode: sessionConfig.mode ?? legacy.mode,
    default_timeout_seconds: sessionConfig.default_timeout_seconds ?? legacy.default_timeout_seconds,
    tier_policy: sessionConfig.tier_policy ?? legacy.tier_policy,
    escalate_on_failure: sessionConfig.escalate_on_failure ?? legacy.escalate_on_failure,
    preset_flash: sessionConfig.preset_flash ?? legacy.preset_flash,
    preset_pro: sessionConfig.preset_pro ?? legacy.preset_pro,
    worker_provider_mode: workerProviderMode,
    effective_worker_provider: effectiveWorkerProvider,
    effective_worker_selection: effectiveWorkerSelection,
    provider_resolution_error: providerResolutionError,
    flash_model_priority: globalConfig.flash_model_priority ?? [],
    flash_model_fallback: globalConfig.flash_model_fallback ?? 'harness-default',
    pro_model_priority: globalConfig.pro_model_priority ?? [],
    pro_model_fallback: globalConfig.pro_model_fallback ?? 'harness-default',
    subagents_enabled: sessionConfig.enabled !== false && globalConfig.subagents_enabled !== false,
    collaboration_mode: collaborationMode,
    main_agent_mode: mainAgentMode,
    flash_state: flashState,
    pro_state: proState,
    flash_roles: globalConfig.flash_roles ?? [],
    pro_roles: globalConfig.pro_roles ?? [],
    pro_reviews_flash: sessionConfig.pro_reviews_flash ?? shouldAutoReview(globalConfig, sessionConfig),
    effective_policy: `mode=${collaborationMode} flash=${flashState} pro=${proState} subagents=${sessionConfig.enabled !== false && globalConfig.subagents_enabled !== false}`,
    legacy_source: sessionConfig.tier_policy !== undefined
      ? `session tier_policy clamp (${sessionConfig.tier_policy})`
      : `global collaboration mode (${collaborationMode})`,
    effective_default_tier: defaultDecision.ok ? defaultDecision.tier : null,
    effective_default_tier_reason: defaultDecision.ok ? defaultDecision.guidance : (defaultDecision.error.policyCode ?? 'none'),
    routing_guidance: getRoutingGuidance(globalConfig, sessionConfig),
    session_overrides: overrides,
    global_defaults: Object.fromEntries(SAFE_GLOBAL_KEYS.map((k) => [k, globalConfig[k]])),
    runtime_controls: runtimeControls,
    activation_boundaries: activationBoundaries,
    readiness_matrix: readinessMatrix,
    role_profiles: roleProfiles,
    extension_contract: extensionContract,
    hub_reachable: hubCompatibility.reachable,
    hub_compatible: hubCompatibility.compatible,
    hub_compatibility: hubCompatibility,
  };
}

server.registerTool('dsh_spawn_worker', {
  title: 'Spawn DSH worker (async)',
  description: 'Start a DSH (DeepSeek Harness) coding workflow in the background and return immediately with a workflow id. Use dsh_worker_status / dsh_worker_result to follow up. Role policy is enforced exactly like dsh_run_worker, and the workflow (verification, escalation, automatic reviewer pass) runs exactly the same for async jobs — only the caller does not await.',
  inputSchema: {
    task: z.string(),
    role: roleSchema,
    tier: tierSchema,
    legacy_tier: tierSchema.describe('Legacy model-class hint (flash | pro) — only influences the model class backing a worker role, never the role gate'),
    effort: effortSchema,
    cwd: z.string().optional(),
    job_id: clientJobIdSchema,
    workspace: workspaceSchema,
    constraints: constraintsSchema,
    profile: profileSchema,
    workspace_id: workspaceIdSchema,
    context_refs: contextRefsSchema,
  },
}, async ({ task, role, tier, legacy_tier, effort, cwd, profile, workspace_id, context_refs, job_id, workspace, constraints }) => {
  if (!sessionConfig.enabled) return dispatchDisabled();
  const prepared = prepareDispatch({ task, role, tier, legacy_tier, effort, cwd, profile, workspace_id, context_refs, job_id, workspace, constraints });
  if (!prepared.ok) return prepared.response;
  const wf = workflowRuntime.start(prepared.spec);
  return text({ ...workflowRuntime.get(wf.id), workflow_id: wf.id, note: 'started in background; poll with dsh_worker_status / dsh_worker_result' });
});

server.registerTool('dsh_worker_status', {
  title: 'DSH worker status',
  description: 'List all DSH worker workflows in this session with phase, role, attempt, current model and token usage.',
  inputSchema: {},
}, async () => {
  return text(workflowRuntime.list());
});

server.registerTool('dsh_worker_result', {
  title: 'DSH worker result',
  description: 'Fetch the result of a worker workflow, optionally waiting for it to finish. Accepts workflow ids (wf-...), Hub attempt ids (hub-...) and legacy standalone ids (job-...).',
  inputSchema: {
    job_id: z.string(),
    wait_seconds: z.number().int().min(0).max(7200).default(0).describe('0 = return current state immediately'),
    after_sequence: z.number().int().min(0).default(0).describe('Return canonical events after this cursor for incremental watch.'),
    detail: detailSchema,
  },
}, async ({ job_id, wait_seconds, after_sequence, detail }) => {
  if (job_id.startsWith('wf-')) {
    if (wait_seconds > 0) await workflowRuntime.wait(job_id, wait_seconds * 1000);
    const view = workflowRuntime.get(job_id, { withResult: true });
    if (!view) return text({ error: `no such workflow: ${job_id}` });
    return text(projectWorkflowView(view, { detail, afterSequence: after_sequence }));
  }
  if (job_id.startsWith('hub-')) {
    const status = await hubStatus();
    if (!status.compatible) return text({ error: hubCompatibilityMessage(status), code: status.code, hub_compatibility: status });
    const view = await hub.get(job_id, wait_seconds).catch((e) => ({ error: e.message }));
    return text(projectWorkflowView(view, { detail, afterSequence: after_sequence }));
  }
  if (!getJob(job_id)) return text({ error: `no such job: ${job_id} (expected a wf- workflow id)` });
  const job = await waitJob(job_id, wait_seconds > 0 ? wait_seconds * 1000 : 1);
  return text(projectWorkflowView(jobView(job, { withResult: true }), { detail, afterSequence: after_sequence }));
});

server.registerTool('dsh_worker_cancel', {
  title: 'Cancel DSH worker',
  description: 'Cancel a worker workflow (stops the active attempt, never starts escalation/review, releases its worktree). Accepts workflow ids (wf-...), Hub attempt ids (hub-...) and legacy standalone ids (job-...).',
  inputSchema: { job_id: z.string(), detail: detailSchema },
}, async ({ job_id, detail }) => {
  if (job_id.startsWith('wf-')) {
    const view = await workflowRuntime.cancel(job_id);
    if (!view) return text({ error: `no such workflow: ${job_id}` });
    return text({ ...projectWorkflowView(view, { detail }), note: 'cancelled' });
  }
  if (job_id.startsWith('hub-')) {
    const status = await hubStatus();
    if (!status.compatible) return text({ error: hubCompatibilityMessage(status), code: status.code, hub_compatibility: status });
    const view = await hub.cancel(job_id).catch((e) => ({ error: e.message }));
    return text(projectWorkflowView(view, { detail }));
  }
  if (!getJob(job_id)) return text({ error: `no such job: ${job_id} (expected a wf- workflow id)` });
  return text(projectWorkflowView(jobView(await cancelJob(job_id), { withResult: true }), { detail }));
});

await server.connect(new StdioServerTransport());
