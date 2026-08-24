import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensurePluginRegistration, removeCrewPluginRegistration } from '../dsh-cli-runtime.mjs';

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

function writeState(home, value) {
  const file = officialWebIntegrationStateFile({ home });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
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

function makeBackup({ home, profileManifest, previous }) {
  if (previous?.backup_file && existsSync(previous.backup_file)) return previous.backup_file;
  const backupDir = join(home, '.config', 'dsh-crew', 'backups');
  mkdirSync(backupDir, { recursive: true });
  const backupFile = join(backupDir, `official-web-package-${Date.now()}.json`);
  copyFileSync(profileManifest, backupFile);
  return backupFile;
}

export function ensureOfficialWebIntegration({ home = homedir(), releaseDir } = {}) {
  let resolvedRelease;
  try { resolvedRelease = realpathSync(releaseDir); } catch { return { ok: false, code: 'RELEASE_NOT_FOUND' }; }
  const bridgeRoot = join(resolvedRelease, 'official-web-bridge');
  const profileRoot = officialWebProfileDir({ home });
  const profileManifest = join(profileRoot, 'package.json');
  const profile = validOfficialManifest(profileManifest);
  if (!profile.ok) return profile;
  const previous = readState(home);
  const backupFile = makeBackup({ home, profileManifest, previous });
  const registration = ensurePluginRegistration({
    profileRoot,
    root: bridgeRoot,
    name: OFFICIAL_BRIDGE_PACKAGE,
    createProfile: false,
  });
  if (!registration.ok) {
    return { ok: false, code: registration.code === 'CREW_PROFILE_METADATA_INVALID' ? 'OFFICIAL_WEB_PROFILE_INVALID' : registration.code };
  }
  const stateChanged = previous?.enabled !== true || previous?.release_dir !== resolvedRelease || previous?.backup_file !== backupFile;
  writeState(home, {
    enabled: true,
    release_dir: resolvedRelease,
    backup_file: backupFile,
    package: OFFICIAL_BRIDGE_PACKAGE,
  });
  return { ...registration, changed: registration.changed || stateChanged, backupFile };
}

export function officialWebIntegrationStatus({ home = homedir(), releaseDir } = {}) {
  const state = readState(home);
  if (state?.enabled !== true) return { enabled: false, healthy: false, state };
  const expectedRelease = releaseDir ?? state.release_dir;
  let expectedBridge;
  try { expectedBridge = realpathSync(join(expectedRelease, 'official-web-bridge')); } catch {
    return { enabled: true, healthy: false, code: 'BRIDGE_RELEASE_MISSING', state };
  }
  const profileRoot = officialWebProfileDir({ home });
  const profile = validOfficialManifest(join(profileRoot, 'package.json'));
  if (!profile.ok) return { enabled: true, healthy: false, code: profile.code, state };
  const dependency = profile.manifest.dependencies?.[OFFICIAL_BRIDGE_PACKAGE];
  const bundled = profile.manifest.dsh.profile.bundles.includes(OFFICIAL_BRIDGE_PACKAGE);
  const linkPath = join(profileRoot, 'node_modules', ...OFFICIAL_BRIDGE_PACKAGE.split('/'));
  let linked = false;
  try { linked = lstatSync(linkPath).isSymbolicLink() && realpathSync(linkPath) === expectedBridge; } catch {}
  return { enabled: true, healthy: Boolean(dependency && bundled && linked), state, linkPath, expectedBridge };
}

export function removeOfficialWebIntegration({ home = homedir(), remember = true, preserveIntent = false } = {}) {
  const profileRoot = officialWebProfileDir({ home });
  const profileManifest = join(profileRoot, 'package.json');
  const profile = validOfficialManifest(profileManifest);
  if (!profile.ok && profile.code !== 'OFFICIAL_WEB_PROFILE_NOT_FOUND') return profile;
  let removed = false;
  if (profile.ok) {
    const result = removeCrewPluginRegistration({ home, name: OFFICIAL_BRIDGE_PACKAGE, profileRoot });
    if (!result.ok) return { ok: false, code: result.code === 'CREW_PROFILE_METADATA_INVALID' ? 'OFFICIAL_WEB_PROFILE_INVALID' : result.code };
    removed = result.removed;
  }
  const previous = readState(home);
  if (remember) writeState(home, {
    ...(previous ?? {}),
    enabled: preserveIntent ? previous?.enabled === true : false,
    package: OFFICIAL_BRIDGE_PACKAGE,
  });
  else {
    const stateFile = officialWebIntegrationStateFile({ home });
    if (existsSync(stateFile)) unlinkSync(stateFile);
  }
  return { ok: true, removed };
}
