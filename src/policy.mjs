// Configurable-crew policy: pure normalization + routing decisions for the
// worker tier orchestration. No I/O, no worker runtime — everything here is a
// pure function so it can be unit-tested without starting DSH, a hub, or a
// worker process.
//
// Two config layers feed this module:
//   - global: ~/.config/dsh-crew/config.json (Settings page)
//   - session: the per-session overrides managed by dsh_worker_config
//
// The hard-enforcement rule is deliberately small: a worker tier may only be
// dispatched when the *effective* policy marks it usable (enabled + auto, or
// explicitly requested when manual), and the effective policy is computed
// identically for dsh_run_worker, dsh_spawn_worker, hub and standalone paths.
//
// tier_policy (legacy, session level) remains the strongest clamp:
//   flash-only / pro-only pin every dispatch to one tier, whatever the global
//   collaboration mode says. Global tier_policy is only consulted when
//   migrating old configs; new decisions run on collaboration_mode + states.

import { normalizeModelPriority } from './model-routing.mjs';

export const TIER_STATES = ['disabled', 'manual', 'auto'];
export const COLLABORATION_MODES = ['flash-only', 'pro-only', 'balanced', 'review-pipeline', 'custom'];
export const MAIN_AGENT_MODES = ['direct-allowed', 'coordinator-first', 'dispatcher-only'];
export const ROLE_IDS = [
  'implementation',
  'simple_fix',
  'tests',
  'search_inspection',
  'architecture',
  'complex_debugging',
  'refactor',
  'code_review',
];

export const DEFAULT_FLASH_ROLES = ['implementation', 'simple_fix', 'tests', 'search_inspection'];
export const DEFAULT_PRO_ROLES = ['architecture', 'complex_debugging', 'refactor', 'code_review', 'implementation'];

export const POLICY_ERROR_CODES = {
  SUBAGENTS_DISABLED: 'SUBAGENTS_DISABLED',
  TIER_DISABLED: 'TIER_DISABLED',
  NO_AUTO_TIER: 'NO_AUTO_TIER',
  NO_WORKER_TIER: 'NO_WORKER_TIER',
  PRO_NOT_AUTO: 'PRO_NOT_AUTO',
  VISION_DISABLED: 'VISION_DISABLED',
  NO_DSH_PROVIDER_SELECTED: 'NO_DSH_PROVIDER_SELECTED',
  // v0.2 role-world errors. RE-CONFIG_REQUIRED for review dispatch that the
  // automatic review workflow refused; ROLE_TIER_CONFLICT for a request that
  // names both a role and an incompatible legacy tier.
  ROLE_DISABLED: 'ROLE_DISABLED',
  ROLE_NOT_AUTO: 'ROLE_NOT_AUTO',
  ROLE_TIER_CONFLICT: 'ROLE_TIER_CONFLICT',
};

export const POLICY_ERROR_MESSAGES = {
  [POLICY_ERROR_CODES.SUBAGENTS_DISABLED]:
    'DSH Crew worker dispatch is disabled.',
  [POLICY_ERROR_CODES.TIER_DISABLED]:
    'DeepSeek V4 {tier} worker is disabled by the current DSH Crew policy.',
  [POLICY_ERROR_CODES.NO_AUTO_TIER]:
    'No Auto worker tier is available. Enable Flash/Pro Auto, explicitly choose a Manual tier, or change Collaboration Mode.',
  [POLICY_ERROR_CODES.NO_WORKER_TIER]:
    'No DSH worker tier is enabled.',
  [POLICY_ERROR_CODES.PRO_NOT_AUTO]:
    'Automatic Flash→Pro escalation was skipped because Pro is Manual/Disabled.',
  [POLICY_ERROR_CODES.NO_DSH_PROVIDER_SELECTED]:
    'No DSH provider is selected for Hub workers. Select a provider in DSH Models or switch Worker Provider to DeepSeek Official.',
  [POLICY_ERROR_CODES.ROLE_DISABLED]:
    'DeepSeek {tier} role is disabled by the current DSH Crew policy.',
  [POLICY_ERROR_CODES.ROLE_NOT_AUTO]:
    'The {tier} role is not an Auto role; it runs only when explicitly requested.',
  [POLICY_ERROR_CODES.ROLE_TIER_CONFLICT]:
    'A request cannot name both a role and a legacy tier that contradict it: role={role} conflicts with tier={tier}.',
};

// ---------- v0.2 role abstraction (worker / reviewer) ----------
//
// v0.1 expressed every dispatch as a flash/pro *tier*: the tier doubled as
// both "who does the work" (role) and "which model class" (policy). v0.2
// separates the two:
//
//   - Role: worker (execute / fix / test / search) and reviewer (independent
//     review + verdict). A coding request defaults to worker; reviewer is
//     produced by the review workflow or an explicit request.
//   - Model Policy: which provider/model candidates back a role, with
//     preferred -> priority -> escalation -> Harness Default fallback.
//
// Flash / Pro survive only as legacy model-hint + config-migration concepts.
// Everything new here reads a canonical config shape produced by
// migrateLegacyConfig; the legacy collab/tier functions stay for compatibility.

