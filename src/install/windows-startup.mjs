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

function defaultStartupDir({ home, env }) {
  if (home === homedir() && env.APPDATA) {
    return join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  }
  return join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function paths({ home, startupDir, env }) {
  const launcherFile = join(home, '.config', 'dsh-crew', 'launchers', WINDOWS_LAUNCHER_FILENAME);
  const resolvedStartupDir = startupDir ?? defaultStartupDir({ home, env });
  return {
    launcherFile,
    startupFile: join(resolvedStartupDir, WINDOWS_STARTUP_FILENAME),
  };
}

function renderVbs(template, launcherFile) {
  const escaped = launcherFile.replace(/"/g, '""');
  return template.replace('__LAUNCHER__', escaped);
}

export function windowsStartupStatus({
  home = homedir(),
  startupDir,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== 'win32') return { supported: false, installed: false, ready: false };
  const resolved = paths({ home, startupDir, env });
  const installed = existsSync(resolved.startupFile) || existsSync(resolved.launcherFile);
  let ready = existsSync(resolved.startupFile) && existsSync(resolved.launcherFile);
  if (ready) {
    try {
      const text = readFileSync(resolved.startupFile, 'utf16le').replace(/^\uFEFF/, '');
      ready = text.includes(resolved.launcherFile);
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
  const sourceVbs = join(root, 'windows', 'start-dsh-crew.vbs');
  if (!existsSync(sourceLauncher) || !existsSync(sourceVbs)) {
    return { ok: false, supported: true, code: 'STARTUP_ASSET_MISSING' };
  }
  const resolved = paths({ home, startupDir, env });
  mkdirSync(dirname(resolved.launcherFile), { recursive: true });
  mkdirSync(dirname(resolved.startupFile), { recursive: true });
  const beforeLauncher = existsSync(resolved.launcherFile) ? readFileSync(resolved.launcherFile) : null;
  const beforeStartup = existsSync(resolved.startupFile) ? readFileSync(resolved.startupFile) : null;
  copyFileSync(sourceLauncher, resolved.launcherFile);
  const rendered = renderVbs(readFileSync(sourceVbs, 'utf8'), resolved.launcherFile);
  writeFileSync(resolved.startupFile, `\uFEFF${rendered}`, 'utf16le');
  const changed = !beforeLauncher?.equals(readFileSync(resolved.launcherFile))
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
  for (const file of [resolved.startupFile, resolved.launcherFile]) {
    if (existsSync(file)) {
      rmSync(file, { force: true });
      removed = true;
    }
  }
  return { ok: true, supported: true, removed, ...resolved };
}
