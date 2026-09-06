import { isExactNativeCrewIdentity, sameCompleteRuntimeIdentity } from '../runtime-identity-contract.mjs';
import { validateModelCallabilityV2 } from '../model-callability-contract.mjs';

export function readinessExpiryDelay(expiresAt, now = Date.now()) {
  return Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now + 10) : null;
}

/**
 * Apply one extension response to the atomic runtime/readiness envelope.
 * Older responses are ignored so a restart cannot be rolled back by a slow
 * request that started before the new runtime identity was observed.
 */
export function acceptReadinessResponse(response, { generation, latestGeneration } = {}) {
  if (generation !== latestGeneration) return { accepted: false, envelope: null };
  const extensionRuntime = response?.extension?.runtime;
  const snapshot = response?.extension?.readiness_snapshot;
  const valid = response?.ok === true
    && isExactNativeCrewIdentity(extensionRuntime)
    && isExactNativeCrewIdentity(snapshot?.runtime)
    && sameCompleteRuntimeIdentity(extensionRuntime, snapshot.runtime);
  const expectedEnabledRoles = {
    worker: response?.extension?.capabilities?.['deepseek.worker'] === true,
    reviewer: response?.extension?.capabilities?.['deepseek.reviewer'] === true,
  };
  const projection = valid ? validateModelCallabilityV2({
    projection: snapshot.model_callability,
    runtime: extensionRuntime,
    expectedEnabledRoles,
    expectedSelections: { worker: snapshot.worker?.selected ?? null, reviewer: snapshot.reviewer?.selected ?? null },
  }) : { ok: false };
  return { accepted: true, envelope: valid && projection.ok
    ? { runtime: extensionRuntime, snapshot, expiresAt: snapshot.model_callability.expires_at }
    : {} };
}