export const DISPATCH_ROLES = ['worker', 'reviewer'];
export const ROLE_STATES = TIER_STATES; // disabled | manual | auto
export const ROLE_MODEL_STRATEGIES = ['economy', 'balanced', 'quality', 'strong'];
export const DEFAULT_WORKER_STRATEGY = 'balanced';
export const DEFAULT_REVIEWER_STRATEGY = 'strong';
export const DEFAULT_MAX_PARALLEL = 3;

export function normalizeRoleState(raw) {
  return normalizeState(raw);
}

export function normalizeIsolation(raw) {
  return raw === 'worktree' || raw === 'shared' ? raw : 'worktree';
}

function normalizeMaxParallel(raw) {
  const n = Number.isInteger(raw) ? raw : DEFAULT_MAX_PARALLEL;
  if (n < 1) return 1;
  if (n > 16) return 16;
  return n;
}

/**
 * Normalize one role's model policy into the canonical shape:
 * { role, strategy, priority, priorityConfigured, escalation_priority,
 *   escalation_priority_configured, fallback, escalation: { enabled, max_attempts } }.
 * Pure; unknown fields drop, empty priority falls back to the role default.
 */
export function normalizeModelPolicy(raw = {}) {
  return {
    role: raw.role === 'reviewer' ? 'reviewer' : 'worker',
    strategy: ROLE_MODEL_STRATEGIES.includes(raw.strategy)
      ? raw.strategy
      : (raw.role === 'reviewer' ? DEFAULT_REVIEWER_STRATEGY : DEFAULT_WORKER_STRATEGY),
    priority: normalizeModelPriority(raw.priority),
    priorityConfigured: raw.priorityConfigured === true,
    escalation_priority: normalizeModelPriority(raw.escalation_priority),
    escalation_priority_configured: raw.escalation_priority_configured === true,
    fallback: raw.fallback === 'harness-default' ? 'harness-default' : 'harness-default',
    escalation: {
      enabled: normalizeBool(raw.escalation?.enabled, false),
      max_attempts: Number.isInteger(raw.escalation?.max_attempts) && raw.escalation.max_attempts > 0
        ? Math.min(raw.escalation.max_attempts, 5)
        : 2,
    },
  };
}

function deriveCollaboration(raw) {
  if (COLLABORATION_MODES.includes(raw.collaboration_mode)) return raw.collaboration_mode;
  if (raw.tier_policy === 'flash-only') return 'flash-only';
  if (raw.tier_policy === 'pro-only') return 'pro-only';
  return 'balanced';
}

function deriveTierState(raw, tier) {
  if (TIER_STATES.includes(raw[`${tier}_state`])) return raw[`${tier}_state`];
  if (raw.tier_policy === 'flash-only') return tier === 'flash' ? 'auto' : 'disabled';
  if (raw.tier_policy === 'pro-only') return tier === 'pro' ? 'auto' : 'disabled';
  return 'auto';
}

function migrationWorkerState(collab, flashState, proState) {
  if (collab === 'pro-only') return proState === 'disabled' ? 'disabled' : 'auto';
  if (collab === 'flash-only') return flashState === 'disabled' ? 'disabled' : 'auto';
  // balanced / review-pipeline / custom: worker is the default coding entry.
  if (flashState === 'disabled' && proState === 'disabled') return 'disabled';
  if (flashState === 'manual' && proState === 'manual') return 'manual';
  if (flashState === 'manual') return 'manual';
  return 'auto';
}

function migrationReviewState(collab, proState, autoReview) {
  if (collab === 'review-pipeline') return 'auto';
  if (collab === 'pro-only' || collab === 'flash-only') return 'disabled';
  if (autoReview) return proState === 'disabled' ? 'disabled' : 'auto';
  // balanced / custom: the reviewer is available on request while the strong
  // (pro) model class is an Auto tier; otherwise it stays disabled.
  return proState === 'auto' ? 'manual' : 'disabled';
}

/**
 * Centralized v0.1 → v0.2 config migration. Pure and single-source: converts
 * any legacy (or partially canonical) config into the canonical worker /
 * reviewer / execution shape the role helpers consume. Never reads
 * credentials, never touches provider selection directly, never writes.
 */
