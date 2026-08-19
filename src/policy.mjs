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
};

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

  return {
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
    vision_enabled: visionEnabled,
    imagegen_enabled: imagegenEnabled,
  };
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
  const preset = resolveCollaborationPreset(config);
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
  const mode = config.collaboration_mode ?? 'balanced';
  const proState = getEffectiveTierState(config, 'pro', session);
  if (proState !== 'auto') return false;
  if (session.tier_policy === 'flash-only') return false;
  if (mode === 'review-pipeline') return true;
  // Balanced / custom: only when explicitly opted in via pro_reviews_flash.
  return normalizeBool(config.pro_reviews_flash);
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
  const mode = config.collaboration_mode ?? 'balanced';
  const mainMode = MAIN_AGENT_MODES.includes(config.main_agent_mode) ? config.main_agent_mode : 'coordinator-first';
  const parts = [];
  if (session.enabled === false || config.subagents_enabled === false) {
    parts.push('DSH worker dispatch is DISABLED. Do not call dsh_run_worker / dsh_spawn_worker; report the disablement to the user instead of doing the task yourself.');
  } else {
    parts.push(COLLABORATION_GUIDANCE[mode] ?? COLLABORATION_GUIDANCE.balanced);
    parts.push(stateLine(config, 'flash', session));
    parts.push(stateLine(config, 'pro', session));
    if (canEscalateFlashToPro(config, session)) parts.push('A failed blocking Flash job may automatically escalate to Pro once.');
    if (shouldRunProReview(config, session)) parts.push('A successful Flash implementation may be followed by one automatic Pro review.');
  }
  parts.push(`Main agent mode (host guidance only — does not restrict host tools): ${mainMode}. ${MAIN_MODE_GUIDANCE[mainMode]}`);
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
