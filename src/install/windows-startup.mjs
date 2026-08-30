import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const WINDOWS_STARTUP_FILENAME = 'DSH Crew.vbs';
export const WINDOWS_LAUNCHER_FILENAME = 'start-dsh-crew.cmd';
export const WINDOWS_HELPER_FILENAME = 'start-dsh-crew.ps1';

function defaultStartupDir({ home, env }) {
  if (home === homedir() && env.APPDATA) {
    return join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  }
  return join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function paths({ home, startupDir, env }) {
  const launcherFile = join(home, '.config', 'dsh-crew', 'launchers', WINDOWS_LAUNCHER_FILENAME);
  const helperFile = join(home, '.config', 'dsh-crew', 'launchers', WINDOWS_HELPER_FILENAME);
  const resolvedStartupDir = startupDir ?? defaultStartupDir({ home, env });
  return {
    launcherFile,
    helperFile,
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
  } catch {
    return false;
  }
  return false;
}

function startupTargetConflicts(resolved) {
  return [resolved.startupFile, resolved.launcherFile, resolved.helperFile]
    .filter((file) => existsSync(file) && !isManagedStartupFile(file, resolved));
}

export function windowsStartupStatus({
  home = homedir(),
  startupDir,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== 'win32') return { supported: false, installed: false, ready: false };
  const resolved = paths({ home, startupDir, env });
  const installed = existsSync(resolved.startupFile)
    || existsSync(resolved.launcherFile)
    || existsSync(resolved.helperFile);
  let ready = existsSync(resolved.startupFile)
    && existsSync(resolved.launcherFile)
    && existsSync(resolved.helperFile);
  if (ready) {
    try {
      const startup = readFileSync(resolved.startupFile, 'utf16le').replace(/^\uFEFF/, '');
      const launcher = readFileSync(resolved.launcherFile, 'utf8');
      const helper = readFileSync(resolved.helperFile, 'utf8');
      ready = startup.includes(resolved.launcherFile)
        && startup.includes('--watch')
        && launcher.includes(WINDOWS_HELPER_FILENAME)
        && helper.includes('DSH Crew managed Windows launcher')
        && helper.includes('DSHCrewServiceSupervisor');
    } catch { ready = false; }
  }
  return { supported: true, installed, ready, ...resolved };
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
  const sourceVbs = join(root, 'windows', 'start-dsh-crew.vbs');
  if (!existsSync(sourceLauncher) || !existsSync(sourceHelper) || !existsSync(sourceVbs)) {
    return { ok: false, supported: true, code: 'STARTUP_ASSET_MISSING' };
  }
  const resolved = paths({ home, startupDir, env });
  const conflicts = startupTargetConflicts(resolved);
  if (conflicts.length > 0) {
    return { ok: false, supported: true, code: 'STARTUP_TARGET_COLLISION', conflicts, ...resolved };
  }
  mkdirSync(dirname(resolved.launcherFile), { recursive: true });
  mkdirSync(dirname(resolved.startupFile), { recursive: true });
  const beforeLauncher = existsSync(resolved.launcherFile) ? readFileSync(resolved.launcherFile) : null;
  const beforeHelper = existsSync(resolved.helperFile) ? readFileSync(resolved.helperFile) : null;
  const beforeStartup = existsSync(resolved.startupFile) ? readFileSync(resolved.startupFile) : null;
  copyFileSync(sourceLauncher, resolved.launcherFile);
  copyFileSync(sourceHelper, resolved.helperFile);
  const rendered = renderVbs(readFileSync(sourceVbs, 'utf8'), resolved.launcherFile);
  writeFileSync(resolved.startupFile, `\uFEFF${rendered}`, 'utf16le');
  const changed = !beforeLauncher?.equals(readFileSync(resolved.launcherFile))
    || !beforeHelper?.equals(readFileSync(resolved.helperFile))
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
  for (const file of [resolved.startupFile, resolved.launcherFile, resolved.helperFile]) {
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