export function migrateLegacyConfig(raw = {}) {
  const collab = deriveCollaboration(raw);
  const flashState = deriveTierState(raw, 'flash');
  const proState = deriveTierState(raw, 'pro');
  const escalationEnabled = normalizeBool(raw.escalate_on_failure, false)
    || normalizeBool(raw.worker?.model_policy?.escalation?.enabled, false);
  const autoReview = collab === 'review-pipeline'
    || normalizeBool(raw.pro_reviews_flash, false)
    || normalizeBool(raw.review?.auto_review, false);

  const worker = {
    state: migrationWorkerState(collab, flashState, proState),
    provider_mode: normalizeWorkerProviderMode(raw.worker_provider_mode ?? raw.worker?.provider_mode),
    model_policy: normalizeModelPolicy({
      role: 'worker',
      strategy: collab === 'pro-only' ? 'quality' : collab === 'flash-only' ? 'economy' : 'balanced',
      priority: raw.flash_model_priority ?? raw.worker?.model_policy?.priority,
      priorityConfigured: raw.flash_model_priority_configured === true || raw.worker?.model_policy?.priorityConfigured === true,
      escalation_priority: raw.pro_model_priority ?? raw.worker?.model_policy?.escalation_priority,
      escalation_priority_configured: raw.pro_model_priority_configured === true || raw.worker?.model_policy?.escalation_priority_configured === true,
      fallback: 'harness-default',
      escalation: {
        enabled: escalationEnabled,
        max_attempts: raw.worker?.model_policy?.escalation?.max_attempts ?? 2,
      },
    }),
  };

  const review = {
    state: migrationReviewState(collab, proState, autoReview),
    mode: 'auto',
    auto_review: autoReview,
    provider_mode: normalizeWorkerProviderMode(raw.worker_provider_mode ?? raw.review?.provider_mode),
    model_policy: normalizeModelPolicy({
      role: 'reviewer',
      strategy: 'strong',
      priority: raw.pro_model_priority ?? raw.review?.model_policy?.priority,
      priorityConfigured: raw.pro_model_priority_configured === true || raw.review?.model_policy?.priorityConfigured === true,
      fallback: 'harness-default',
    }),
  };

  return {
    subagents_enabled: normalizeEnabled(raw.subagents_enabled),
    main_agent_mode: MAIN_AGENT_MODES.includes(raw.main_agent_mode) ? raw.main_agent_mode : 'coordinator-first',
    execution: {
      enabled: normalizeEnabled(raw.subagents_enabled),
      default_effort: ['off', 'high', 'max'].includes(raw.default_effort) ? raw.default_effort : 'max',
      default_timeout_seconds: Number.isInteger(raw.default_timeout_seconds) && raw.default_timeout_seconds > 0
        ? raw.default_timeout_seconds : 1800,
      mode: ['auto', 'hub', 'standalone'].includes(raw.mode) ? raw.mode : 'auto',
      max_parallel: normalizeMaxParallel(raw.execution?.max_parallel ?? raw.max_parallel),
      isolation: normalizeIsolation(raw.execution?.isolation ?? raw.isolation),
    },
    worker,
    review,
    // The legacy view is retained so config rounds-trips and old fields never
    // drop silently; it is explicitly marked legacy.
    legacy: {
      collaboration_mode: collab,
      flash_state: flashState,
      pro_state: proState,
      tier_policy: raw.tier_policy,
    },
  };
}

/** Canonical view of any config (legacy-normalized or already canonical). */
export function getCanonical(config = {}) {
  if (config?.worker && config?.review) {
    return {
      subagents_enabled: normalizeEnabled(config.subagents_enabled),
      main_agent_mode: MAIN_AGENT_MODES.includes(config.main_agent_mode) ? config.main_agent_mode : 'coordinator-first',
      execution: {
        enabled: normalizeEnabled(config.execution?.enabled ?? config.subagents_enabled),
        default_effort: ['off', 'high', 'max'].includes(config.execution?.default_effort) ? config.execution.default_effort : 'max',
        default_timeout_seconds: Number.isInteger(config.execution?.default_timeout_seconds) && config.execution.default_timeout_seconds > 0
          ? config.execution.default_timeout_seconds : 1800,
        mode: ['auto', 'hub', 'standalone'].includes(config.execution?.mode) ? config.execution.mode : 'auto',
        max_parallel: normalizeMaxParallel(config.execution?.max_parallel),
        isolation: normalizeIsolation(config.execution?.isolation),
      },
      worker: { ...config.worker, state: normalizeRoleState(config.worker.state), model_policy: normalizeModelPolicy(config.worker.model_policy) },
      review: { ...config.review, state: normalizeRoleState(config.review.state), model_policy: normalizeModelPolicy(config.review.model_policy) },
    };
  }
  return migrateLegacyConfig(config);
}

// ---------- v0.2 role helpers ----------

/**
 * Effective state of a dispatch role. Session `${role}_state` overrides the
 * canonical role state; absent canonical config falls back to the legacy
 * migration (so a stock v0.1 config drives the same gate it always did).
 */
export function getRoleState(config = {}, role = 'worker', session = {}) {
  const override = session[`${role}_state`];
  if (override === 'disabled' || override === 'manual' || override === 'auto') return override;
  const canon = getCanonical(config);
  if (role === 'reviewer') return canon.review.state ?? 'auto';
  return canon.worker.state ?? 'auto';
}

export function isRoleEnabled(config = {}, role = 'worker', session = {}) {
  return getRoleState(config, role, session) !== 'disabled';
}

export function isRoleAutoEligible(config = {}, role = 'worker', session = {}) {
  return getRoleState(config, role, session) === 'auto';
}

/**
 * Deterministic dispatch decision for one role. A disabled role refuses every
 * request; a manual role runs only when explicitly requested; an auto role is
 * callable automatically and on request.
 */
export function canDispatchRole(config = {}, role = 'worker', explicitRequest = false, session = {}) {
  if (session.enabled === false || config.subagents_enabled === false) {
    return { ok: false, error: policyError(POLICY_ERROR_CODES.SUBAGENTS_DISABLED) };
  }
  const state = getRoleState(config, role, session);
  if (state === 'disabled') return { ok: false, error: policyError(POLICY_ERROR_CODES.ROLE_DISABLED, { tier: role }) };
  if (state === 'manual' && !explicitRequest) {
    if (role === 'reviewer') return { ok: false, error: policyError(POLICY_ERROR_CODES.ROLE_NOT_AUTO, { tier: role }) };
    return { ok: false, error: policyError(POLICY_ERROR_CODES.NO_AUTO_TIER) };
  }
  return { ok: true, role, guidance: explicitRequest ? 'explicit request' : 'auto role' };
}

