// MCP stdio server exposing the DSH worker pool to Claude Code / Codex.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startJob, waitJob, cancelJob, listJobs, getJob, jobView } from './jobs.mjs';
import { hubAvailable, hub } from './hub-client.mjs';
import { resolveWorkerModel } from './model-routing.mjs';
import {
  normalizeGlobalConfig,
  deriveLegacyConfig,
  getEffectiveTierState,
  getRoutingGuidance,
  chooseDefaultTier,
  canEscalateFlashToPro,
  shouldRunProReview,
  canDispatchRole,
  resolveRoleTierHint,
} from './policy.mjs';

const server = new McpServer({ name: 'dsh-crew', version: '0.2.0' });

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
const globalConfig = normalizeGlobalConfig(readGlobalConfig());
const legacyDefaults = deriveLegacyConfig(globalConfig);
const sessionConfig = {
  enabled: true,
  default_tier: legacyDefaults.default_tier,
  default_effort: legacyDefaults.default_effort,
  mode: legacyDefaults.mode, // auto | hub | standalone
  default_timeout_seconds: legacyDefaults.default_timeout_seconds,
  // Session-level hard clamp (auto | flash-only | pro-only). Starts unset so
  // the global collaboration mode drives the policy; explicit session
  // tier_policy always wins while set.
  tier_policy: undefined,
  escalate_on_failure: legacyDefaults.escalate_on_failure,
  preset_flash: legacyDefaults.preset_flash ?? 'default',
  preset_pro: legacyDefaults.preset_pro ?? 'default',
  // Session overrides for the configurable-crew fields (undefined = global).
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

// Which orchestrator spawned this MCP server — stamped on every job so the
// panel can show where a dispatch came from.
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

/** Policy rejection rendered for the orchestrator, with a stable error code. */
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
  if (sessionConfig.mode === 'standalone') return 'standalone';
  const up = await hubAvailable();
  if (sessionConfig.mode === 'hub' && !up) throw new Error('session mode is "hub" but the DSH workers hub is not reachable');
  return up ? 'hub' : 'standalone';
}

/** Review-only task for the automatic Pro review (Review Pipeline / pro_reviews_flash). */
function buildReviewTask(task, implementation) {
  const resultText = String(implementation?.result ?? '').slice(0, 4000);
  return [
    'You are the automatic Pro review of a completed Flash implementation. REVIEW ONLY: inspect the current workspace and diff, and report findings. Do NOT modify any files unless the user explicitly asks for fixes.',
    '',
    'Original task:',
    task,
    '',
    'Flash implementation summary:',
    resultText === '' ? '(no summary; inspect the workspace directly)' : resultText,
    '',
    'Report: 1) does the implementation satisfy the task, 2) concrete issues (bugs, style, risks), 3) suggested fixes. Be concise. Use the review Delivery Report format appended below (## Review Findings / ## Evidence / ## Risks / ## Verdict).',
  ].join('\n');
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
  },
}, async ({ task, role, tier, legacy_tier, effort, cwd, timeout_seconds }) => {
  if (!sessionConfig.enabled) return dispatchDisabled();
  // Role+legacy-tier bridging: role is the v0.2 gate, tier/legacy_tier remain
  // the v0.1 model-class hint. A contradictory pair is a hard error, never a
  // silent guess. Callers that only pass tier keep the exact legacy behavior.
  const hint = resolveRoleTierHint(role, legacy_tier ?? tier);
  if (!hint.ok) return text({ error: hint.error, code: hint.code, note: 'Resolve the conflict on the caller side: pass only role, or only tier.' });
  let effRole = hint.role;
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

  const runOnce = async (t, r, jobTask, extra = {}) => {
    const common = { task: jobTask, tier: t, role: r, effort: e, cwd: workDir, source: ORCHESTRATOR, preset: presetForTier(t), ...extra };
    if ((await resolveMode()) === 'hub') {
      const spawned = await hub.spawn(common);
      return await hub.get(spawned.id, timeout);
    }
    const job = startJob({ ...common, timeoutMs: timeout * 1000 });
    await waitJob(job.id, timeout * 1000);
    return jobView(job, { withResult: true });
  };

  const firstRole = effRole;
  let job = await runOnce(effTier, firstRole, task);
  if (job.status === 'running') return text({ ...job, note: `still running after ${timeout}s; poll with dsh_worker_result` });

  // Escalate on evidence, not prediction: a failed worker run retries once
  // with the stronger model-class candidates — but only when the legacy
  // policy says Pro is an Auto tier (keeps v0.1 setups unchanged).
  if (job.status === 'failed' && firstRole === 'worker' && canEscalateFlashToPro(globalConfig, sessionConfig)) {
    const firstError = job.error ?? job.stopReason ?? 'unknown failure';
    job = await runOnce('pro', 'worker', task, { attempt: 1 });
    if (job.status === 'running') return text({ ...job, escalated: true, note: `escalated, still running after ${timeout}s; poll with dsh_worker_result` });
    return text({ ...job, escalated: true, flash_failure: String(firstError).slice(0, 200) });
  }

  // Automatic reviewer pass (blocking only): Review Pipeline mode, or an
  // explicit pro_reviews_flash opt-in. Runs at most once after a successful
  // worker implementation, and only when the reviewer role is Auto.
  if (job.status === 'done' && firstRole === 'worker' && shouldRunProReview(globalConfig, sessionConfig)) {
    const implementation = job;
    const review = await runOnce('pro', 'reviewer', buildReviewTask(task, implementation), { delivery: 'review' });
    const combo = { phase: 'review', implementation, review };
    if (review.status === 'running') {
      return text({ ...combo, status: 'running', note: `reviewer still running after ${timeout}s; poll with dsh_worker_result` });
    }
    if (review.status === 'done') return text({ ...combo, status: 'done', review_status: 'done' });
    // A failed review does not fail the implementation: surface both and let
    // the orchestrator decide.
    return text({ ...combo, status: 'done', review_status: 'failed', note: 'implementation succeeded; the automatic reviewer pass failed — decide whether to review manually.' });
  }

  return text(job);
});

