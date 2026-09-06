// Pure client projection for the server-owned model_callability contract.
// The client must never infer current callability from historical matrix rows.

import { READINESS_STATES } from './host-readiness.mjs';

export function modelCallabilityState(projection, runtime = null, now = Date.now()) {
  if (!projection || typeof projection !== 'object' || typeof projection.overall !== 'string') {
    return READINESS_STATES.UNKNOWN;
  }
  const current = projection.schema_version === 1
    && Number.isFinite(projection.captured_at) && projection.captured_at <= now
    && typeof projection.current_runtime_id === 'string' && projection.current_runtime_id.trim()
    && (!runtime || projection.current_runtime_id === runtime.runtime_id);
  if (!current) return READINESS_STATES.UNKNOWN;
  if (projection.overall === 'CALLABLE') {
    const activeRoles = projection.enabled_roles && typeof projection.enabled_roles === 'object'
      ? Object.entries(projection.enabled_roles).filter(([, enabled]) => enabled === true).map(([role]) => role)
      : [];
    const valid = Number.isFinite(projection.expires_at) && projection.expires_at > now
      && typeof projection.current_runtime_id === 'string' && projection.current_runtime_id.trim()
      && (!runtime || projection.current_runtime_id === runtime.runtime_id)
      && activeRoles.length > 0
      && activeRoles.every((role) => projection.roles?.[role]?.state === 'CALLABLE');
    return valid ? READINESS_STATES.READY : READINESS_STATES.UNKNOWN;
  }
  if (projection.overall === 'NOT_CALLABLE') return READINESS_STATES.UNAVAILABLE;
  if (projection.overall === 'STALE') return READINESS_STATES.DEGRADED;
  return READINESS_STATES.UNKNOWN;
}