/**
 * Default role for a coding (or generic) request. The worker is the default
 * coding role; the reviewer is only reachable through an explicit request or
 * the review workflow. Mirrors the v0.1 chooseDefaultTier gate.
 */
export function chooseRole(config = {}, requestedRole, session = {}) {
  if (requestedRole === 'worker' || requestedRole === 'reviewer') {
    return canDispatchRole(config, requestedRole, true, session);
  }
  return canDispatchRole(config, 'worker', false, session);
}

/**
 * Bridge a role + legacy tier pair. reviewer pairs with no tier or tier=pro
 * (the strong benchmark slot); worker pairs with any tier (tier becomes a
 * model-class hint). A reviewer+flash pair is a hard conflict, never guessed.
 */
export function resolveRoleTierHint(role, legacyTier) {
  const wantsReviewer = role === 'reviewer';
  const wantsWorker = role === undefined || role === 'worker';
  if (wantsWorker && (legacyTier === undefined || legacyTier === 'flash' || legacyTier === 'pro')) {
    return { ok: true, role: 'worker', tier: legacyTier ?? 'flash' };
  }
  if (wantsReviewer && (legacyTier === undefined || legacyTier === 'pro')) {
    return { ok: true, role: 'reviewer', tier: 'pro' };
  }
  return {
    ok: false,
    code: POLICY_ERROR_CODES.ROLE_TIER_CONFLICT,
    error: POLICY_ERROR_MESSAGES[POLICY_ERROR_CODES.ROLE_TIER_CONFLICT]
      .replace('{role}', role === 'reviewer' ? 'reviewer' : 'worker')
      .replace('{tier}', legacyTier ?? '(none)'),
  };
}

/** Model policy for a role (canonical config or derived from legacy). */
export function resolveModelPolicy(config = {}, role = 'worker', context = {}) {
  const canon = getCanonical(config);
  const policy = role === 'reviewer' ? canon.review.model_policy : canon.worker.model_policy;
  return {
    within: role,
    role,
    ...policy,
    attempt: Number.isInteger(context?.attempt) ? context.attempt : 0,
  };
}

/** Should a successful worker run be followed by one automatic reviewer pass? */
export function shouldAutoReview(config = {}, session = {}) {
  const sessionOverride = session.auto_review;
  if (sessionOverride === true || sessionOverride === false) return sessionOverride;
  if (getRoleState(config, 'reviewer', session) !== 'auto') return false;
  const canon = getCanonical(config);
  return canon.review.auto_review === true;
}

/**
 * Decision about whether some evidence warrants another (stronger) worker
 * attempt. PR2 keeps the workflow-visible rules here as a pure function; PR1
 * uses it to centralize the legacy "escalate on failure" boolean so the
 * blocking path and future async path share one rule.
 */
export function evaluateAttempt({
  execution = 'completed',
  taskStatus = 'success',
  testsStatus,
  deliveryComplete = true,
  workspaceEvidenceOK = true,
  policy = {},
  attempt = 0,
} = {}) {
  const maxAttempts = policy?.escalation?.max_attempts ?? 2;
  const canEscalate = policy?.escalation?.enabled === true;
  // Clean verified path short-circuits: there is nothing to escalate.
  const clean = execution !== 'failed'
    && (taskStatus === 'success' || taskStatus === undefined)
    && testsStatus !== 'FAIL'
    && deliveryComplete === true
    && workspaceEvidenceOK !== false;
  if (clean) return { decision: 'accept', reason: 'verified', escalate: false };
  // Something needs attention. Escalation-disabled and max-attempts only stop
  // an up-grade, never turn a clean run into a failure.
  let reason;
  if (execution === 'failed') reason = 'execution_failed';
  else if (taskStatus === 'blocked') reason = 'task_blocked';
  else if (testsStatus === 'FAIL') reason = 'tests_failed';
  else if (deliveryComplete === false) reason = 'delivery_incomplete';
  else if (workspaceEvidenceOK === false) reason = 'workspace_mismatch';
  else if (taskStatus === 'partial') reason = 'task_partial';
  else reason = 'unverified';
  if (!canEscalate) return { decision: 'fail', reason: 'escalation_disabled', escalate: false };
  if (attempt >= maxAttempts) return { decision: 'fail', reason: 'max_attempts_reached', escalate: false };
  return { decision: 'escalate', reason, escalate: true };
}

// ---------- worker provider routing ----------

/**
 * Worker provider modes for Hub workers:
 *  - follow-dsh: use whatever provider is selected in DSH Models for the
 *    current session; the tier still maps to the DeepSeek V4 model slot.
 *  - deepseek-official: always use the built-in deepseek-official provider
 *    (the legacy behavior; also the safe default for upgraded configs).
 */