server.registerTool('dsh_worker_config', {
  title: 'Session worker configuration',
  description: 'Read or update session-level worker settings: enable/disable dispatch, default tier/effort/timeout, execution mode, tier policy, escalation, collaboration mode, per-tier state and review behavior. Call with no arguments to read the current configuration (global defaults, session overrides, effective policy, routing guidance). Settings last for this session only.',
  inputSchema: {
    enabled: z.boolean().optional().describe('false = refuse all worker dispatch this session'),
    default_tier: z.enum(['flash', 'pro']).optional(),
    default_effort: z.enum(['off', 'high', 'max']).optional(),
    mode: z.enum(['auto', 'hub', 'standalone']).optional(),
    default_timeout_seconds: z.number().int().positive().max(7200).optional(),
    tier_policy: z.enum(['auto', 'flash-only', 'pro-only']).optional().describe('session hard clamp: flash-only / pro-only pin every dispatch to one tier'),
    escalate_on_failure: z.boolean().optional().describe('retry a failed blocking flash run once on pro (only when pro is an Auto tier)'),
    preset_flash: z.string().optional().describe('hub-mode agent preset for flash workers (preset id, or "default")'),
    preset_pro: z.string().optional().describe('hub-mode agent preset for pro workers (preset id, or "default")'),
    collaboration_mode: z.enum(['flash-only', 'pro-only', 'balanced', 'review-pipeline', 'custom']).optional().describe('session override of the global collaboration mode'),
    main_agent_mode: z.enum(['direct-allowed', 'coordinator-first', 'dispatcher-only']).optional().describe('session override of the host routing guidance'),
    flash_state: z.enum(['disabled', 'manual', 'auto']).optional().describe('session override of the flash tier state (custom mode)'),
    pro_state: z.enum(['disabled', 'manual', 'auto']).optional().describe('session override of the pro tier state (custom mode)'),
    pro_reviews_flash: z.boolean().optional().describe('follow a successful blocking flash run with one automatic pro review'),
    reset: z.boolean().optional().describe('true = restore all defaults first'),
  },
}, async ({ reset, ...patch }) => {
  if (reset) resetSessionConfig();
  // Legacy escape hatch: tier_policy=auto used to remove a global
  // flash-only/pro-only clamp for this session. The new equivalent is the
  // balanced collaboration preset, so map it — explicit flash-only/pro-only
  // keep their session-clamp meaning.
  if (patch.tier_policy === 'auto') {
    sessionConfig.tier_policy = undefined;
    sessionConfig.collaboration_mode = 'balanced';
    delete patch.tier_policy;
  }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) sessionConfig[k] = v;
  return text(await buildConfigReport());
});

