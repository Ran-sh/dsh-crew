import { isExactNativeCrewIdentity, sameCompleteRuntimeIdentity } from './runtime-identity-contract.mjs';

export const MODEL_CALLABILITY_SCHEMA_VERSION = 2;
const ROLES = ['worker', 'reviewer'];
const STATES = new Set(['CALLABLE', 'NOT_CALLABLE', 'STALE', 'UNKNOWN', 'NOT_APPLICABLE']);
const SOURCES = new Set(['provider_health', 'execution']);
const MAX_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function route(value) {
  return typeof value?.provider === 'string' && value.provider.trim()
    && typeof value?.model === 'string' && value.model.trim()
    ? { provider: value.provider.trim(), model: value.model.trim() } : null;
}

function validEvidence(role, now) {
  if (!SOURCES.has(role.source) || !Number.isFinite(role.observed_at) || role.observed_at > now
    || !Number.isFinite(role.expires_at) || role.expires_at <= now
    || role.expires_at - role.observed_at > MAX_EVIDENCE_TTL_MS) return false;
  if (role.source === 'execution') {
    if (!role.last_success || typeof role.last_success !== 'object'
      || typeof role.last_success.job_id !== 'string' || !role.last_success.job_id.trim()
      || role.last_success.observed_at !== role.observed_at
      || role.last_success.expires_at !== role.expires_at) return false;
  }
  return true;
}

export function validateModelCallabilityV2({ projection, runtime, expectedEnabledRoles, expectedSelections, now = Date.now() } = {}) {
  const fail = (reason_code) => ({ ok: false, reason_code, state: 'UNKNOWN' });
  if (!projection || typeof projection !== 'object' || projection.schema_version !== MODEL_CALLABILITY_SCHEMA_VERSION) return fail('MODEL_CALLABILITY_SCHEMA_INVALID');
  if (!isExactNativeCrewIdentity(runtime) || !isExactNativeCrewIdentity(projection.runtime_identity)
    || !sameCompleteRuntimeIdentity(runtime, projection.runtime_identity)
    || projection.current_runtime_id !== runtime.runtime_id) return fail('MODEL_CALLABILITY_RUNTIME_MISMATCH');
  if (!Number.isFinite(projection.captured_at) || projection.captured_at > now) return fail('MODEL_CALLABILITY_CAPTURE_INVALID');
  if (!exactKeys(projection.enabled_roles, ROLES) || ROLES.some((role) => typeof projection.enabled_roles[role] !== 'boolean')) return fail('MODEL_CALLABILITY_ROLES_INVALID');
  if (expectedEnabledRoles && (!exactKeys(expectedEnabledRoles, ROLES) || ROLES.some((role) => projection.enabled_roles[role] !== expectedEnabledRoles[role]))) return fail('MODEL_CALLABILITY_ROLE_CONFIG_MISMATCH');
  if (!exactKeys(projection.roles, ROLES)) return fail('MODEL_CALLABILITY_ROLE_EVIDENCE_MISSING');

  for (const roleName of ROLES) {
    const role = projection.roles[roleName];
    if (!role || !STATES.has(role.state)) return fail('MODEL_CALLABILITY_ROLE_STATE_INVALID');
    if (projection.enabled_roles[roleName] === false) {
      if (role.state !== 'NOT_APPLICABLE' || role.reason_code !== 'ROLE_DISABLED') return fail('MODEL_CALLABILITY_DISABLED_ROLE_INVALID');
      continue;
    }
    const selected = route(role.selected);
    if (role.selected !== undefined && role.selected !== null && !selected) return fail('MODEL_CALLABILITY_SELECTION_INVALID');
    if (['CALLABLE', 'NOT_CALLABLE'].includes(role.state) && !selected) return fail('MODEL_CALLABILITY_SELECTION_INVALID');
    if (expectedSelections?.[roleName]) {
      const expected = route(expectedSelections[roleName]);
      if (!expected || !selected || expected.provider !== selected.provider || expected.model !== selected.model) return fail('MODEL_CALLABILITY_SELECTION_MISMATCH');
    }
    if (['CALLABLE', 'NOT_CALLABLE'].includes(role.state)) {
      if (!validEvidence(role, now)) return fail('MODEL_CALLABILITY_EVIDENCE_INVALID');
    }
  }

  const activeRoles = ROLES.map((role) => projection.roles[role]).filter((_, index) => projection.enabled_roles[ROLES[index]] === true);
  const activeStates = activeRoles.map((role) => role.state);
  const state = activeStates.includes('NOT_CALLABLE') ? 'NOT_CALLABLE'
    : activeStates.length > 0 && activeStates.every((value) => value === 'CALLABLE') ? 'CALLABLE'
      : activeStates.includes('STALE') ? 'STALE' : 'UNKNOWN';
  if (projection.overall !== state) return fail('MODEL_CALLABILITY_OVERALL_CONTRADICTION');
  const evidenceExpirations = activeRoles.map((role) => role.expires_at).filter((value) => Number.isFinite(value));
  const expectedExpires = evidenceExpirations.length ? Math.min(...evidenceExpirations) : null;
  if (projection.expires_at !== expectedExpires) return fail('MODEL_CALLABILITY_EXPIRY_CONTRADICTION');
  if (state === 'CALLABLE' && (!Number.isFinite(projection.expires_at) || projection.expires_at <= now)) return fail('MODEL_CALLABILITY_EXPIRED');
  return { ok: true, state, reason_code: 'MODEL_CALLABILITY_VALID' };
}