export const WORKER_PROVIDER_MODES = ['follow-dsh', 'deepseek-official'];
export const DEFAULT_WORKER_PROVIDER_MODE = 'deepseek-official';

export function normalizeWorkerProviderMode(raw) {
  return WORKER_PROVIDER_MODES.includes(raw) ? raw : DEFAULT_WORKER_PROVIDER_MODE;
}

/**
 * Resolve the provider for a Hub worker. Pure: `getCurrentSelection` (the DSH
 * agentDefaultModel accessor) is injected so tests can stub it, and no
 * credential ever flows through here.
 */
export function resolveHubWorkerProvider({ worker_provider_mode, getCurrentSelection }) {
  const mode = normalizeWorkerProviderMode(worker_provider_mode);
  if (mode === 'deepseek-official') return { ok: true, provider: 'deepseek-official', mode };
  const selection = typeof getCurrentSelection === 'function' ? getCurrentSelection() : undefined;
  const provider = selection?.provider;
  if (!provider) {
    return {
      ok: false,
      code: POLICY_ERROR_CODES.NO_DSH_PROVIDER_SELECTED,
      error: POLICY_ERROR_MESSAGES[POLICY_ERROR_CODES.NO_DSH_PROVIDER_SELECTED],
      mode,
    };
  }
  return { ok: true, provider, mode };
}

/** Structured policy error; `code` is machine-readable, `message` user-facing. */
export function policyError(code, extra = {}) {
  const base = POLICY_ERROR_MESSAGES[code] ?? code;
  return Object.assign(new Error(base.replace('{tier}', extra.tier ?? 'pro')), { policyCode: code });
}

// ---------- normalization ----------

function pickString(raw, fallback) {
  return typeof raw === 'string' && raw !== '' ? raw : fallback;
}

function normalizeState(raw) {
  const v = pickString(raw, 'auto');
  return TIER_STATES.includes(v) ? v : 'auto';
}

function normalizeRoles(raw, fallback) {
  if (!Array.isArray(raw)) return [...fallback];
  const seen = new Set();
  const out = [];
  for (const r of raw) if (typeof r === 'string' && ROLE_IDS.includes(r) && !seen.has(r)) {
    seen.add(r);
    out.push(r);
  }
  // Unknown values are dropped silently (stable order preserved); an empty
  // result falls back to the tier's defaults so a worker never loses all roles.
  return out.length > 0 ? out : [...fallback];
}

function normalizeEnabled(raw) {
  return raw === undefined || raw === null ? true : Boolean(raw);
}

function normalizeBool(raw, fallback = false) {
  return raw === undefined || raw === null ? fallback : Boolean(raw);
}

/**
 * Normalize a raw (possibly legacy or partial) global config into the new
 * schema. Pure: returns a new object, never mutates or writes anything.
 * Unknown fields are carried through untouched for forward compatibility.
 */
export function normalizeGlobalConfig(raw = {}) {
  const has = (k) => raw[k] !== undefined;

  // Legacy migration: collaboration_mode derives from tier_policy when absent.
  let collaborationMode = raw.collaboration_mode;
  if (!COLLABORATION_MODES.includes(collaborationMode)) {
    const tp = raw.tier_policy;
    collaborationMode = tp === 'flash-only' ? 'flash-only' : tp === 'pro-only' ? 'pro-only' : 'balanced';
  }

  // Legacy migration: tier states derive from tier_policy when absent.
  let flashState = has('flash_state') ? normalizeState(raw.flash_state) : undefined;
  let proState = has('pro_state') ? normalizeState(raw.pro_state) : undefined;
  if (flashState === undefined || proState === undefined) {
    const tp = raw.tier_policy;
    if (tp === 'flash-only') { flashState = flashState ?? 'auto'; proState = proState ?? 'disabled'; }
    else if (tp === 'pro-only') { flashState = flashState ?? 'disabled'; proState = proState ?? 'auto'; }
    else { flashState = flashState ?? 'auto'; proState = proState ?? 'auto'; }
  }

  // Capability switches: an old config with provider=off must not flip the
  // capability back on; anything else keeps the capability enabled.
  const visionEnabled = has('vision_enabled')
    ? normalizeEnabled(raw.vision_enabled)
    : raw.vision_provider !== 'off';
  const imagegenEnabled = has('imagegen_enabled')
    ? normalizeEnabled(raw.imagegen_enabled)
    : raw.imagegen_provider !== 'off';

  const normalized = {
    ...raw,
    subagents_enabled: normalizeEnabled(raw.subagents_enabled),
    collaboration_mode: collaborationMode,
    main_agent_mode: MAIN_AGENT_MODES.includes(raw.main_agent_mode) ? raw.main_agent_mode : 'coordinator-first',
    flash_state: flashState,
    pro_state: proState,
    flash_roles: normalizeRoles(raw.flash_roles, DEFAULT_FLASH_ROLES),
    pro_roles: normalizeRoles(raw.pro_roles, DEFAULT_PRO_ROLES),
    pro_reviews_flash: normalizeBool(raw.pro_reviews_flash, false),
    // Worker provider routing: legacy-friendly default keeps deepseek-official
    // unless the user explicitly chooses follow-dsh (never silently switches).
    worker_provider_mode: normalizeWorkerProviderMode(raw.worker_provider_mode),
    flash_model_priority: normalizeModelPriority(raw.flash_model_priority),
    flash_model_priority_configured: raw.flash_model_priority_configured === true || normalizeModelPriority(raw.flash_model_priority).length > 0,
    flash_model_fallback: raw.flash_model_fallback === 'harness-default' ? raw.flash_model_fallback : 'harness-default',
    pro_model_priority: normalizeModelPriority(raw.pro_model_priority),
    pro_model_priority_configured: raw.pro_model_priority_configured === true || normalizeModelPriority(raw.pro_model_priority).length > 0,
    pro_model_fallback: raw.pro_model_fallback === 'harness-default' ? raw.pro_model_fallback : 'harness-default',
    vision_enabled: visionEnabled,
    imagegen_enabled: imagegenEnabled,
  };
  // This normalized legacy view is the single input to the v0.2 canonical
  // migration, so every consumer sees the same worker/reviewer model policy
  // the role helpers compute from any raw config.
  const canonical = migrateLegacyConfig(normalized);
  return { ...normalized, execution: canonical.execution, worker: canonical.worker, review: canonical.review };
}

