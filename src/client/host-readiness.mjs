export const READINESS_STATES = Object.freeze({
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
});

function componentState(status, keys, { aligned = false } = {}) {
  if (status === undefined || status === null || typeof status !== 'object') return READINESS_STATES.UNKNOWN;
  if (status.installed === false) return READINESS_STATES.UNAVAILABLE;
  if (status.installed !== true || !status.components || typeof status.components !== 'object') return READINESS_STATES.UNKNOWN;
  const evidence = keys.map((key) => status.components[key]);
  if (evidence.some((value) => typeof value !== 'boolean')) return READINESS_STATES.UNKNOWN;
  const ready = evidence.every(Boolean) && (!aligned || status.components.target_alignment === true);
  return ready ? READINESS_STATES.READY : READINESS_STATES.DEGRADED;
}

function runtimeState(runtime) {
  if (runtime === undefined) return READINESS_STATES.UNKNOWN;
  if (runtime === null) return READINESS_STATES.UNAVAILABLE;
  return runtime?.ok === true && runtime.service === 'dsh-crew-hub'
    ? READINESS_STATES.READY
    : READINESS_STATES.DEGRADED;
}

function bridgeState(surface) {
  if (surface === 'official-bridge') return READINESS_STATES.READY;
  if (surface === 'native-crew-harness') return READINESS_STATES.UNAVAILABLE;
  return READINESS_STATES.UNKNOWN;
}

/** Project only structured, non-secret installer/runtime evidence. */
export function projectHostReadiness({ installStatus, runtime, surface } = {}) {
  const codex = installStatus?.codex;
  const claude = installStatus?.claude;
  return [
    { id: 'codex_mcp', state: componentState(codex, ['mcp'], { aligned: true }) },
    { id: 'ds_worker', state: componentState(codex, ['worker_role'], { aligned: true }) },
    { id: 'ds_reviewer', state: componentState(codex, ['reviewer_role'], { aligned: true }) },
    { id: 'claude_plugin', state: componentState(claude, ['enabled', 'marketplace', 'snapshot', 'permissions']) },
    { id: 'crew_harness', state: runtimeState(runtime), detail: runtime?.runtime_version ?? null },
    { id: 'official_bridge', state: bridgeState(surface) },
  ];
}

