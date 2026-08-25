import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_ROLE_PROFILES,
  loadRoleProfiles,
  resolveRoleProfile,
  saveRoleProfiles,
} from '../src/role-profiles.mjs';

test('default Worker and Reviewer profiles preserve current behavior', () => {
  assert.deepEqual(DEFAULT_ROLE_PROFILES['worker-default'], {
    role: 'worker', routing: 'auto', isolation: 'worktree', fallback: true,
    timeout_seconds: 1800, review_strictness: 'standard',
  });
  assert.equal(DEFAULT_ROLE_PROFILES['reviewer-default'].role, 'reviewer');
  assert.equal(DEFAULT_ROLE_PROFILES['reviewer-default'].isolation, 'readonly');
  assert.equal(DEFAULT_ROLE_PROFILES['reviewer-default'].fallback, false);
});

test('profile save validates before atomically replacing the registry', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profiles-save-'));
  const saved = saveRoleProfiles({
    schema_version: 1,
    profiles: { 'worker-fast': { role: 'worker', timeout_seconds: 60, fallback: false } },
  }, { home });
  assert.equal(saved.ok, true);
  assert.equal(loadRoleProfiles({ home }).profiles['worker-fast'].timeout_seconds, 60);
  const rejected = saveRoleProfiles({ schema_version: 1, profiles: { bad: { role: 'root' } } }, { home });
  assert.equal(rejected.ok, false);
  assert.equal(loadRoleProfiles({ home }).profiles['worker-fast'].timeout_seconds, 60);
});

test('profile loader adds valid custom profiles and rejects malformed entries safely', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profiles-'));
  const dir = join(home, '.config', 'dsh-crew');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ schema_version: 1, profiles: {
    'worker-fast': { role: 'worker', routing: 'priority', isolation: 'worktree', fallback: false, timeout_seconds: 90 },
    '../unsafe': { role: 'worker' },
    broken: { role: 'root', timeout_seconds: 99999 },
  } }));
  const loaded = loadRoleProfiles({ home });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.profiles['worker-fast'].timeout_seconds, 90);
  assert.equal(loaded.profiles['../unsafe'], undefined);
  assert.equal(loaded.profiles.broken, undefined);
  assert.ok(loaded.errors.every((entry) => !('raw' in entry)));
});

test('profile loader distinguishes a missing registry from corrupt JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-profiles-corrupt-'));
  const dir = join(home, '.config', 'dsh-crew');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'profiles.json'), '{not-json');
  const loaded = loadRoleProfiles({ home });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.source, 'file');
  assert.equal(loaded.errors[0].code, 'PROFILE_FILE_INVALID');
});

test('profile resolution fails closed on unknown or role-mismatched profiles', () => {
  const loaded = { profiles: { ...DEFAULT_ROLE_PROFILES } };
  assert.equal(resolveRoleProfile(loaded, undefined, 'worker').profile_id, 'worker-default');
  assert.equal(resolveRoleProfile(loaded, 'missing', 'worker').code, 'PROFILE_NOT_FOUND');
  assert.equal(resolveRoleProfile(loaded, 'reviewer-default', 'worker').code, 'PROFILE_ROLE_MISMATCH');
});
