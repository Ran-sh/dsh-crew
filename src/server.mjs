// MCP stdio server exposing the DSH worker pool to Claude Code / Codex.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startJob, waitJob, cancelJob, listJobs, getJob, jobView } from './jobs.mjs';
import { hubStatus, hub } from './hub-client.mjs';
import { hubCompatibilityMessage, resolveHubExecutionMode } from './hub-compatibility.mjs';
import { RUNTIME_VERSION } from './runtime-identity.mjs';
import { resolveWorkerModel } from './model-routing.mjs';
import { runtimeActivationMetadata } from './runtime-controls.mjs';
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

const server = new McpServer({ name: 'dsh-crew', version: RUNTIME_VERSION });

const tierSchema = z.enum(['flash', 'pro']).optional().describe('Legacy worker tier (compatibility only): Flash/Pro now act as a model-class hint, not a role. Prefer role=worker / role=reviewer; the backend resolves the actual provider/model from the Model Policy.');
const roleSchema = z.enum(['worker', 'reviewer']).optional().describe('Dispatch role: worker executes implementation / fixes / tests / search; reviewer independently reviews a completed implementation. A coding request defaults to worker; reviewer runs on explicit request or via the automatic review workflow.');
const effortSchema = z.enum(['off', 'high', 'max']).optional().describe('Reasoning effort for the worker. Omit to use the session default.');

