// Pure client projection for the server-owned model_callability contract.
// The client must never infer current callability from historical matrix rows.

import { READINESS_STATES } from './host-readiness.mjs';
import { isCompleteRuntimeIdentity, sameCompleteRuntimeIdentity } from '../runtime-identity-contract.mjs';

const MODEL_CALLABILITY_SCHEMA_VERSION = 2;

export function modelCallabilityState(projection, runtime = null, now = Date.now()) {
  if (!projection || typeof projection !== 'object' || typeof projection.overall !== 'string') {
    return READINESS_STATES.UNKNOWN;
  }
  const current = projection.schema_version === MODEL_CALLABILITY_SCHEMA_VERSION
    && Number.isFinite(projection.captured_at) && projection.captured_at <= now
    && typeof projection.current_runtime_id === 'string' && projection.current_runtime_id.trim()
    && isCompleteRuntimeIdentity(projection.runtime_identity)
    && isCompleteRuntimeIdentity(runtime)
    && sameCompleteRuntimeIdentity(projection.runtime_identity, runtime)
    && projection.current_runtime_id === projection.runtime_identity.runtime_id;
  if (!current) return READINESS_STATES.UNKNOWN;
  if (projection.overall === 'CALLABLE') {
    const activeRoles = projection.enabled_roles && typeof projection.enabled_roles === 'object'
      ? Object.entries(projection.enabled_roles).filter(([, enabled]) => enabled === true).map(([role]) => role)
      : [];
    const allowedRoles = new Set(['worker', 'reviewer']);
    const valid = Number.isFinite(projection.expires_at) && projection.expires_at > now
      && typeof projection.current_runtime_id === 'string' && projection.current_runtime_id.trim()
      && isCompleteRuntimeIdentity(projection.runtime_identity)
      && isCompleteRuntimeIdentity(runtime)
      && sameCompleteRuntimeIdentity(projection.runtime_identity, runtime)
      && projection.current_runtime_id === projection.runtime_identity.runtime_id
      && activeRoles.length > 0
      && Object.keys(projection.enabled_roles ?? {}).every((role) => allowedRoles.has(role))
      && Object.keys(projection.roles ?? {}).every((role) => allowedRoles.has(role))
      && activeRoles.every((role) => projection.roles?.[role]?.state === 'CALLABLE')
      && Object.entries(projection.enabled_roles ?? {}).every(([role, enabled]) => enabled === true || projection.roles?.[role]?.state === 'NOT_APPLICABLE');
    return valid ? READINESS_STATES.READY : READINESS_STATES.UNKNOWN;
  }
  if (projection.overall === 'NOT_CALLABLE') {
    const enabled = projection.enabled_roles && typeof projection.enabled_roles === 'object' ? projection.enabled_roles : {};
    const roles = projection.roles && typeof projection.roles === 'object' ? projection.roles : {};
    const active = Object.entries(enabled).filter(([, value]) => value === true).map(([role]) => role);
    const allowed = new Set(['worker', 'reviewer']);
    const valid = active.length > 0
      && Object.keys(enabled).every((role) => allowed.has(role))
      && Object.keys(roles).every((role) => allowed.has(role))
      && Object.entries(enabled).every(([role, value]) => value === true || roles[role]?.state === 'NOT_APPLICABLE')
      && active.some((role) => roles[role]?.state === 'NOT_CALLABLE' && Number.isFinite(roles[role]?.expires_at) && roles[role].expires_at > now);
    return valid ? READINESS_STATES.UNAVAILABLE : READINESS_STATES.UNKNOWN;
  }
  if (projection.overall === 'STALE') return READINESS_STATES.DEGRADED;
  return READINESS_STATES.UNKNOWN;
}