/** Legacy view of a normalized config: keeps tier_policy-shaped consumers working. */
export function deriveLegacyConfig(config) {
  const c = config;
  const tierPolicy = c.tier_policy !== undefined
    ? c.tier_policy
    : (c.collaboration_mode === 'flash-only'
      ? 'flash-only'
      : c.collaboration_mode === 'pro-only' ? 'pro-only' : 'auto');
  return {
    default_tier: c.default_tier ?? 'flash',
    default_effort: c.default_effort ?? 'max',
    mode: c.mode ?? 'auto',
    default_timeout_seconds: c.default_timeout_seconds ?? 1800,
    tier_policy: tierPolicy,
    escalate_on_failure: normalizeBool(c.escalate_on_failure),
    preset_flash: c.preset_flash ?? 'default',
    preset_pro: c.preset_pro ?? 'default',
  };
}

// ---------- preset resolution ----------

/**
 * Effective per-tier state for a collaboration preset. Presets own both
 * states; the custom mode defers to the configured flash_state / pro_state.
 */
export function resolveCollaborationPreset(config) {
  const mode = config.collaboration_mode ?? 'balanced';
  if (mode === 'flash-only') return { flash: 'auto', pro: 'disabled' };
  if (mode === 'pro-only') return { flash: 'disabled', pro: 'auto' };
  if (mode === 'review-pipeline') return { flash: 'auto', pro: 'auto' };
  if (mode === 'custom') {
    return { flash: normalizeState(config.flash_state), pro: normalizeState(config.pro_state) };
  }
  return { flash: 'auto', pro: 'auto' }; // balanced
}

// ---------- effective policy ----------

/**
 * Effective tier state: session tier_policy (hard clamp) > session state
 * overrides > global collaboration preset / custom states.
 */
export function getEffectiveTierState(config, tier, session = {}) {
  const tp = session.tier_policy;
  if (tp === 'flash-only') return tier === 'flash' ? 'auto' : 'disabled';
  if (tp === 'pro-only') return tier === 'pro' ? 'auto' : 'disabled';
  const effectiveConfig = session.collaboration_mode
    ? { ...config, collaboration_mode: session.collaboration_mode }
    : config;
  const preset = resolveCollaborationPreset(effectiveConfig);
  const state = tier === 'flash' ? preset.flash : preset.pro;
  const override = session[`${tier}_state`];
  if (override === 'disabled' || override === 'manual' || override === 'auto') return override;
  return state;
}

export function isTierEnabled(config, tier, session = {}) {
  return getEffectiveTierState(config, tier, session) !== 'disabled';
}

/** Manual tiers are callable when explicitly requested, never chosen automatically. */
export function isTierAutoEligible(config, tier, session = {}) {
  return getEffectiveTierState(config, tier, session) === 'auto';
}

/**
 * Deterministic dispatch decision for one request.
 *
 * Priority order (highest first):
 *   1. session enabled=false
 *   2. global subagents_enabled=false
 *   3. session tier_policy hard clamp
 *   4. collaboration preset / custom states
 *   5. explicit requestedTier (manual tiers are callable when named)
 *   6. default_tier (only when its tier is auto-eligible)
 *   7. the single auto-eligible tier, if exactly one exists
 *   8. otherwise: no tier available
 *
 * Returns { ok: true, tier, guidance } or { ok: false, error }.
 */
