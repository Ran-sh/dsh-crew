import { isExactNativeCrewIdentity, sameCompleteRuntimeIdentity } from '../runtime-identity-contract.mjs';

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
  return { accepted: true, envelope: valid ? { runtime: extensionRuntime, snapshot } : {} };
}