// Session-level configuration. This MCP server process lives exactly as long
// as one Claude Code / Codex session, so plain memory IS session scope.
// Initial values come from the global config (~/.config/dsh-crew/config.json,
// edited on the DSH settings page); dsh_worker_config overrides per session.
// All dispatch decisions (dsh_run_worker AND dsh_spawn_worker, hub AND
// standalone) go through the same policy resolver in src/policy.mjs.
import { readGlobalConfig } from './install/install.mjs';
const initialGlobalConfig = normalizeGlobalConfig(readGlobalConfig());
const legacyDefaults = deriveLegacyConfig(initialGlobalConfig);
const currentGlobalConfig = () => normalizeGlobalConfig(readGlobalConfig());
const sessionConfig = {
  enabled: true,
  default_tier: legacyDefaults.default_tier,
  default_effort: legacyDefaults.default_effort,
  mode: legacyDefaults.mode, // auto | hub | standalone
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
    mode: legacyDefaults.mode,
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
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

function detectOrchestrator() {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  try {
    const { execSync } = require('node:child_process');
    const comm = execSync(`ps -o comm= -p ${process.ppid}`, { encoding: 'utf8' }).trim().toLowerCase();
    if (comm.includes('claude')) return 'claude-code';
    if (comm.includes('codex')) return 'codex';
    return comm.split('/').pop() || 'unknown';
  } catch { return 'unknown'; }
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
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
  const decision = resolveHubExecutionMode(sessionConfig.mode, status);
  if (!decision.ok) {
    throw Object.assign(new Error(decision.error), {
      code: decision.code,
      hubStatus: status,
    });
  }
  return decision.mode;
}

/** Reviewer prompt built only from structured outcome + sanitized candidate. */
function buildReviewTask(task, view) {
  const parts = [
    'You are the automatic reviewer of a completed worker implementation. REVIEW ONLY: inspect the candidate and report findings. Do NOT modify any files unless the user explicitly asks for fixes.',
    '',
    'Original task:',
    task,
  ];
  const o = view?.outcome;
  if (o) {
    parts.push('', 'Worker outcome:');
    parts.push(`task_status=${o.task_status} tests_status=${o.tests_status ?? 'none'} delivery=${o.delivery?.complete ? 'complete' : 'incomplete'}`);
  }
  const c = view?.candidate;
  if (c) {
    parts.push('', 'Candidate changed files:', Array.isArray(c.changed_files) && c.changed_files.length ? c.changed_files.join('\n') : '(none)');
    if (c.base_revision) parts.push(`Base revision: ${c.base_revision}`);
    if (c.patch) parts.push('', 'Candidate patch (sanitized):', String(c.patch).slice(0, 8000));
  }
  parts.push('', 'Report: 1) does the implementation satisfy the task, 2) concrete issues (bugs, style, risks), 3) suggested fixes. End your message with ## Review Findings / ## Evidence / ## Risks / ## Verdict (approved | needs changes | rejected).');
  return parts.join('\n');
}

const workflowRuntime = buildMcpWorkflowRuntime({
  getSessionConfig: () => sessionConfig,
  resolveMode,
  presetForTier,
  readGlobalConfig,
  buildReviewTask,
  attemptTimeoutMs: () => (sessionConfig.default_timeout_seconds ?? 1800) * 1000,
});

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
  },
}, async ({ task, role, tier, legacy_tier, effort, cwd, timeout_seconds }) => {
  if (!sessionConfig.enabled) return dispatchDisabled();
  const globalConfig = currentGlobalConfig();
  const hint = resolveRoleTierHint(role, legacy_tier ?? tier);
  if (!hint.ok) return text({ error: hint.error, code: hint.code, note: 'Resolve the conflict on the caller side: pass only role, or only tier.' });
  const effRole = hint.role;
  let effTier;
  let decision;
  if (role === undefined) {
    decision = chooseDefaultTier(globalConfig, legacy_tier ?? tier, sessionConfig);
    if (!decision.ok) return policyRejection(decision);
    effTier = decision.tier;
  } else {
    decision = canDispatchRole(globalConfig, effRole, true, sessionConfig);
    if (!decision.ok) return policyRejection(decision);
    if (effRole === 'reviewer') effTier = 'pro';
    else if (legacy_tier !== undefined) effTier = legacy_tier;
    else if (tier !== undefined) effTier = tier;
    else { const slot = chooseDefaultTier(globalConfig, undefined, sessionConfig); effTier = slot.ok ? slot.tier : 'flash'; }
  }
  const workDir = cwd ?? process.cwd();
  const e = effort ?? sessionConfig.default_effort;
  const timeout = timeout_seconds ?? sessionConfig.default_timeout_seconds;

  const spec = {
    role: effRole,
    delivery: effRole === 'reviewer' ? 'review' : 'coding',
    model_class_hint: effTier,
    task,
    cwd: workDir,
    effort: e,
    source: ORCHESTRATOR,
  };
  const wf = workflowRuntime.start(spec);
  await workflowRuntime.wait(wf.id, timeout * 1000);
  const view = workflowRuntime.get(wf.id, { withResult: true });
  if (view.status === 'running') {
    return text({ ...view, note: `still running after ${timeout}s; poll with dsh_worker_result`, status: 'running' });
  }
  if (view.phase === 'failed') {
    return text({ ...view, note: 'workflow failed — see error / error_code.', status: 'failed' });
  }
  return text({ ...view, note: effRole === 'reviewer' ? 'review complete' : 'workflow complete' });
});

