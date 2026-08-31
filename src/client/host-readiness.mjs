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

function runtimeState(runtime, readinessSnapshot) {
  if (readinessSnapshot && typeof readinessSnapshot === 'object') {
    const identity = readinessSnapshot.runtime;
    if (!(identity?.execution_plane === 'hub-3210' && identity.profile === 'dsh-crew'
      && Number(identity.listen_port) === 3210 && typeof identity.runtime_id === 'string' && identity.runtime_id.trim())) {
      return READINESS_STATES.UNAVAILABLE;
    }
    const row = Array.isArray(readinessSnapshot.readiness_matrix?.rows)
      ? readinessSnapshot.readiness_matrix.rows.find((entry) => entry?.id === 'hub_compatibility') : undefined;
    if (row?.status === 'PASS') return READINESS_STATES.READY;
    if (row?.status === 'FAIL') return READINESS_STATES.UNAVAILABLE;
    if (row?.status === 'NOT_RUN' || row?.status === 'SKIP') return READINESS_STATES.DEGRADED;
    return READINESS_STATES.UNKNOWN;
  }
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
export function projectHostReadiness({ installStatus, runtime, surface, readinessSnapshot } = {}) {
  const codex = installStatus?.codex;
  const claude = installStatus?.claude;
  const zcode = installStatus?.zcode;
  return [
    { id: 'codex_mcp', state: componentState(codex, ['mcp'], { aligned: true }) },
    { id: 'ds_worker', state: componentState(codex, ['worker_role'], { aligned: true }) },
    { id: 'ds_reviewer', state: componentState(codex, ['reviewer_role'], { aligned: true }) },
    { id: 'claude_plugin', state: componentState(claude, ['enabled', 'marketplace', 'snapshot', 'permissions']) },
    { id: 'zcode_mcp', state: componentState(zcode, ['mcp', 'policy', 'worker_agent', 'reviewer_agent', 'config_prompt', 'status_prompt', 'ownership']) },
    { id: 'crew_harness', state: runtimeState(runtime, readinessSnapshot), detail: runtime?.runtime_version ?? null },
    { id: 'official_bridge', state: bridgeState(surface) },
  ];
}
