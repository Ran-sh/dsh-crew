// Credential references are identifiers, never credential values. Keep this
// boundary strict because provider metadata is returned to the browser/UI.

const ENV_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const HANDLE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SECRET_LIKE = /^(?:sk|pk|rk|sess|tok|token|key|secret)[_-]/iu;
const EMBEDDED_SECRET = /(?:^|\s)(?:bearer|basic)\s+|(?:https?|data):|=/iu;

function rawText(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    const candidate = value.name_or_handle ?? value.name ?? value.reference;
    return typeof candidate === 'string' ? candidate.trim() || null : null;
  }
  return null;
}

/**
 * Classify a reference without returning an unsafe value. `kind: env` is the
 * common apiKeyEnv form; non-env stores may use a bounded opaque handle.
 */
export function classifyCredentialReference(value, { kind = 'env' } = {}) {
  const raw = rawText(value);
  if (!raw) return { present: false, value: null, redacted: false };
  const normalizedKind = typeof kind === 'string' ? kind.trim().toLowerCase() : 'env';
  const valid = normalizedKind === 'env'
    ? ENV_REFERENCE.test(raw)
    : HANDLE_REFERENCE.test(raw) && !SECRET_LIKE.test(raw) && !EMBEDDED_SECRET.test(raw);
  return { present: true, value: valid ? raw : null, redacted: !valid };
}

export function sanitizeCredentialReference(value, options = {}) {
  return classifyCredentialReference(value, options).value;
}

export function hasCredentialReference(value, options = {}) {
  return classifyCredentialReference(value, options).present;
}