server.registerTool('dsh_worker_config', {
  title: 'Session worker configuration',
  description: 'Read or update session-level worker settings: enable/disable dispatch, default tier/effort/timeout, execution mode, tier policy, escalation, collaboration mode, per-tier state and review behavior. Call with no arguments to read the current configuration, runtime control state, activation boundaries, global defaults, session overrides, effective policy and routing guidance. Settings last for this session only.',
  inputSchema: {
    enabled: z.boolean().optional().describe('false = refuse all worker dispatch this session'),
    default_tier: z.enum(['flash', 'pro']).optional(),
    default_effort: z.enum(['off', 'high', 'max']).optional(),
    mode: z.enum(['auto', 'hub', 'standalone']).optional(),
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
  const workerProviderMode = globalConfig.worker_provider_mode ?? 'deepseek-official';
  if (workerProviderMode === 'deepseek-official') {
    effectiveWorkerSelection = {
      flash: { provider: 'deepseek-official', model: 'deepseek-v4-flash', source: 'legacy-strict' },
      pro: { provider: 'deepseek-official', model: 'deepseek-v4-pro', source: 'legacy-strict' },
    };
  } else if (hubCompatibility.compatible) {
    try {
      const res = await fetch(`${globalConfig.hub_url}/_dsh/dsh-crew/models`);
      const body = await res.json();
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
    } catch (err) { providerResolutionError = err?.message ?? String(err); }
  } else if (hubCompatibility.reachable) {
    providerResolutionError = hubCompatibilityMessage(hubCompatibility);
  }
  effectiveWorkerProvider = effectiveWorkerSelection.flash?.provider ?? null;
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
  },
}, async ({ task, role, tier, legacy_tier, effort, cwd }) => {
  if (!sessionConfig.enabled) return dispatchDisabled();
  const globalConfig = currentGlobalConfig();
  const hint = resolveRoleTierHint(role, legacy_tier ?? tier);
  if (!hint.ok) return text({ error: hint.error, code: hint.code, note: 'Resolve the conflict on the caller side: pass only role, or only tier.' });
  const effRole = hint.role;
  let effTier;
  let decision;
  if (role === undefined) {
    decision = chooseDefaultTier(globalConfig, legacy_tier ?? tier, sessionConfig);
    if (!decision.ok) return policyRejection(decision);
    effTier = decision.tier;
  } else {
    decision = canDispatchRole(globalConfig, effRole, true, sessionConfig);
    if (!decision.ok) return policyRejection(decision);
    if (effRole === 'reviewer') effTier = 'pro';
    else if (legacy_tier !== undefined) effTier = legacy_tier;
    else if (tier !== undefined) effTier = tier;
    else { const slot = chooseDefaultTier(globalConfig, undefined, sessionConfig); effTier = slot.ok ? slot.tier : 'flash'; }
  }
  const workDir = cwd ?? process.cwd();
  const e = effort ?? sessionConfig.default_effort;
  const spec = {
    role: effRole,
    delivery: effRole === 'reviewer' ? 'review' : 'coding',
    model_class_hint: effTier,
    task,
    cwd: workDir,
    effort: e,
    source: ORCHESTRATOR,
  };
  const wf = workflowRuntime.start(spec);
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
  },
}, async ({ job_id, wait_seconds }) => {
  if (job_id.startsWith('wf-')) {
    if (wait_seconds > 0) await workflowRuntime.wait(job_id, wait_seconds * 1000);
    const view = workflowRuntime.get(job_id, { withResult: true });
    if (!view) return text({ error: `no such workflow: ${job_id}` });
    return text(view);
  }
  if (job_id.startsWith('hub-')) {
    const status = await hubStatus();
    if (!status.compatible) return text({ error: hubCompatibilityMessage(status), code: status.code, hub_compatibility: status });
    return text(await hub.get(job_id, wait_seconds).catch((e) => ({ error: e.message })));
  }
  if (!getJob(job_id)) return text({ error: `no such job: ${job_id} (expected a wf- workflow id)` });
  const job = await waitJob(job_id, wait_seconds > 0 ? wait_seconds * 1000 : 1);
  return text(jobView(job, { withResult: true }));
});

server.registerTool('dsh_worker_cancel', {
  title: 'Cancel DSH worker',
  description: 'Cancel a worker workflow (stops the active attempt, never starts escalation/review, releases its worktree). Accepts workflow ids (wf-...), Hub attempt ids (hub-...) and legacy standalone ids (job-...).',
  inputSchema: { job_id: z.string() },
}, async ({ job_id }) => {
  if (job_id.startsWith('wf-')) {
    const view = await workflowRuntime.cancel(job_id);
    if (!view) return text({ error: `no such workflow: ${job_id}` });
    return text({ ...view, note: 'cancelled' });
  }
  if (job_id.startsWith('hub-')) {
    const status = await hubStatus();
    if (!status.compatible) return text({ error: hubCompatibilityMessage(status), code: status.code, hub_compatibility: status });
    return text(await hub.cancel(job_id).catch((e) => ({ error: e.message })));
  }
  if (!getJob(job_id)) return text({ error: `no such job: ${job_id} (expected a wf- workflow id)` });
  return text(jobView(await cancelJob(job_id), { withResult: true }));
});

await server.connect(new StdioServerTransport());
