import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { installOfficialFrontendAssets, officialFrontendAssetsReady } from './official-frontend-assets.mjs';

export const WINDOWS_STARTUP_FILENAME = 'DSH Crew.vbs';
export const WINDOWS_LAUNCHER_FILENAME = 'start-dsh-crew.cmd';
export const WINDOWS_HELPER_FILENAME = 'start-dsh-crew.ps1';
export const WINDOWS_CONTROL_FILENAME = 'supervisor-control.ps1';
export const WINDOWS_SUPERVISOR_ASSET_MANIFEST = 'supervisor-assets.json';

function defaultStartupDir({ home, env }) {
  if (home === homedir() && env.APPDATA) {
    return join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  }
  return join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function paths({ home, startupDir, env }) {
  const launcherFile = join(home, '.config', 'dsh-crew', 'launchers', WINDOWS_LAUNCHER_FILENAME);
  const helperFile = join(home, '.config', 'dsh-crew', 'launchers', WINDOWS_HELPER_FILENAME);
  const controlFile = join(home, '.config', 'dsh-crew', 'launchers', WINDOWS_CONTROL_FILENAME);
  const supervisorManifestFile = join(home, '.config', 'dsh-crew', 'launchers', WINDOWS_SUPERVISOR_ASSET_MANIFEST);
  const resolvedStartupDir = startupDir ?? defaultStartupDir({ home, env });
  return {
    launcherFile,
    helperFile,
    controlFile,
    supervisorManifestFile,
    startupFile: join(resolvedStartupDir, WINDOWS_STARTUP_FILENAME),
  };
}

function renderVbs(template, launcherFile) {
  const escaped = launcherFile.replace(/"/g, '""');
  return template.replace('__LAUNCHER__', escaped);
}

function isManagedStartupFile(file, resolved) {
  try {
    if (file === resolved.startupFile) {
      const text = readFileSync(file, 'utf16le').replace(/^\uFEFF/, '');
      return text.includes(resolved.launcherFile) && (/WScript\.Shell/i.test(text) || /--watch/i.test(text) || /--background/i.test(text));
    }
    if (file === resolved.launcherFile) {
      const text = readFileSync(file, 'utf8');
      return (/DSH Crew Launcher/i.test(text) || /start-dsh-crew\.ps1/i.test(text)) && /dsh-crew/i.test(text);
    }
    if (file === resolved.helperFile) {
      const text = readFileSync(file, 'utf8');
      return /DSH Crew managed Windows launcher/i.test(text) || /DSHCrewServiceSupervisor/i.test(text);
    }
    if (file === resolved.controlFile) {
      const text = readFileSync(file, 'utf8');
      return /DSH Crew Windows supervisor process control/i.test(text) && /Stop-ExactManagedWatcher/i.test(text);
    }
    if (file === resolved.supervisorManifestFile) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return parsed?.schema_version === 1 && parsed.managed_by === 'dsh-crew';
    }
  } catch {
    return false;
  }
  return false;
}

function startupTargetConflicts(resolved) {
  return [resolved.startupFile, resolved.launcherFile, resolved.helperFile, resolved.controlFile, resolved.supervisorManifestFile]
    .filter((file) => existsSync(file) && !isManagedStartupFile(file, resolved));
}

export function windowsStartupStatus({
  home = homedir(),
  root,
  startupDir,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== 'win32') return { supported: false, installed: false, ready: false };
  const resolved = paths({ home, startupDir, env });
  const installed = existsSync(resolved.startupFile)
    || existsSync(resolved.launcherFile)
    || existsSync(resolved.helperFile)
    || existsSync(resolved.controlFile)
    || existsSync(resolved.supervisorManifestFile);
  const components = {
    startup_entry_content: false,
    launcher_content: false,
    helper_content: false,
    control_content: false,
    supervisor_manifest: false,
  };
  if (typeof root === 'string' && root.trim()) {
    try {
      const sourceLauncher = readFileSync(join(root, 'windows', WINDOWS_LAUNCHER_FILENAME), 'utf8');
      const sourceHelper = readFileSync(join(root, 'windows', WINDOWS_HELPER_FILENAME), 'utf8');
      if (sourceHelper.includes('Get-OfficialFrontendOverlay')) components.frontend_overlay = officialFrontendAssetsReady({ home, root });
      const sourceControl = readFileSync(join(root, 'windows', WINDOWS_CONTROL_FILENAME), 'utf8');
      const sourceVbs = readFileSync(join(root, 'windows', 'start-dsh-crew.vbs'), 'utf8');
      const startup = readFileSync(resolved.startupFile, 'utf16le').replace(/^\uFEFF/, '');
      components.startup_entry_content = startup === renderVbs(sourceVbs, resolved.launcherFile);
      components.launcher_content = readFileSync(resolved.launcherFile, 'utf8') === sourceLauncher;
      components.helper_content = readFileSync(resolved.helperFile, 'utf8') === sourceHelper;
      components.control_content = readFileSync(resolved.controlFile, 'utf8') === sourceControl;
      const assets = readWindowsSupervisorAssets({ home });
      components.supervisor_manifest = assets.ok
        && assets.helper_hash === sha256File(join(root, 'windows', WINDOWS_HELPER_FILENAME))
        && assets.control_hash === sha256File(join(root, 'windows', WINDOWS_CONTROL_FILENAME));
    } catch { /* missing or unreadable content remains false */ }
  }
  const missing = Object.entries(components).filter(([, ready]) => !ready).map(([key]) => key);
  return { supported: true, installed, ready: missing.length === 0, components, missing, ...resolved };
}

function sha256File(file) {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return null; }
}

function samePath(left, right) {
  try { return resolve(left).toLowerCase() === resolve(right).toLowerCase(); } catch { return false; }
}