// Global config fields safe to echo to the orchestrator. custom_providers and
// extra_models are excluded: they can carry API keys.
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
  // Tier policy remains a session-start snapshot by design, but Hub model
  // priorities are resolved live on every spawn. Re-read only those global
  // routing fields so this report matches what the Hub will actually use.
  const currentGlobalConfig = normalizeGlobalConfig(readGlobalConfig());
  const legacy = deriveLegacyConfig(globalConfig);
  const flashState = getEffectiveTierState(globalConfig, 'flash', sessionConfig);
  const proState = getEffectiveTierState(globalConfig, 'pro', sessionConfig);
  const defaultDecision = chooseDefaultTier(globalConfig, undefined, sessionConfig);
  const overrides = {};
  for (const [k, v] of Object.entries(sessionConfig)) if (v !== undefined) overrides[k] = v;
  const collaborationMode = sessionConfig.collaboration_mode ?? globalConfig.collaboration_mode;
  const mainAgentMode = sessionConfig.main_agent_mode ?? globalConfig.main_agent_mode;
  // Worker model routing: the Hub catalog contains public ids/names only.
  // Resolve both tiers independently so Harness Default is never mislabeled
  // as the effective worker provider when a priority overrides it.
  let effectiveWorkerProvider = null;
  let effectiveWorkerSelection = { flash: null, pro: null };
  let providerResolutionError;
  const workerProviderMode = currentGlobalConfig.worker_provider_mode ?? 'deepseek-official';
  if (workerProviderMode === 'deepseek-official') {
    effectiveWorkerSelection = {
      flash: { provider: 'deepseek-official', model: 'deepseek-v4-flash', source: 'legacy-strict' },
      pro: { provider: 'deepseek-official', model: 'deepseek-v4-pro', source: 'legacy-strict' },
    };
  } else if (await hubAvailable()) {
    try {
      const res = await fetch(`${globalConfig.hub_url}/_dsh/dsh-crew/models`);
      const body = await res.json();
      if (!body?.ok) providerResolutionError = body?.error ?? 'Unable to read Harness model catalog.';
      else for (const tier of ['flash', 'pro']) {
        const selected = resolveWorkerModel({
          tier,
          priority: currentGlobalConfig[`${tier}_model_priority`],
          priorityConfigured: currentGlobalConfig[`${tier}_model_priority_configured`],
          fallback: currentGlobalConfig[`${tier}_model_fallback`],
          catalog: body,
          harnessDefault: body.harness_default,
        });
        effectiveWorkerSelection[tier] = selected.ok
          ? { provider: selected.provider, model: selected.model, source: selected.source }
          : { code: selected.code, error: selected.message };
      }
    } catch (err) { providerResolutionError = err?.message ?? String(err); }
  }
  effectiveWorkerProvider = effectiveWorkerSelection.flash?.provider ?? null;
  return {
    // Effective session values (flat shape keeps /dsh-config tables working).
    enabled: sessionConfig.enabled,
    default_tier: sessionConfig.default_tier ?? legacy.default_tier,
    default_effort: sessionConfig.default_effort ?? legacy.default_effort,
    mode: sessionConfig.mode ?? legacy.mode,
    default_timeout_seconds: sessionConfig.default_timeout_seconds ?? legacy.default_timeout_seconds,
    // Legacy tier_policy clamp (session level, highest priority when set).
    tier_policy: sessionConfig.tier_policy ?? legacy.tier_policy,
    escalate_on_failure: sessionConfig.escalate_on_failure ?? legacy.escalate_on_failure,
    preset_flash: sessionConfig.preset_flash ?? legacy.preset_flash,
    preset_pro: sessionConfig.preset_pro ?? legacy.preset_pro,
    // Worker provider routing.
    worker_provider_mode: workerProviderMode,
    effective_worker_provider: effectiveWorkerProvider,
    effective_worker_selection: effectiveWorkerSelection,
    provider_resolution_error: providerResolutionError,
    flash_model_priority: currentGlobalConfig.flash_model_priority ?? [],
    flash_model_fallback: currentGlobalConfig.flash_model_fallback ?? 'harness-default',
    pro_model_priority: currentGlobalConfig.pro_model_priority ?? [],
    pro_model_fallback: currentGlobalConfig.pro_model_fallback ?? 'harness-default',
    // Configurable-crew effective policy.
    subagents_enabled: sessionConfig.enabled !== false && globalConfig.subagents_enabled !== false,
    collaboration_mode: collaborationMode,
    main_agent_mode: mainAgentMode,
    flash_state: flashState,
    pro_state: proState,
    flash_roles: globalConfig.flash_roles ?? [],
    pro_roles: globalConfig.pro_roles ?? [],
    pro_reviews_flash: sessionConfig.pro_reviews_flash ?? shouldRunProReview(globalConfig, sessionConfig),
    // One-line effective summary for the orchestrator, plus the authoritative
    // routing guidance. legacy_source shows whether a session tier_policy
    // clamp or the global collaboration mode is driving the decision.
    effective_policy: `mode=${collaborationMode} flash=${flashState} pro=${proState} subagents=${sessionConfig.enabled !== false && globalConfig.subagents_enabled !== false}`,
    legacy_source: sessionConfig.tier_policy !== undefined
      ? `session tier_policy clamp (${sessionConfig.tier_policy})`
      : `global collaboration mode (${collaborationMode})`,
    effective_default_tier: defaultDecision.ok ? defaultDecision.tier : null,
    effective_default_tier_reason: defaultDecision.ok ? defaultDecision.guidance : (defaultDecision.error.policyCode ?? 'none'),
    routing_guidance: getRoutingGuidance(globalConfig, sessionConfig),
    session_overrides: overrides,
    global_defaults: Object.fromEntries(SAFE_GLOBAL_KEYS.map((k) => [k, currentGlobalConfig[k]])),
    hub_reachable: await hubAvailable(),
  };
}

