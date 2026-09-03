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

export const OFFICIAL_WEB_READ_ONLY_CODE = 'OFFICIAL_WEB_PROFILE_READ_ONLY';

// The official ~/.dsh/profiles/web tree is a read-only boundary. Crew must
// never install, update, register, unlink, repair, or mutate anything under
// ~/.dsh; the isolated 3210 Crew backend is the only runtime Crew owns.
// ensure/remove therefore fail closed instead of writing the official
// profile. Status probing stays read-only.
export function ensureOfficialWebIntegration({ home = homedir(), releaseDir } = {}) {
  return { ok: false, code: OFFICIAL_WEB_READ_ONLY_CODE };
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
  return { ok: false, code: OFFICIAL_WEB_READ_ONLY_CODE };
}
