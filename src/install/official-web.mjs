import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const OFFICIAL_BRIDGE_PACKAGE = '@ran-sh/dsh-crew-web-bridge';
const STATE_FILENAME = 'official-web.json';

export function officialWebProfileDir({ home = homedir() } = {}) {
  return join(home, '.dsh', 'profiles', 'web');
}

export function officialWebIntegrationStateFile({ home = homedir() } = {}) {
  return join(home, '.config', 'dsh-crew', STATE_FILENAME);
}

function readState(home) {
  try {
    const value = JSON.parse(readFileSync(officialWebIntegrationStateFile({ home }), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

function validOfficialManifest(file) {
  if (!existsSync(file)) return { ok: false, code: 'OFFICIAL_WEB_PROFILE_NOT_FOUND' };
  try {
    const raw = readFileSync(file, 'utf8');
    const manifest = JSON.parse(raw);
    if (!manifest || typeof manifest !== 'object'
      || (manifest.dependencies !== undefined && (!manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)))
      || !Array.isArray(manifest.dsh?.profile?.bundles)) {
      return { ok: false, code: 'OFFICIAL_WEB_PROFILE_INVALID' };
    }
    return { ok: true, raw, manifest };
  } catch { return { ok: false, code: 'OFFICIAL_WEB_PROFILE_INVALID' }; }
}

export const OFFICIAL_WEB_READ_ONLY_CODE = 'OFFICIAL_WEB_PROFILE_READ_ONLY';

// The official ~/.dsh/profiles/web tree is a read-only boundary. Crew must
// never install, update, register, unlink, repair, or mutate anything under
// ~/.dsh; the isolated 3210 Crew backend is the only runtime Crew owns.
// ensure/remove therefore fail closed instead of writing the official
// profile. Status probing stays read-only.
export function ensureOfficialWebIntegration({ home = homedir(), releaseDir } = {}) {
  return { ok: false, code: OFFICIAL_WEB_READ_ONLY_CODE };
}

// Project the legacy full-bridge state file. The old `enabled: true` shape
// is DEPRECATED: dsh-crew no longer desires any control of the 3080 official
// web profile (the native 3210 page is the full control plane, and the 3080
// quick surface is optional). Status probing stays read-only; the projection
// makes the legacy record diagnostic instead of an active intent.
function projectLegacyState(state, home, releaseDir) {
  if (!state || state?.enabled !== true) {
    return { enabled: false, legacy_present: false, desired: false, healthy: false, state };
  }
  const expectedRelease = releaseDir ?? state.release_dir;
  let expectedBridge;
  try { expectedBridge = realpathSync(join(expectedRelease, 'official-web-bridge')); } catch {
    return { enabled: false, legacy_present: true, desired: false, healthy: false, code: 'BRIDGE_RELEASE_MISSING', state };
  }
  const profileRoot = officialWebProfileDir({ home });
  const profile = validOfficialManifest(join(profileRoot, 'package.json'));
  if (!profile.ok) {
    return { enabled: false, legacy_present: true, desired: false, healthy: false, code: profile.code, state };
  }
  const dependency = profile.manifest.dependencies?.[OFFICIAL_BRIDGE_PACKAGE];
  const bundled = profile.manifest.dsh.profile.bundles.includes(OFFICIAL_BRIDGE_PACKAGE);
  const linkPath = join(profileRoot, 'node_modules', ...OFFICIAL_BRIDGE_PACKAGE.split('/'));
  let linked = false;
  try { linked = lstatSync(linkPath).isSymbolicLink() && realpathSync(linkPath) === expectedBridge; } catch {}
  return {
    enabled: false,
    legacy_present: true,
    desired: false,
    healthy: Boolean(dependency && bundled && linked),
    removal_requires_manual_official_profile_action: true,
    state,
    linkPath,
    expectedBridge,
  };
}

export function officialWebIntegrationStatus({ home = homedir(), releaseDir } = {}) {
  return projectLegacyState(readState(home), home, releaseDir);
}

export function removeOfficialWebIntegration({ home = homedir(), remember = true, preserveIntent = false } = {}) {
  return { ok: false, code: OFFICIAL_WEB_READ_ONLY_CODE };
}