function writeAtomic(file, content) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
  try { renameSync(temp, file); } finally { try { rmSync(temp, { force: true }); } catch {} }
}

export function readWindowsSupervisorAssets({ home = homedir() } = {}) {
  const resolved = paths({ home, env: process.env });
  try {
    const manifest = JSON.parse(readFileSync(resolved.supervisorManifestFile, 'utf8'));
    const helperHash = sha256File(resolved.helperFile);
    const controlHash = sha256File(resolved.controlFile);
    const valid = manifest?.schema_version === 1
      && manifest.managed_by === 'dsh-crew'
      && samePath(manifest.helper_path, resolved.helperFile)
      && samePath(manifest.control_path, resolved.controlFile)
      && /^[a-f0-9]{64}$/u.test(manifest.helper_hash ?? '')
      && /^[a-f0-9]{64}$/u.test(manifest.control_hash ?? '')
      && manifest.helper_hash === helperHash
      && manifest.control_hash === controlHash;
    return valid
      ? { ok: true, helper_path: resolved.helperFile, helper_hash: helperHash, control_path: resolved.controlFile, control_hash: controlHash }
      : { ok: false, code: 'SUPERVISOR_ASSET_MANIFEST_MISMATCH' };
  } catch {
    return { ok: false, code: 'SUPERVISOR_ASSET_MANIFEST_UNAVAILABLE' };
  }
}

export function installWindowsStartup({
  home = homedir(),
  root,
  startupDir,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== 'win32') return { ok: true, supported: false, changed: false };
  if (!root) return { ok: false, supported: true, code: 'STARTUP_SOURCE_REQUIRED' };
  const sourceLauncher = join(root, 'windows', WINDOWS_LAUNCHER_FILENAME);
  const sourceHelper = join(root, 'windows', WINDOWS_HELPER_FILENAME);
  const sourceControl = join(root, 'windows', WINDOWS_CONTROL_FILENAME);
  const sourceVbs = join(root, 'windows', 'start-dsh-crew.vbs');
  if (!existsSync(sourceLauncher) || !existsSync(sourceHelper) || !existsSync(sourceControl) || !existsSync(sourceVbs)) {
    return { ok: false, supported: true, code: 'STARTUP_ASSET_MISSING' };
  }
  const resolved = paths({ home, startupDir, env });
  const conflicts = startupTargetConflicts(resolved);
  if (conflicts.length > 0) {
    return { ok: false, supported: true, code: 'STARTUP_TARGET_COLLISION', conflicts, ...resolved };
  }
  const needsFrontend = readFileSync(sourceHelper, 'utf8').includes('Get-OfficialFrontendOverlay');
  const frontend = needsFrontend ? installOfficialFrontendAssets({ home, root }) : null;
  if (frontend && !frontend.ok) return { ...frontend, supported: true };
  mkdirSync(dirname(resolved.launcherFile), { recursive: true });
  mkdirSync(dirname(resolved.startupFile), { recursive: true });
  const beforeLauncher = existsSync(resolved.launcherFile) ? readFileSync(resolved.launcherFile) : null;
  const beforeHelper = existsSync(resolved.helperFile) ? readFileSync(resolved.helperFile) : null;
  const beforeControl = existsSync(resolved.controlFile) ? readFileSync(resolved.controlFile) : null;
  const beforeManifest = existsSync(resolved.supervisorManifestFile) ? readFileSync(resolved.supervisorManifestFile) : null;
  const beforeStartup = existsSync(resolved.startupFile) ? readFileSync(resolved.startupFile) : null;
  copyFileSync(sourceLauncher, resolved.launcherFile);
  copyFileSync(sourceHelper, resolved.helperFile);
  copyFileSync(sourceControl, resolved.controlFile);
  const supervisorManifest = {
    schema_version: 1,
    managed_by: 'dsh-crew',
    helper_path: resolved.helperFile,
    helper_hash: sha256File(resolved.helperFile),
    control_path: resolved.controlFile,
    control_hash: sha256File(resolved.controlFile),
  };
  writeAtomic(resolved.supervisorManifestFile, `${JSON.stringify(supervisorManifest, null, 2)}\n`);
  if (!readWindowsSupervisorAssets({ home }).ok) {
    return { ok: false, supported: true, code: 'SUPERVISOR_ASSET_MANIFEST_VERIFY_FAILED', ...resolved };
  }
  const rendered = renderVbs(readFileSync(sourceVbs, 'utf8'), resolved.launcherFile);
  writeFileSync(resolved.startupFile, `\uFEFF${rendered}`, 'utf16le');
  const changed = frontend?.changed === true || !beforeLauncher?.equals(readFileSync(resolved.launcherFile))
    || !beforeHelper?.equals(readFileSync(resolved.helperFile))
    || !beforeControl?.equals(readFileSync(resolved.controlFile))
    || !beforeManifest?.equals(readFileSync(resolved.supervisorManifestFile))
    || !beforeStartup?.equals(readFileSync(resolved.startupFile));
  return { ok: true, supported: true, changed, ...resolved };
}

export function uninstallWindowsStartup({
  home = homedir(),
  startupDir,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== 'win32') return { ok: true, supported: false, removed: false };
  const resolved = paths({ home, startupDir, env });
  let removed = false;
  const preserved = [];
  for (const file of [resolved.startupFile, resolved.launcherFile, resolved.helperFile, resolved.controlFile, resolved.supervisorManifestFile]) {
    if (!existsSync(file)) continue;
    if (!isManagedStartupFile(file, resolved)) {
      preserved.push(file);
      continue;
    }
    rmSync(file, { force: true });
    removed = true;
  }
  return { ok: true, supported: true, removed, preserved, ...resolved };
}