export function chooseDefaultTier(config, requestedTier, session = {}) {
  if (session.enabled === false || config.subagents_enabled === false) {
    return { ok: false, error: policyError(POLICY_ERROR_CODES.SUBAGENTS_DISABLED) };
  }
  const flash = getEffectiveTierState(config, 'flash', session);
  const pro = getEffectiveTierState(config, 'pro', session);

  const tierUsable = (t) => (t === 'flash' ? flash : pro) !== 'disabled';
  const tierAuto = (t) => (t === 'flash' ? flash : pro) === 'auto';

  // 5. explicit request: manual tiers are callable, disabled tiers are not.
  if (requestedTier === 'flash' || requestedTier === 'pro') {
    if (!tierUsable(requestedTier)) {
      return { ok: false, error: policyError(POLICY_ERROR_CODES.TIER_DISABLED, { tier: requestedTier }) };
    }
    return { ok: true, tier: requestedTier, guidance: 'explicit request' };
  }

  const autoTiers = ['flash', 'pro'].filter(tierAuto);
  // 6. default_tier, but never as an automatic choice for a manual tier.
  const def = config.default_tier;
  if (def === 'flash' || def === 'pro') {
    if (tierAuto(def)) return { ok: true, tier: def, guidance: 'session/global default' };
    // A disabled default tier is skipped, not auto-failed: fall through so a
    // configured alternate tier can still serve.
  }
  // 7. the only auto tier available.
  if (autoTiers.length === 1) return { ok: true, tier: autoTiers[0], guidance: 'only auto tier' };
  // Manual-only setup: name one explicitly, or fix the configuration.
  if (autoTiers.length === 0) {
    if (tierUsable('flash') || tierUsable('pro')) {
      return { ok: false, error: policyError(POLICY_ERROR_CODES.NO_AUTO_TIER) };
    }
    return { ok: false, error: policyError(POLICY_ERROR_CODES.NO_WORKER_TIER) };
  }
  // Balanced with both auto and no usable default: pick flash (cheapest).
  if (tierAuto('flash')) return { ok: true, tier: 'flash', guidance: 'first auto tier' };
  return { ok: true, tier: 'pro', guidance: 'first auto tier' };
}

/** May a failed flash blocking job escalate to pro? Pro must be auto. */
export function canEscalateFlashToPro(config, session = {}) {
  if (session.escalate_on_failure !== undefined && !session.escalate_on_failure) return false;
  const escalate = session.escalate_on_failure ?? normalizeBool(config.escalate_on_failure);
  if (!escalate) return false;
  const tp = session.tier_policy;
  if (tp === 'flash-only') return false;
  return getEffectiveTierState(config, 'pro', session) === 'auto';
}

/** Should a successful flash job be followed by one automatic pro review? */
export function shouldRunProReview(config, session = {}) {
  const mode = session.collaboration_mode ?? config.collaboration_mode ?? 'balanced';
  const optedIn = session.pro_reviews_flash ?? config.pro_reviews_flash;
  const proState = getEffectiveTierState(config, 'pro', session);
  if (proState !== 'auto') return false;
  if (session.tier_policy === 'flash-only') return false;
  if (mode === 'review-pipeline') return true;
  // Balanced / custom: only when explicitly opted in via pro_reviews_flash.
  return normalizeBool(optedIn);
}

/** Roles for a tier (host guidance for who does what, not a hard classifier). */
export function getTierRoles(config, tier) {
  const roles = tier === 'flash' ? config.flash_roles : config.pro_roles;
  return normalizeRoles(roles, tier === 'flash' ? DEFAULT_FLASH_ROLES : DEFAULT_PRO_ROLES);
}

// ---------- routing guidance ----------

const MAIN_MODE_GUIDANCE = {
  'direct-allowed':
    'Host agent may implement directly or delegate. Use enabled DSH workers when helpful. No preference to delegate everything.',
  'coordinator-first':
    'Prefer: (1) understand the goal, (2) decompose the task, (3) delegate suitable coding work to enabled Auto workers, (4) inspect results, (5) verify, (6) integrate. Direct implementation remains allowed for tiny changes, recovery, unavailable tiers, or tasks better handled by the host.',
  'dispatcher-only':
    'Prefer: (1) planning, (2) dispatch, (3) supervision, (4) review, (5) final integration. Delegate implementation whenever practical to enabled workers. This is routing guidance, not a hard restriction on host tools.',
};

const COLLABORATION_GUIDANCE = {
  'flash-only': 'Flash is the only Auto tier. Dispatch implementation, tests, simple fixes and search to flash; Pro is unavailable and must not be used.',
  'pro-only': 'Pro is the only Auto tier. Dispatch implementation, analysis, debugging, refactor and review to pro; Flash is unavailable and must not be used.',
  balanced:
    'Flash (Auto): mechanical/simple changes, implementation, tests, search/inspection, straightforward fixes. Pro (Auto): architecture, complex debugging, multi-file refactor, difficult reasoning, code review. An explicit tier request wins unless that tier is disabled.',
  'review-pipeline':
    'Implementation goes to Flash (Auto); after a successful Flash run, one Pro (Auto) review may run automatically. Pro review is read-only guidance and must not edit files unless the user asks.',
  custom:
    'Custom policy: dispatch only to Auto tiers; Manual tiers are callable only when the user explicitly names the tier; Disabled tiers must not be used.',
};

function stateLine(config, tier, session) {
  const state = getEffectiveTierState(config, tier, session);
  const label = tier === 'flash' ? 'Flash' : 'Pro';
  const roles = getTierRoles(config, tier).join(', ');
  if (state === 'disabled') return `${label}: Disabled (not available).`;
  const roleNote = state === 'auto' ? ` Typical work: ${roles}.` : ` Suitable for: ${roles}.`;
  return `${label}: ${state === 'auto' ? 'Auto' : 'Manual'} — ${state === 'auto' ? 'the orchestrator may delegate to it automatically' : 'use only when the user explicitly requests this tier or picks the ds-' + tier + ' subagent'}.${roleNote}`;
}

