// Browser-safe runtime identity primitives shared by the Hub, extension
// contract and client.  Do not coerce missing values: an incomplete identity
// is never evidence of the native 3210 Crew runtime.

export const PRODUCTION_EXECUTION_PLANE = 'hub-3210';
export const PRODUCTION_PROFILE = 'dsh-crew';
export const PRODUCTION_LISTEN_PORT = 3210;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isCompleteRuntimeIdentity(identity) {
  return Boolean(identity && typeof identity === 'object'
    && nonEmpty(identity.execution_plane)
    && nonEmpty(identity.profile)
    && Number.isInteger(identity.listen_port) && identity.listen_port > 0
    && nonEmpty(identity.runtime_id));
}

export function sameCompleteRuntimeIdentity(left, right) {
  return isCompleteRuntimeIdentity(left) && isCompleteRuntimeIdentity(right)
    && left.execution_plane === right.execution_plane
    && left.profile === right.profile
    && left.listen_port === right.listen_port
    && left.runtime_id === right.runtime_id;
}

export function isExactNativeCrewIdentity(identity) {
  return isCompleteRuntimeIdentity(identity)
    && identity.execution_plane === PRODUCTION_EXECUTION_PLANE
    && identity.profile === PRODUCTION_PROFILE
    && identity.listen_port === PRODUCTION_LISTEN_PORT;
}