server.registerTool('dsh_spawn_worker', {
  title: 'Spawn DSH worker (async)',
  description: 'Start a DSH (DeepSeek Harness) coding agent in the background and return immediately with a job id. Use dsh_worker_status / dsh_worker_result to follow up. Good for fanning out several workers in parallel. Role policy is enforced exactly like dsh_run_worker; the automatic reviewer pass is not chained for async jobs (request a review explicitly if needed).',
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
  // Same resolver as dsh_run_worker: async dispatch must never start work a
  // blocking path would refuse (role gate AND legacy tier gate both enforced).
  const hint = resolveRoleTierHint(role, legacy_tier ?? tier);
  if (!hint.ok) return text({ error: hint.error, code: hint.code, note: 'Resolve the conflict on the caller side: pass only role, or only tier.' });
  let decision;
  let effTier;
  if (role === undefined) {
    decision = chooseDefaultTier(globalConfig, legacy_tier ?? tier, sessionConfig);
    if (!decision.ok) return policyRejection(decision);
    effTier = decision.tier;
  } else {
    decision = canDispatchRole(globalConfig, hint.role, true, sessionConfig);
    if (!decision.ok) return policyRejection(decision);
    if (hint.role === 'reviewer') effTier = 'pro';
    else if (legacy_tier !== undefined) effTier = legacy_tier;
    else if (tier !== undefined) effTier = tier;
    else { const slot = chooseDefaultTier(globalConfig, undefined, sessionConfig); effTier = slot.ok ? slot.tier : 'flash'; }
  }
  const workDir = cwd ?? process.cwd();
  const e = effort ?? sessionConfig.default_effort;
  const common = { task, role: hint.role, tier: effTier, effort: e, cwd: workDir, source: ORCHESTRATOR, preset: presetForTier(effTier) };
  if ((await resolveMode()) === 'hub') return text(await hub.spawn(common));
  const job = startJob(common);
  return text(jobView(job));
});

server.registerTool('dsh_worker_status', {
  title: 'DSH worker status',
  description: 'List all DSH worker jobs in this session with live progress (turn/step, current tool, token usage).',
  inputSchema: {},
}, async () => {
  const local = listJobs().map((j) => jobView(j));
  const remote = (await hubAvailable()) ? await hub.list().catch(() => []) : [];
  return text([...remote, ...local]);
});

server.registerTool('dsh_worker_result', {
  title: 'DSH worker result',
  description: 'Fetch the result of a worker job, optionally waiting for it to finish.',
  inputSchema: {
    job_id: z.string(),
    wait_seconds: z.number().int().min(0).max(7200).default(0).describe('0 = return current state immediately'),
  },
}, async ({ job_id, wait_seconds }) => {
  if (job_id.startsWith('hub-')) {
    if (!(await hubAvailable())) return text({ error: 'hub not reachable' });
    return text(await hub.get(job_id, wait_seconds).catch((e) => ({ error: e.message })));
  }
  if (!getJob(job_id)) return text({ error: `no such job: ${job_id}` });
  const job = await waitJob(job_id, wait_seconds > 0 ? wait_seconds * 1000 : 1);
  return text(jobView(job, { withResult: true }));
});

server.registerTool('dsh_worker_cancel', {
  title: 'Cancel DSH worker',
  description: 'Cancel a running worker job (terminates its runtime process).',
  inputSchema: { job_id: z.string() },
}, async ({ job_id }) => {
  if (job_id.startsWith('hub-')) {
    if (!(await hubAvailable())) return text({ error: 'hub not reachable' });
    return text(await hub.cancel(job_id).catch((e) => ({ error: e.message })));
  }
  if (!getJob(job_id)) return text({ error: `no such job: ${job_id}` });
  return text(jobView(await cancelJob(job_id), { withResult: true }));
});

await server.connect(new StdioServerTransport());