/**
 * Short, stable policy text for the orchestrator. Returned by dsh_worker_config
 * and referenced by the ds-flash / ds-pro agent descriptions. Describes the
 * hard parts (disabled tiers) and the soft parts (main agent mode, roles)
 * without pretending the host's own tools are restricted.
 */
export function getRoutingGuidance(config, session = {}) {
  const mode = session.collaboration_mode ?? config.collaboration_mode ?? 'balanced';
  const requestedMainMode = session.main_agent_mode ?? config.main_agent_mode;
  const mainMode = MAIN_AGENT_MODES.includes(requestedMainMode) ? requestedMainMode : 'coordinator-first';
  const parts = [];
  if (session.enabled === false || config.subagents_enabled === false) {
    parts.push('DSH worker dispatch is DISABLED. Do not call dsh_run_worker / dsh_spawn_worker; report the disablement to the user instead of doing the task yourself.');
  } else {
    parts.push(COLLABORATION_GUIDANCE[mode] ?? COLLABORATION_GUIDANCE.balanced);
    parts.push(stateLine(config, 'flash', session));
    parts.push(stateLine(config, 'pro', session));
    if (canEscalateFlashToPro(config, session)) parts.push('A failed blocking Flash job may automatically escalate to Pro once.');
    if (shouldRunProReview(config, session)) parts.push('A successful Flash implementation may be followed by one automatic Pro review.');
    // v0.2 role view: worker = execution, reviewer = independent review. The
    // legacy tier lines above stay for compatibility with older orchestrators.
    const workerState = getRoleState(config, 'worker', session);
    const reviewState = getRoleState(config, 'reviewer', session);
    parts.push(`Roles: worker=${workerState} (implementation / fixes / tests / search), reviewer=${reviewState} (independent review). Default coding role is worker; the reviewer joins via explicit request or the automatic review workflow.`);
    if (shouldAutoReview(config, session)) parts.push('A successful worker run is followed by one automatic reviewer pass (read-only).');
  }
  parts.push(`Main agent mode (host guidance only — does not restrict host tools): ${mainMode}. ${MAIN_MODE_GUIDANCE[mainMode]}`);
  parts.push('After a worker returns, check its delivery metadata (delivery_complete / delivery_missing / delivery.tests_status) and redacted workspace diff (workspace_diff_available). delivery.complete=true does not mean the task succeeded: tests_status=FAIL requires another fix or an explicit failure report, and tests_status=NOT RUN requires disclosure of the unverified work. If the Delivery Report is missing or files changed outside scope, do not accept the result as final — request a follow-up worker run.');
  return parts.join(' ');
}

// ---------- validation ----------

/** Validation result: { ok, errors, warnings, config } — never throws. */
export function validateConfig(raw) {
  const errors = [];
  const warnings = [];
  const config = normalizeGlobalConfig(raw);

  if (config.collaboration_mode === 'review-pipeline') {
    if (config.flash_state === 'disabled' || config.pro_state === 'disabled') {
      errors.push('review-pipeline requires both Flash and Pro to be usable; switch to custom or enable both tiers');
      warnings.push('review-pipeline degraded: an Auto tier is missing');
    }
  }
  if (config.collaboration_mode === 'review-pipeline' && config.subagents_enabled === false) {
    warnings.push('subagents_enabled=false disables the review pipeline too');
  }
  return { ok: errors.length === 0, errors, warnings, config };
}

/** Roles validation used by tests and by any future session-role setter. */
export function validateRoles(raw) {
  const seen = new Set();
  const out = [];
  const dropped = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (typeof r !== 'string' || !ROLE_IDS.includes(r)) {
      if (r !== undefined && r !== null) dropped.push(String(r));
      continue;
    }
    if (!seen.has(r)) { seen.add(r); out.push(r); }
  }
  return { roles: out, dropped };
}

// ---------- multimodal capability ----------

/** Capability availability after both the switch and the provider are checked. */
export function getCapabilities(config) {
  const c = config;
  const vision = {
    enabled: normalizeBool(c.vision_enabled, true),
    provider: c.vision_provider ?? 'claude-code',
    providerOff: c.vision_provider === 'off',
    usable: normalizeBool(c.vision_enabled, true) && c.vision_provider !== 'off',
  };
  const imagegen = {
    enabled: normalizeBool(c.imagegen_enabled, true),
    provider: c.imagegen_provider ?? 'codex',
    providerOff: c.imagegen_provider === 'off',
    usable: normalizeBool(c.imagegen_enabled, true) && c.imagegen_provider !== 'off',
  };
  return { vision, imagegen };
}

/**
 * Registration plan for the hub's multimodal bridge: which tools to register
 * and whether the vision route (deepseek-vision adapter + transcription
 * waterfall) should be installed. Tool names are the decision points; the
 * hub applies the plan at plugin boot, so capability switches take effect
 * after a DSH restart.
 */
export function getMultimodalRegistrationPlan(config) {
  const { vision, imagegen } = getCapabilities(config);
  return {
    tools: {
      describe_image: vision.usable,
      generate_image: imagegen.usable,
    },
    visionRoute: vision.usable,
    requiresRestart: true,
  };
}
