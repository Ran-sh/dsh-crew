// Pure client projection for the server-owned model_callability contract.
// The client must never infer current callability from historical matrix rows.

import { READINESS_STATES } from './host-readiness.mjs';
import { validateModelCallabilityV2 } from '../model-callability-contract.mjs';

export function modelCallabilityState(projection, runtime = null, now = Date.now()) {
  if (!projection || typeof projection !== 'object' || typeof projection.overall !== 'string') {
    return READINESS_STATES.UNKNOWN;
  }
  const validation = validateModelCallabilityV2({ projection, runtime, now });
  if (!validation.ok) return READINESS_STATES.UNKNOWN;
  if (validation.state === 'CALLABLE') return READINESS_STATES.READY;
  if (validation.state === 'NOT_CALLABLE') return READINESS_STATES.UNAVAILABLE;
  if (validation.state === 'STALE') return READINESS_STATES.DEGRADED;
  return READINESS_STATES.UNKNOWN;
}
