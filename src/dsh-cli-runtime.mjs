// DSH CLI/runtime resolution for Crew-owned installs.
//
// The resolver is deliberately independent from the official ~/.dsh state.
// A reusable CLI may live under the Crew DSH_HOME, while global dsh/npx remain
// compatibility fallbacks. Status and uninstall callers can resolve without
// allowing a download.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { crewDshHome, crewProfileDir } from './install/install.mjs';

export const DSH_CLI_PACKAGE = '@deepseek-ai/dsh';
export const CREW_DSH_RUNTIME_DIRNAME = 'runtime';

function defaultFindCommand(name) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(probe, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0) return null;
  return String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function defaultExists(path) {
  try { return existsSync(path); } catch { return false; }
}

function packageVersion(entry, read = readFileSync) {
  try {
    const packageFile = join(entry, '..', '..', 'package.json');
    const parsed = JSON.parse(read(packageFile, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch { return null; }
}

export function crewDshRuntimeRoot({ home = homedir() } = {}) {
  return join(crewDshHome({ home }), CREW_DSH_RUNTIME_DIRNAME);
}

export function crewDshRuntimeEntry({ home = homedir(), platform = process.platform } = {}) {
  const suffix = platform === 'win32' ? '.cmd' : '';
  return join(crewDshRuntimeRoot({ home }), 'node_modules', '.bin', `dsh${suffix}`);
}

export function crewDshRuntimeModule({ home = homedir() } = {}) {
  return join(crewDshRuntimeRoot({ home }), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function isPathLike(value) {
  return typeof value === 'string' && (value.includes('/') || value.includes('\\') || extname(value) === '.cmd' || extname(value) === '.exe');
}

function descriptor({ kind, command, args = [], source, version = null, reusable = false }) {
  return Object.freeze({ kind, command, args: [...args], source, version, reusable });
}

function explicitDescriptor(value, { exists = defaultExists, platform = process.platform } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (isPathLike(trimmed) && !exists(trimmed)) return null;
  if (extname(trimmed).toLowerCase() === '.js') {
    return descriptor({ kind: 'explicit-node', command: process.execPath, args: [trimmed], source: 'explicit', reusable: true });
  }
  return descriptor({ kind: platform === 'win32' && extname(trimmed).toLowerCase() === '.cmd' ? 'explicit-cmd' : 'explicit', command: trimmed, source: 'explicit', reusable: true });
}

/**
 * Resolve a CLI without reading DSH credentials or profile state.
 * `allowDownload` only affects the final npx descriptor; resolution itself
 * never starts a network operation.
 */
export function resolveDshCli({
  home = homedir(),
  env = process.env,
  platform = process.platform,
  exists = defaultExists,
  findCommand = defaultFindCommand,
  allowDownload = false,
  includeCompatibility = true,
  read = readFileSync,
} = {}) {
  const explicit = explicitDescriptor(env.DSH_CREW_DSH_CLI ?? env.DSH_CLI, { exists, platform });
  if (explicit) return explicit;

  const moduleEntry = crewDshRuntimeModule({ home });
  if (exists(moduleEntry)) {
    return descriptor({
      kind: 'crew-runtime',
      command: process.execPath,
      args: [moduleEntry],
      source: 'crew-runtime',
      version: packageVersion(moduleEntry, read),
      reusable: true,
    });
  }

  if (!includeCompatibility) return null;

  const global = findCommand('dsh');
  if (global) return descriptor({ kind: 'global', command: global, source: 'global' });

  const npx = findCommand('npx');
  if (!npx) return null;
  return descriptor({
    kind: allowDownload ? 'npx-download' : 'npx-local',
    command: npx,
    args: allowDownload ? ['--yes', DSH_CLI_PACKAGE] : ['--no-install', DSH_CLI_PACKAGE],
    source: allowDownload ? 'npx-download' : 'npx-local',
  });
}

function quoteWindowsArg(value) {
  const input = String(value);
  if (input.length > 0 && !/[\s"]/u.test(input)) return input;
  let output = '"';
  let slashes = 0;
  for (const char of input) {
    if (char === '\\') { slashes += 1; continue; }
    if (char === '"') {
      output += '\\'.repeat(slashes * 2 + 1) + '"';
    } else {
      output += '\\'.repeat(slashes) + char;
    }
    slashes = 0;
  }
  output += '\\'.repeat(slashes * 2) + '"';
  return output;
}

export { quoteWindowsArg };

/** Build a shell-free invocation, including deterministic Windows .cmd handling. */
export function buildDshInvocation(cli, args = [], { platform = process.platform, comspec = process.env.ComSpec ?? 'cmd.exe' } = {}) {
  const allArgs = [...(cli?.args ?? []), ...args].map(String);
  const command = String(cli?.command ?? '');
  if (platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)) {
    return {
      command: comspec,
      args: ['/d', '/s', '/c', [quoteWindowsArg(command), ...allArgs.map(quoteWindowsArg)].join(' ')],
      shell: false,
    };
  }
  return { command, args: allArgs, shell: false };
}

export function runResolvedDsh(cli, args = [], {
  home = homedir(),
  env = process.env,
  runner = spawnSync,
  platform = process.platform,
  comspec = process.env.ComSpec ?? 'cmd.exe',
} = {}) {
  if (!cli) return { ok: false, status: -1, stdout: '', stderr: 'DSH CLI unavailable' };
  const invocation = buildDshInvocation(cli, args, { platform, comspec });
  const result = runner(invocation.command, invocation.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: invocation.shell,
    env: { ...env, DSH_HOME: crewDshHome({ home }) },
  });
  return {
    ok: result.status === 0,
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    invocation,
  };
}

/**
 * Install a reusable DSH CLI into Crew-owned state. This is the only helper
 * that may invoke a package manager, and callers must explicitly opt into it.
 */
export function ensureCrewDshRuntime({
  home = homedir(),
  packageSpec = DSH_CLI_PACKAGE,
  npmCommand = null,
  pnpmCommand = null,
  findCommand = defaultFindCommand,
  exists = defaultExists,
  runner = spawnSync,
  platform = process.platform,
  comspec = process.env.ComSpec ?? 'cmd.exe',
  env = process.env,
} = {}) {
  const existing = resolveDshCli({ home, env, platform, exists, findCommand, includeCompatibility: false });
  if (existing?.kind === 'crew-runtime') return { ok: true, cli: existing, reused: true };

  const pnpm = pnpmCommand ?? findCommand('pnpm');
  const npm = npmCommand ?? findCommand('npm');
  if (!pnpm && !npm) return { ok: false, code: 'DSH_RUNTIME_INSTALLER_NOT_FOUND', error: 'pnpm/npm unavailable' };
  const runtimeRoot = crewDshRuntimeRoot({ home });
  mkdirSync(runtimeRoot, { recursive: true });
  const packageManager = pnpm
    ? descriptor({ kind: 'pnpm', command: pnpm, source: 'pnpm' })
    : descriptor({ kind: 'npm', command: npm, source: 'npm' });
  const packageArgs = pnpm
    ? ['add', '--dir', runtimeRoot, '--ignore-scripts', packageSpec]
    : ['install', '--prefix', runtimeRoot, '--no-package-lock', '--ignore-scripts', '--omit=dev', packageSpec];
  const invocation = buildDshInvocation(packageManager, packageArgs, { platform, comspec });
  const result = runner(invocation.command, invocation.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: invocation.shell,
    env: { ...env },
  });
  const cli = resolveDshCli({ home, env, platform, exists, findCommand, includeCompatibility: false });
  if (result.status !== 0 || !cli || cli.kind !== 'crew-runtime') {
    return { ok: false, code: 'DSH_RUNTIME_INSTALL_FAILED', error: 'Crew-owned DSH runtime install failed', status: result.status ?? -1 };
  }
  return { ok: true, cli, reused: false, version: cli.version, runtimeRoot };
}

export function describeDshCli(cli) {
  if (!cli) return 'unavailable';
  const version = cli.version ? `@${cli.version}` : '';
  return `${cli.kind}${version}`;
}

/**
 * Remove one Crew plugin registration without invoking a package manager.
 * This is intentionally limited to the derived Crew profile directory so a
 * status/uninstall probe cannot touch the official web profile or download
 * anything merely to remove a stale registration.
 */
export function removeCrewPluginRegistration({ home = homedir(), name, profileRoot = crewProfileDir({ home }) } = {}) {
  if (typeof name !== 'string' || !name || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    return { ok: false, code: 'INVALID_CREW_PLUGIN_NAME' };
  }
  const packageFile = join(profileRoot, 'package.json');
  if (!existsSync(packageFile)) return { ok: true, removed: false };
  let pkg;
  try { pkg = JSON.parse(readFileSync(packageFile, 'utf8')); } catch { return { ok: false, code: 'CREW_PROFILE_METADATA_INVALID' }; }
  const hadDependency = Boolean(pkg.dependencies?.[name]);
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const hadBundle = bundles.includes(name);
  if (!hadDependency && !hadBundle) return { ok: true, removed: false };
  const next = { ...pkg };
  if (hadDependency) {
    next.dependencies = { ...pkg.dependencies };
    delete next.dependencies[name];
    if (Object.keys(next.dependencies).length === 0) delete next.dependencies;
  }
  if (hadBundle) {
    next.dsh = { ...pkg.dsh, profile: { ...pkg.dsh.profile, bundles: bundles.filter((item) => item !== name) } };
  }
  writeFileSync(packageFile, JSON.stringify(next, null, 2) + '\n');
  const packageParts = name.split('/');
  rmSync(join(profileRoot, 'node_modules', ...packageParts), { recursive: true, force: true });
  return { ok: true, removed: true };
}
