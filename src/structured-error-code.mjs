// Shared bounded machine error-code contract for the Hub service boundary.
//
// A machine code is an uppercase snake-style identifier (A-Z, 0-9, single
// underscores) of at most 64 characters. Only such values may cross the Hub
// service/client boundary as a top-level `code`: values are taken from
// err.code / err.policyCode only and are never derived from error text or from
// arbitrary response payload fields. Invalid values are treated as absent and
// callers fall back to their own constant (e.g. HUB_REQUEST_FAILED).

export const MACHINE_CODE_MAX_LENGTH = 64;
const MACHINE_CODE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/**
 * True when `value` is a string that satisfies the bounded machine-code
 * contract (uppercase snake-style identifier, length 1..64). Null, non-strings,
 * lowercase/mixed-case, blank, leading/trailing/double-underscore, and
 * over-length values are rejected.
 */
export function isBoundedMachineCode(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MACHINE_CODE_MAX_LENGTH
    && MACHINE_CODE_RE.test(value);
}

/**
 * First valid bounded machine code found on an error object: `code` wins over
 * `policyCode`. Returns null when neither field is a valid bounded machine
 * code, so callers can keep the raw error text unchanged and only add the
 * optional top-level `code` when one genuinely exists.
 */
export function boundedMachineCodeFromError(err) {
  if (!err || typeof err !== 'object') return null;
  for (const key of ['code', 'policyCode']) {
    const value = err[key];
    if (isBoundedMachineCode(value)) return value;
  }
  return null;
}