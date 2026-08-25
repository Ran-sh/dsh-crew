// Versioned, narrow Worker/Reviewer profiles. Profiles configure one DSH
// delegation; they are not general Agent personas and never contain prompts or
// credentials.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const ROLE_PROFILE_SCHEMA_VERSION = 1;
export const DEFAULT_ROLE_PROFILES = Object.freeze({
  'worker-default': Object.freeze({
    role: 'worker', routing: 'auto', isolation: 'worktree', fallback: true,
    timeout_seconds: 1800, review_strictness: 'standard',
  }),
  'reviewer-default': Object.freeze({
    role: 'reviewer', routing: 'stable', isolation: 'readonly', fallback: false,
    timeout_seconds: 1800, review_strictness: 'strict',
  }),
});

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ROLES = new Set(['worker', 'reviewer']);
const ROUTING = new Set(['auto', 'priority', 'stable']);
const ISOLATION = new Set(['worktree', 'readonly', 'shared']);
const STRICTNESS = new Set(['standard', 'strict']);

function normalizeProfile(id, raw) {
  if (!ID.test(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!ROLES.has(raw.role)) return null;
  const base = DEFAULT_ROLE_PROFILES[`${raw.role}-default`];
  const routing = raw.routing ?? base.routing;
  const isolation = raw.isolation ?? base.isolation;
  const reviewStrictness = raw.review_strictness ?? base.review_strictness;
  const timeout = raw.timeout_seconds ?? base.timeout_seconds;
  if (!ROUTING.has(routing) || !ISOLATION.has(isolation) || !STRICTNESS.has(reviewStrictness)) return null;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 7200) return null;
  if (raw.fallback !== undefined && typeof raw.fallback !== 'boolean') return null;
  return {
    role: raw.role,
    routing,
    isolation,
    fallback: raw.fallback ?? base.fallback,
    timeout_seconds: timeout,
    review_strictness: reviewStrictness,
  };
}

export function roleProfilesFile({ home = homedir() } = {}) {
  return join(home, '.config', 'dsh-crew', 'profiles.json');
}

export function loadRoleProfiles({ home = homedir(), file = roleProfilesFile({ home }) } = {}) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch {
    return { schema_version: ROLE_PROFILE_SCHEMA_VERSION, ok: true, source: 'defaults', profiles: { ...DEFAULT_ROLE_PROFILES }, errors: [] };
  }
  const errors = [];
  const profiles = { ...DEFAULT_ROLE_PROFILES };
  if (raw?.schema_version !== ROLE_PROFILE_SCHEMA_VERSION || !raw.profiles || typeof raw.profiles !== 'object' || Array.isArray(raw.profiles)) {
    return { schema_version: ROLE_PROFILE_SCHEMA_VERSION, ok: false, source: 'file', profiles, errors: [{ code: 'PROFILE_FILE_INVALID' }] };
  }
  for (const [id, value] of Object.entries(raw.profiles)) {
    if (id in DEFAULT_ROLE_PROFILES) {
      errors.push({ code: 'PROFILE_DEFAULT_RESERVED', profile_id: id });
      continue;
    }
    const profile = normalizeProfile(id, value);
    if (!profile) errors.push({ code: 'PROFILE_INVALID', profile_id: ID.test(id) ? id : '<invalid>' });
    else profiles[id] = profile;
  }
  return { schema_version: ROLE_PROFILE_SCHEMA_VERSION, ok: errors.length === 0, source: 'file', profiles, errors: errors.slice(0, 32) };
}

export function resolveRoleProfile(registry, profileId, role = 'worker') {
  const id = profileId ?? `${role}-default`;
  const profile = registry?.profiles?.[id];
  if (!profile) return { ok: false, code: 'PROFILE_NOT_FOUND', profile_id: id };
  if (profile.role !== role) return { ok: false, code: 'PROFILE_ROLE_MISMATCH', profile_id: id, expected_role: role };
  return { ok: true, profile_id: id, profile: { ...profile } };
}
