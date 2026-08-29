import { execFileSync } from 'node:child_process';

function explicitSource(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : null;
}

function classifyParent(value) {
  const firstLine = String(value ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return 'unknown';
  const command = firstLine.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (command.includes('claude')) return 'claude-code';
  if (command.includes('codex')) return 'codex';
  if (command.includes('zcode')) return 'zcode';
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(command) ? command : 'unknown';
}

function readParentProcess({ platform, pid }) {
  const options = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
    windowsHide: true,
  };
  if (platform === 'win32') {
    return execFileSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").Name`,
    ], options);
  }
  return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], options);
}

export function detectOrchestrator({
  env = process.env,
  platform = process.platform,
  parentPid = process.ppid,
  readParent = readParentProcess,
} = {}) {
  const explicit = explicitSource(env.DSH_ORCHESTRATOR);
  if (explicit) return explicit;
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (!Number.isInteger(parentPid) || parentPid < 1) return 'unknown';
  try {
    return classifyParent(readParent({ platform, pid: parentPid }));
  } catch {
    return 'unknown';
  }
}
