// Pure client projection for the server-owned model_callability contract.
// The client must never infer current callability from historical matrix rows.

import { READINESS_STATES } from './host-readiness.mjs';

export function modelCallabilityState(projection) {
  if (!projection || typeof projection !== 'object' || typeof projection.overall !== 'string') {
    return READINESS_STATES.UNKNOWN;
  }
  if (projection.overall === 'CALLABLE') return READINESS_STATES.READY;
  if (projection.overall === 'NOT_CALLABLE') return READINESS_STATES.UNAVAILABLE;
  if (projection.overall === 'STALE') return READINESS_STATES.DEGRADED;
  return READINESS_STATES.UNKNOWN;
}
