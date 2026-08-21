// Runtime control activation contract.
//
// This is deliberately data, not UI prose. MCP diagnostics and the Settings
// surface consume the same boundary definitions so users are never told two
// different stories about when a config change takes effect.

export const ACTIVATION_BOUNDARY = Object.freeze({
  LIVE: 'live',
  NEXT_WORKFLOW: 'next-workflow',
  NEXT_SESSION: 'next-session',
  RESTART_REQUIRED: 'restart-required',
});

const N = ACTIVATION_BOUNDARY.NEXT_WORKFLOW;
const S = ACTIVATION_BOUNDARY.NEXT_SESSION;
const L = ACTIVATION_BOUNDARY.LIVE;
const R = ACTIVATION_BOUNDARY.RESTART_REQUIRED;

/**
 * `global` describes a write made through persisted Settings/config.
 * `session` describes an explicit dsh_worker_config override in the already
 * running MCP process. `session: null` means the setting is not a session
 * override surface.
 */
export const RUNTIME_SETTING_ACTIVATION = Object.freeze({
  max_parallel: Object.freeze({ global: L, session: null, note: 'Admission limit refreshes before new workflow starts and when slots release; lowering never cancels active work.' }),

  subagents_enabled: Object.freeze({ global: N, session: N }),
  collaboration_mode: Object.freeze({ global: N, session: N }),
  main_agent_mode: Object.freeze({ global: N, session: N }),
  flash_state: Object.freeze({ global: N, session: N }),
  pro_state: Object.freeze({ global: N, session: N }),
  worker_state: Object.freeze({ global: N, session: N }),
  review_state: Object.freeze({ global: N, session: N }),
  auto_review: Object.freeze({ global: N, session: N }),
  pro_reviews_flash: Object.freeze({ global: N, session: N }),
  worker_provider_mode: Object.freeze({ global: N, session: null }),
  flash_model_priority: Object.freeze({ global: N, session: null }),
  flash_model_fallback: Object.freeze({ global: N, session: null }),
  pro_model_priority: Object.freeze({ global: N, session: null }),
  pro_model_fallback: Object.freeze({ global: N, session: null }),
  isolation: Object.freeze({ global: N, session: null }),
  vision_provider: Object.freeze({ global: N, session: null }),
  vision_model: Object.freeze({ global: N, session: null }),
  imagegen_provider: Object.freeze({ global: N, session: null }),

  // These values are copied into the MCP session defaults at process startup.
  // dsh_worker_config can override them for subsequent workflows in that same
  // session, but persisted global edits require a new MCP session to inherit.
  default_tier: Object.freeze({ global: S, session: N }),
  default_effort: Object.freeze({ global: S, session: N }),
  mode: Object.freeze({ global: S, session: N }),
  default_timeout_seconds: Object.freeze({ global: S, session: N }),
  escalate_on_failure: Object.freeze({ global: S, session: N }),
  preset_flash: Object.freeze({ global: S, session: N }),
  preset_pro: Object.freeze({ global: S, session: N }),

  // hub-client freezes its base URL at module initialization. Crew Vision and
  // Image Generation tool registration is also decided at Hub plugin boot.
  hub_url: Object.freeze({ global: R, session: null }),
  vision_enabled: Object.freeze({ global: R, session: null }),
  imagegen_enabled: Object.freeze({ global: R, session: null }),
});

export function activationForSetting(key) {
  const entry = RUNTIME_SETTING_ACTIVATION[key];
  return entry ? { ...entry } : null;
}

export function runtimeActivationMetadata() {
  return Object.fromEntries(
    Object.entries(RUNTIME_SETTING_ACTIVATION).map(([key, value]) => [key, { ...value }]),
  );
}

export function summarizeActivationBoundaries(metadata = RUNTIME_SETTING_ACTIVATION) {
  const out = {
    live: [],
    'next-workflow': [],
    'next-session': [],
    'restart-required': [],
  };
  for (const [key, entry] of Object.entries(metadata)) {
    const boundary = entry?.global;
    if (out[boundary]) out[boundary].push(key);
  }
  for (const values of Object.values(out)) values.sort();
  return out;
}
