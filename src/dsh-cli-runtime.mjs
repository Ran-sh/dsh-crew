// DSH CLI/runtime resolution for Crew-owned installs.
//
// The resolver is deliberately independent from the official ~/.dsh state.
// A reusable CLI may live under the Crew DSH_HOME, while global dsh/npx remain
// compatibility fallbacks. Status and uninstall callers can resolve without
// allowing a download.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { crewDshHome, crewProfileDir } from './install/install.mjs';
import { reconcileProviderDesiredState } from './provider-desired-state.mjs';
import {
  DSH_CLI_PACKAGE,
  TARGET_DSH_VERSION,
  TARGET_DSH_SPEC,
  RETAINED_RUNTIMES_DIRNAME,
} from './dsh-cohort.mjs';

// Re-exported so existing importers keep working while the cohort value now
// lives in exactly one place (src/dsh-cohort.mjs).
export { DSH_CLI_PACKAGE, TARGET_DSH_VERSION, TARGET_DSH_SPEC };
export const CREW_DSH_RUNTIME_DIRNAME = 'runtime';
const CREW_PROFILE_DEFAULT_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
const PROFILE_PATCH_TEMPLATE = '[]\n';
const PROFILE_PNPM_WORKSPACE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n';

function defaultFindCommand(name) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(probe, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0) return null;
  const lines = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  if (process.platform !== 'win32') return lines[0];
  // where.exe may list extensionless npm/sh shims first; those are not
  // directly spawnable by Node on Windows, so prefer a real executable.
  const executable = lines.find((line) => /\.(?:exe|cmd|bat)$/iu.test(line));
  return executable ?? lines[0];
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

export function crewDshRuntimeVersionDir({ home = homedir(), version = TARGET_DSH_VERSION } = {}) {
  return join(crewDshHome({ home }), `runtime-${version}`);
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
 *
 * The caller-supplied `version` defaults to the pinned TARGET. Reuse happens
 * only when the live runtime already matches `version`; a mismatch is
 * reported as DSH_RUNTIME_COHORT_MISMATCH and NEVER upgraded in place.
 * Callers that intend an upgrade must interpret that code as needsMigration
 * and run the staged transactional path — there is deliberately no `force`.
 */
export function ensureCrewDshRuntime({
  home = homedir(),
  version = TARGET_DSH_VERSION,
  packageSpec = `${DSH_CLI_PACKAGE}@${version}`,
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
  // Reuse only when the installed runtime already matches the requested
  // cohort. A stale cohort (e.g. an online 0.1.1-rc.2 runtime) must never be
  // mistaken for the target, and it must never be upgraded in place under a
  // live hub.
  if (existing?.kind === 'crew-runtime' && existing?.version === version) {
    return { ok: true, cli: existing, reused: true };
  }
  if (existing?.kind === 'crew-runtime') {
    return {
      ok: false,
      code: 'DSH_RUNTIME_COHORT_MISMATCH',
      error: `Crew runtime is ${existing.version ?? 'unknown version'} but ${version} is required; refusing in-place upgrade of a live runtime`,
      installed: existing.version ?? null,
      target: version,
    };
  }

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
    return {
      ok: false,
      code: 'DSH_RUNTIME_INSTALL_FAILED',
      error: 'Crew-owned DSH runtime install failed',
      status: result.status ?? -1,
      stderrTail: String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300),
    };
  }
  // Fail closed when the installed cohort drifts from the requested target
  // (registry race, hoisted pollution, partial install).
  if (cli.version !== version) {
    return {
      ok: false,
      code: 'DSH_RUNTIME_INSTALL_VERSION_MISMATCH',
      error: `installed Crew runtime is ${cli.version ?? 'unknown version'} but ${version} is required`,
      installed: cli.version ?? null,
      target: version,
    };
  }
  return { ok: true, cli, reused: false, version: cli.version, runtimeRoot };
}

export function describeDshCli(cli) {
  if (!cli) return 'unavailable';
  const version = cli.version ? `@${cli.version}` : '';
  return `${cli.kind}${version}`;
}

// Shared pnpm/npm install of the pinned DSH cohort into a specific root
// directory. pnpm materializes ABSOLUTE-path .cmd shims and junctions that
// point at the install root's own .pnpm store, so the tree must be installed
// at its FINAL resting path: renaming a pnpm tree breaks every shim. Callers
// that need an atomic swap must install at the live root only after moving
// the old tree aside.
export function installDshInto({
  root,
  version,
  packageSpec = `${DSH_CLI_PACKAGE}@${version}`,
  npmCommand = null,
  pnpmCommand = null,
  findCommand = defaultFindCommand,
  exists = defaultExists,
  runner = spawnSync,
  platform = process.platform,
  comspec = process.env.ComSpec ?? 'cmd.exe',
  env = process.env,
}) {
  const pnpm = pnpmCommand ?? findCommand('pnpm');
  const npm = npmCommand ?? findCommand('npm');
  if (!pnpm && !npm) return { ok: false, code: 'DSH_RUNTIME_INSTALLER_NOT_FOUND', error: 'pnpm/npm unavailable' };
  mkdirSync(root, { recursive: true });
  const packageManager = pnpm
    ? descriptor({ kind: 'pnpm', command: pnpm, source: 'pnpm' })
    : descriptor({ kind: 'npm', command: npm, source: 'npm' });
  const packageArgs = pnpm
    ? ['add', '--dir', root, '--ignore-scripts', packageSpec]
    : ['install', '--prefix', root, '--no-package-lock', '--ignore-scripts', '--omit=dev', packageSpec];
  const invocation = buildDshInvocation(packageManager, packageArgs, { platform, comspec });
  const result = runner(invocation.command, invocation.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: invocation.shell,
    env: { ...env },
  });
  if (result.status !== 0) {
    return {
      ok: false,
      code: 'DSH_RUNTIME_INSTALL_FAILED',
      error: 'Crew runtime install failed',
      status: result.status ?? -1,
      stderrTail: String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300),
    };
  }
  const moduleEntry = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!exists(moduleEntry)) {
    return { ok: false, code: 'DSH_RUNTIME_INSTALL_INCOMPLETE', error: 'runtime entry missing after install' };
  }
  const installedVersion = packageVersion(moduleEntry);
  if (installedVersion !== version) {
    return {
      ok: false,
      code: 'DSH_RUNTIME_INSTALL_VERSION_MISMATCH',
      error: `installed Crew runtime is ${installedVersion ?? 'unknown version'} but ${version} is required`,
      installed: installedVersion ?? null,
      target: version,
    };
  }
  return { ok: true, root, version: installedVersion };
}

// Staged cohort migration: install the target cohort into a versioned
// directory WITHOUT touching the live runtime/, verify its manifest, then
// report the staged root for an atomic switch by the caller (stop owned
// 3210 -> swap directories -> clean restart -> identity check). Never
// upgrades a live runtime in place.
//
// NOTE: pnpm trees embed absolute paths in .cmd shims and junctions, so a
// staged tree CANNOT be renamed onto the live root afterwards. migrate
//CrewDshRuntime therefore installs at the live root in place (after parking
// the old tree); stageCrewDshRuntime remains for callers that consume the
// stage dir at its fixed versioned path (tests, dry runs, audits).
export function stageCrewDshRuntime({
  home = homedir(),
  version = TARGET_DSH_VERSION,
  packageSpec = `${DSH_CLI_PACKAGE}@${version}`,
  npmCommand = null,
  pnpmCommand = null,
  findCommand = defaultFindCommand,
  exists = defaultExists,
  runner = spawnSync,
  platform = process.platform,
  comspec = process.env.ComSpec ?? 'cmd.exe',
  env = process.env,
  read = readFileSync,
} = {}) {
  const stagedRoot = crewDshRuntimeVersionDir({ home, version });
  // Clean/recreate the versioned stage dir: a failed older attempt must
  // never contaminate the next staging.
  try { rmSync(stagedRoot, { recursive: true, force: true }); } catch {}
  const installed = installDshInto({
    root: stagedRoot,
    version,
    packageSpec,
    npmCommand,
    pnpmCommand,
    findCommand,
    exists,
    runner,
    platform,
    comspec,
    env,
  });
  if (!installed.ok) {
    const code = installed.code === 'DSH_RUNTIME_INSTALL_FAILED'
      ? 'DSH_RUNTIME_STAGE_FAILED'
      : installed.code === 'DSH_RUNTIME_INSTALL_INCOMPLETE'
        ? 'DSH_RUNTIME_STAGE_INCOMPLETE'
        : installed.code;
    return { ...installed, code, error: code === 'DSH_RUNTIME_STAGE_FAILED' ? 'staged Crew runtime install failed' : installed.error };
  }
  const stagedModule = join(stagedRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!exists(stagedModule)) {
    return { ok: false, code: 'DSH_RUNTIME_STAGE_INCOMPLETE', error: 'staged runtime entry missing' };
  }
  const stagedVersion = packageVersion(stagedModule, read);
  if (stagedVersion !== version) {
    return {
      ok: false,
      code: 'DSH_RUNTIME_INSTALL_VERSION_MISMATCH',
      error: `staged Crew runtime is ${stagedVersion ?? 'unknown version'} but ${version} is required`,
      installed: stagedVersion ?? null,
      target: version,
    };
  }
  return { ok: true, stagedRoot, version: stagedVersion };
}

// Full cohort migration transaction (caller holds the update lock):
// stop owned 3210 -> park the live tree (rename to prev, its shims stay
// valid because the tree returns to the same path on rollback) -> install
// the target cohort AT THE LIVE ROOT (pnpm shims are absolute-path, so the
// tree must be born at its final resting path; a renamed pnpm tree has
// dangling shims) -> restart -> identity verify -> rollback on any failure.
// stopOwned/startOwned/verifyOwned have NO defaults: a missing callback
// fails closed instead of pretending an unverified step succeeded.
//
// prepareOnly=true stops + swaps the tree but NEVER starts the process:
// the caller (a pair-ordered rollback/compensation) will activate the
// matching Crew payload and start exactly once itself. The parked prior
// tree is returned as prevRoot for durable retention by the caller.
export async function migrateCrewDshRuntime({
  home = homedir(),
  version = TARGET_DSH_VERSION,
  stageOptions = {},
  stopOwned,
  startOwned,
  verifyOwned,
  rename = renameSync,
  log = () => {},
  prepareOnly = false,
} = {}) {
  const liveRoot = crewDshRuntimeRoot({ home });
  if (typeof stopOwned !== 'function') {
    return { ok: false, code: 'DSH_RUNTIME_MIGRATION_CALLBACKS_MISSING', error: 'stop callback is required' };
  }
  if (!prepareOnly && (typeof startOwned !== 'function' || typeof verifyOwned !== 'function')) {
    return { ok: false, code: 'DSH_RUNTIME_MIGRATION_CALLBACKS_MISSING', error: 'start/verify callbacks are required unless prepareOnly' };
  }
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const prevRoot = join(crewDshHome({ home }), `runtime-prev-${nonce}`);
  const stop = await stopOwned();
  if (!stop.ok) {
    return { ok: false, code: stop.code ?? 'DSH_RUNTIME_STOP_FAILED', error: stop.error ?? 'could not stop owned 3210' };
  }
  let liveMoved = false;
  try {
    if (existsSync(liveRoot)) {
      rename(liveRoot, prevRoot);
      liveMoved = true;
    }
    mkdirSync(liveRoot, { recursive: true });
  } catch (error) {
    // Park failed: restore the live tree before reporting.
    let recovery = { ok: false };
    try {
      if (liveMoved && existsSync(prevRoot) && !existsSync(liveRoot)) rename(prevRoot, liveRoot);
      if (!prepareOnly) {
        const restarted = await startOwned();
        recovery = restarted?.ok ? { ok: true } : { ok: false, code: restarted?.code ?? 'DSH_RUNTIME_RESTART_FAILED' };
      } else {
        recovery = { ok: true };
      }
    } catch (recoveryError) {
      recovery = { ok: false, code: 'DSH_RUNTIME_SWAP_RECOVERY_FAILED', error: String(recoveryError?.message ?? recoveryError) };
    }
    return { ok: false, code: 'DSH_RUNTIME_PARK_FAILED', error: String(error?.message ?? error), recovery };
  }
  // Install the target cohort AT the live root so every pnpm shim/junction
  // carries the correct final absolute path.
  const installed = installDshInto({ root: liveRoot, version, ...stageOptions });
  if (!installed.ok) {
    const recovery = await rollbackRuntimeSwap({ liveRoot, prevRoot, stopOwned, startOwned, rename, prepareOnly });
    return { ok: false, code: installed.code ?? 'DSH_RUNTIME_INSTALL_FAILED', error: installed.error ?? 'runtime install at live root failed', recovery };
  }
  if (prepareOnly) {
    log(`- runtime tree prepared at live root (@${version}); process not started`);
    return { ok: true, version, liveRoot, prevRoot, prepared: true };
  }
  const start = await startOwned();
  if (!start.ok) {
    const recovery = await rollbackRuntimeSwap({ liveRoot, prevRoot, stopOwned, startOwned, rename });
    return { ok: false, code: start.code ?? 'DSH_RUNTIME_START_FAILED', error: start.error ?? 'restart after install failed', recovery };
  }
  const verified = await verifyOwned();
  if (!verified.ok) {
    const recovery = await rollbackRuntimeSwap({ liveRoot, prevRoot, stopOwned, startOwned, rename });
    return { ok: false, code: verified.code ?? 'DSH_RUNTIME_VERIFY_FAILED', error: verified.error ?? 'identity check failed', recovery };
  }
  // Retain the prior cohort under retained-runtimes/<version> instead of
  // deleting it: a later cross-cohort rollback can restore it offline with
  // no registry round-trip. Retention is best-effort (a failure here must
  // not fail the migration), and an existing retained copy of the same
  // version is replaced so the retained set always holds the newest tree.
  retainPriorRuntime({ home, prevRoot });
  log(`- runtime cohort migrated to ${version}`);
  return { ok: true, version, liveRoot };
}

async function rollbackRuntimeSwap({ liveRoot, prevRoot, stopOwned, startOwned, rename = renameSync, prepareOnly = false }) {
  const recovery = { stoppedCandidate: false, restore: false, restart: false };
  // The failed candidate 3210 may still be running against the tree we are
  // about to replace: stop it FIRST, otherwise the swap races a live
  // process (and on Windows the live handles can fail the rename/delete).
  if (typeof stopOwned === 'function') {
    try {
      const stopped = await stopOwned();
      recovery.stoppedCandidate = stopped?.ok === true;
      if (!recovery.stoppedCandidate) recovery.stopError = stopped?.code ?? stopped?.error ?? 'candidate stop failed';
    } catch (error) {
      recovery.stopError = String(error?.message ?? error);
    }
    if (!recovery.stoppedCandidate) {
      recovery.ok = false;
      return recovery;
    }
  }
  try { rmSync(liveRoot, { recursive: true, force: true }); } catch {}
  try {
    if (existsSync(prevRoot)) { rename(prevRoot, liveRoot); recovery.restore = true; }
  } catch (error) {
    recovery.restoreError = String(error?.message ?? error);
  }
  if (prepareOnly) {
    recovery.ok = recovery.restore === true;
    return recovery;
  }
  try {
    const restarted = await startOwned();
    recovery.restart = restarted?.ok === true;
    if (!recovery.restart) recovery.restartCode = restarted?.code ?? 'DSH_RUNTIME_RESTART_FAILED';
  } catch (error) {
    recovery.restartError = String(error?.message ?? error);
  }
  recovery.ok = recovery.restore === true && recovery.restart === true;
  return recovery;
}

// ---- retained runtime cohorts -------------------------------------------------

function retainedRuntimesRoot({ home }) {
  return join(crewDshHome({ home }), RETAINED_RUNTIMES_DIRNAME);
}

function retainedRuntimeDir({ home, version }) {
  return join(retainedRuntimesRoot({ home }), version);
}

// Probe the dsh package version inside a runtime tree (live or prev/retained).
function runtimeTreeVersion(root, read = readFileSync) {
  if (!root) return null;
  try {
    const file = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    const parsed = JSON.parse(read(file, 'utf8'));
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null;
  } catch { return null; }
}

// Best-effort retention of the swapped-out prior runtime tree. Never throws
// and never fails the caller: retention is an optimization for offline
// rollback, not a correctness requirement of the migration itself.
function retainPriorRuntime({ home, prevRoot, rename = renameSync }) {
  try {
    if (!existsSync(prevRoot)) return { ok: true, retained: false };
    const version = runtimeTreeVersion(prevRoot);
    if (!version) {
      // No version to key retention on; the tree is unreadable junk.
      try { rmSync(prevRoot, { recursive: true, force: true }); } catch {}
      return { ok: true, retained: false, reason: 'prior tree version unreadable; removed' };
    }
    const retainedRoot = retainedRuntimesRoot({ home });
    const target = retainedRuntimeDir({ home, version });
    mkdirSync(retainedRoot, { recursive: true });
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    rename(prevRoot, target);
    return { ok: true, retained: true, version, path: target };
  } catch (error) {
    // A failed retain must not fail an otherwise-successful migration, and it
    // must NOT delete the parked prior tree: that tree is the only offline
    // rollback copy of the previous cohort. Leave it in place (a later
    // operator/GC pass can retry or reap it) and report the failure loudly.
    return { ok: false, retained: false, prevRoot, error: String(error?.message ?? error) };
  }
}

// Locate a usable retained cohort tree. Returns the retained path when one
// exists and its manifest reports the requested version; otherwise null.
export function findRetainedRuntime({ home = homedir(), version, exists = existsSync, read = readFileSync } = {}) {
  if (typeof version !== 'string' || version.length === 0) return null;
  const dir = retainedRuntimeDir({ home, version });
  if (!exists(dir)) return null;
  if (runtimeTreeVersion(dir, read) !== version) return null;
  return dir;
}

// Offline cohort restore for cross-cohort rollback: move the retained tree
// back onto live runtime/. The caller must hold the update lock.
//
// Pair-ordering contract: with prepareOnly=false this helper ALSO starts and
// verifies the 3210, which is only safe when the caller has already
// activated the matching Crew payload. Callers that must activate the
// payload FIRST (rollback/compensation pair transition) pass prepareOnly=true
// to swap the tree WITHOUT starting the process, then activate the payload,
// then start once and dual-verify. On success the retained copy is consumed
// (moved), so a subsequent rollback to the same cohort re-stages from the
// registry.
export async function restoreRetainedRuntime({
  home = homedir(),
  version,
  stopOwned,
  startOwned,
  verifyOwned,
  rename = renameSync,
  log = () => {},
  prepareOnly = false,
} = {}) {
  const retained = findRetainedRuntime({ home, version });
  if (!retained) {
    return { ok: false, code: 'DSH_RUNTIME_RETAINED_MISSING', error: `no retained runtime for cohort ${version}` };
  }
  if (typeof stopOwned !== 'function') {
    return { ok: false, code: 'DSH_RUNTIME_MIGRATION_CALLBACKS_MISSING', error: 'stop callback is required' };
  }
  if (!prepareOnly && (typeof startOwned !== 'function' || typeof verifyOwned !== 'function')) {
    return { ok: false, code: 'DSH_RUNTIME_MIGRATION_CALLBACKS_MISSING', error: 'start/verify callbacks are required unless prepareOnly' };
  }
  const liveRoot = crewDshRuntimeRoot({ home });
  const stop = await stopOwned();
  if (!stop.ok) {
    return { ok: false, code: stop.code ?? 'DSH_RUNTIME_STOP_FAILED', error: stop.error ?? 'could not stop owned 3210' };
  }
  try {
    if (existsSync(liveRoot)) rmSync(liveRoot, { recursive: true, force: true });
    rename(retained, liveRoot);
  } catch (error) {
    // Restore the pre-existing live tree is impossible (it was replaced only
    // on success above); report and let the caller reconcile.
    return { ok: false, code: 'DSH_RUNTIME_RESTORE_SWAP_FAILED', error: String(error?.message ?? error) };
  }
  if (prepareOnly) {
    log(`- runtime tree prepared offline from retained tree (@${version}); process not started`);
    return { ok: true, version, liveRoot, prepared: true };
  }
  const start = await startOwned();
  if (!start.ok) {
    return { ok: false, code: start.code ?? 'DSH_RUNTIME_START_FAILED', error: start.error ?? 'restart after restore failed', restored: true };
  }
  const verified = await verifyOwned();
  if (!verified.ok) {
    return { ok: false, code: verified.code ?? 'DSH_RUNTIME_VERIFY_FAILED', error: verified.error ?? 'identity check after restore failed', restored: true };
  }
  log(`- runtime cohort restored offline from retained tree (@${version})`);
  return { ok: true, version, liveRoot };
}

// GC retained runtimes that no release pins. A retained cohort is needed only
// while some managed release (current or retained) declares it as its exact
// @deepseek-ai/dsh dependency. Best-effort; never throws.
export function gcRetainedRuntimes({ home = homedir(), releases = [], log = () => {} } = {}) {
  const root = retainedRuntimesRoot({ home });
  if (!existsSync(root)) return [];
  const needed = new Set();
  for (const release of releases) {
    const spec = payloadDshSpec(release);
    if (spec && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) needed.add(spec);
  }
  const removed = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!needed.has(name)) {
      try { rmSync(dir, { recursive: true, force: true }); removed.push(name); } catch { /* best effort */ }
    }
  }
  return removed;
}

// Read the exact @deepseek-ai/dsh pin from a payload manifest (dependencies
// first, then peerDependencies). Exact pins only: a range or absence yields
// null so callers fail closed instead of guessing a cohort.
function payloadDshSpec(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const direct = manifest.dependencies?.['@deepseek-ai/dsh'];
  if (typeof direct === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(direct)) return direct;
  const peer = manifest.peerDependencies?.['@deepseek-ai/dsh'];
  if (typeof peer === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(peer)) return peer;
  return null;
}

export function payloadDshVersion(manifest) {
  return payloadDshSpec(manifest);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafePackageName(name) {
  return typeof name === 'string'
    && /^(?:@[^/\s]+\/)?[^/\s]+$/u.test(name)
    && !name.split('/').some((part) => part === '.' || part === '..');
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function fileSpec(target) {
  return `link:${target.replace(/\\/g, '/')}`;
}

function profileLinkPath(profileRoot, name) {
  return join(profileRoot, 'node_modules', ...name.split('/'));
}

function readPluginRoot(root, expectedName) {
  if (typeof root !== 'string' || !isAbsolute(root)) return { ok: false, code: 'INVALID_CREW_PLUGIN_ROOT' };
  let targetRoot;
  try { targetRoot = realpathSync(root); } catch { return { ok: false, code: 'CREW_PLUGIN_ROOT_NOT_FOUND' }; }
  const packageFile = join(targetRoot, 'package.json');
  let pkg;
  try { pkg = JSON.parse(readFileSync(packageFile, 'utf8')); } catch { return { ok: false, code: 'CREW_PLUGIN_MANIFEST_INVALID' }; }
  if (!isObject(pkg) || !isSafePackageName(pkg.name) || (expectedName !== undefined && pkg.name !== expectedName)) {
    return { ok: false, code: 'CREW_PLUGIN_MANIFEST_INVALID' };
  }
  const patchSpec = pkg.dsh?.bundle?.patch;
  if (typeof patchSpec !== 'string' || !patchSpec.trim()) return { ok: false, code: 'CREW_PLUGIN_BUNDLE_INVALID' };
  const patchPath = resolve(targetRoot, patchSpec);
  if (!isWithin(targetRoot, patchPath) || !existsSync(patchPath)) return { ok: false, code: 'CREW_PLUGIN_BUNDLE_INVALID' };
  return { ok: true, targetRoot, packageFile, packageName: pkg.name, packageVersion: pkg.version ?? null, patchPath, pkg };
}

function readProfileManifestForRegistration(profileRoot, { create = true, defaultBundles = CREW_PROFILE_DEFAULT_BUNDLES } = {}) {
  const profileManifest = join(profileRoot, 'package.json');
  if (!existsSync(profileManifest)) {
    if (!create) return { ok: false, code: 'PROFILE_NOT_FOUND', profileManifest };
    return {
      profileManifest,
      manifest: {
        name: `dsh-profile-${profileRoot.split(/[\\/]/u).at(-1)}`,
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [...defaultBundles] } },
      },
      created: true,
    };
  }
  let manifest;
  try { manifest = JSON.parse(readFileSync(profileManifest, 'utf8')); } catch { return { ok: false, code: 'CREW_PROFILE_METADATA_INVALID' }; }
  if (!isObject(manifest)) return { ok: false, code: 'CREW_PROFILE_METADATA_INVALID' };
  if (manifest.dependencies !== undefined && !isObject(manifest.dependencies)) return { ok: false, code: 'CREW_PROFILE_METADATA_INVALID' };
  if (manifest.dependencies && Object.values(manifest.dependencies).some((value) => typeof value !== 'string')) {
    return { ok: false, code: 'CREW_PROFILE_METADATA_INVALID' };
  }
  if (manifest.dsh !== undefined && !isObject(manifest.dsh)) return { ok: false, code: 'CREW_PROFILE_METADATA_INVALID' };
  if (manifest.dsh?.profile !== undefined && !isObject(manifest.dsh.profile)) return { ok: false, code: 'CREW_PROFILE_METADATA_INVALID' };
  const bundles = manifest.dsh?.profile?.bundles;
  if (bundles !== undefined && (!Array.isArray(bundles) || bundles.some((name) => !isSafePackageName(name)))) {
    return { ok: false, code: 'CREW_PROFILE_METADATA_INVALID' };
  }
  return { profileManifest, manifest, created: false };
}

function ensureProfileScaffold(profileRoot) {
  mkdirSync(profileRoot, { recursive: true });
  let changed = false;
  const patchFile = join(profileRoot, 'cordis.patch.yml');
  if (!existsSync(patchFile)) { writeFileSync(patchFile, PROFILE_PATCH_TEMPLATE); changed = true; }
  const workspaceFile = join(profileRoot, 'pnpm-workspace.yaml');
  if (!existsSync(workspaceFile)) { writeFileSync(workspaceFile, PROFILE_PNPM_WORKSPACE); changed = true; }
  return changed;
}

function readCrewTombstones(home) {
  const lifecycleFile = join(dirname(crewDshHome({ home })), 'provider-lifecycle.json');
  if (!existsSync(lifecycleFile)) return { ok: true, tombstones: {} };
  try {
    const state = JSON.parse(readFileSync(lifecycleFile, 'utf8'));
    return { ok: true, tombstones: state?.tombstones && typeof state.tombstones === 'object' && !Array.isArray(state.tombstones) ? state.tombstones : {} };
  } catch { return { ok: false, code: 'PROVIDER_LIFECYCLE_STATE_INVALID' }; }
}

function reconcileCrewProfileProviders({ home, profileRoot }) {
  const patchFile = join(profileRoot, 'cordis.patch.yml');
  if (!existsSync(patchFile)) return { ok: true, changed: false, removed: [] };
  const lifecycle = readCrewTombstones(home);
  if (!lifecycle.ok) return lifecycle;
  const source = readFileSync(patchFile, 'utf8');
  if (source.trim() === '[]') return { ok: true, changed: false, removed: [] };
  const reconciled = reconcileProviderDesiredState(source, { tombstones: lifecycle.tombstones });
  if (!reconciled.ok) return reconciled;
  if (reconciled.changed) writeFileSync(patchFile, reconciled.text);
  return reconciled;
}

function ensureDirectoryLink(linkPath, targetRoot) {
  let stat;
  try { stat = lstatSync(linkPath); } catch { stat = null; }
  if (stat && !stat.isSymbolicLink()) return { ok: false, code: 'CREW_PLUGIN_LINK_CONFLICT' };
  if (stat) {
    try {
      if (realpathSync(linkPath) === targetRoot) return { ok: true, changed: false };
    } catch {}
    unlinkSync(linkPath);
  }
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(targetRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  return { ok: true, changed: true };
}

/**
 * Register a local Crew plugin without invoking DSH's pnpm-forwarding plugin
 * command. The profile manifest and one loader-visible directory link are the
 * only state changed; no dependency resolution or policy bypass is attempted.
 */
export function ensurePluginRegistration({
  profileRoot,
  root,
  name,
  createProfile = true,
  defaultBundles = CREW_PROFILE_DEFAULT_BUNDLES,
} = {}) {
  const plugin = readPluginRoot(root, name);
  if (!plugin.ok) return plugin;
  if (typeof profileRoot !== 'string' || !isAbsolute(profileRoot)) return { ok: false, code: 'INVALID_PROFILE_ROOT' };
  const profile = readProfileManifestForRegistration(profileRoot, { create: createProfile, defaultBundles });
  if (profile.ok === false) return profile;
  const scaffoldChanged = createProfile ? ensureProfileScaffold(profileRoot) : false;
  const current = profile.manifest;
  const dependencies = { ...(current.dependencies ?? {}) };
  const currentBundles = current.dsh?.profile?.bundles ?? [...CREW_PROFILE_DEFAULT_BUNDLES];
  const nextBundles = [];
  let seen = false;
  for (const bundle of currentBundles) {
    if (bundle === plugin.packageName) {
      if (!seen) { nextBundles.push(bundle); seen = true; }
    } else nextBundles.push(bundle);
  }
  if (!seen) nextBundles.push(plugin.packageName);
  dependencies[plugin.packageName] = fileSpec(plugin.targetRoot);
  const next = {
    ...current,
    dependencies,
    dsh: {
      ...(current.dsh ?? {}),
      profile: { ...(current.dsh?.profile ?? {}), bundles: nextBundles },
    },
  };
  const manifestChanged = JSON.stringify(current) !== JSON.stringify(next) || profile.created;
  const linkPath = profileLinkPath(profileRoot, plugin.packageName);
  let link;
  try { link = ensureDirectoryLink(linkPath, plugin.targetRoot); } catch { return { ok: false, code: 'CREW_PLUGIN_LINK_FAILED' }; }
  if (!link.ok) return link;
  try {
    if (manifestChanged) writeFileSync(profile.profileManifest, JSON.stringify(next, null, 2) + '\n');
    // Resolve the intended package entry from the validated checkout. Node's
    // package-name resolution cache can retain the old target after a stale
    // junction is replaced in the same process, so loader visibility is proven
    // by the link target plus a normal package entry resolution from that
    // target rather than by trusting a cached package-name lookup.
    const resolvedEntry = createRequire(join(plugin.targetRoot, 'package.json')).resolve('.');
    const resolvedRoot = realpathSync(linkPath);
    if (resolvedRoot !== plugin.targetRoot || !isWithin(plugin.targetRoot, realpathSync(resolvedEntry))) {
      return { ok: false, code: 'CREW_PLUGIN_NOT_LOADABLE' };
    }
    return {
      ok: true,
      changed: scaffoldChanged || manifestChanged || link.changed,
      profileRoot,
      profileManifest: profile.profileManifest,
      linkPath,
      targetRoot: plugin.targetRoot,
      packageName: plugin.packageName,
      packageVersion: plugin.packageVersion,
      patchPath: plugin.patchPath,
      resolvedEntry,
    };
  } catch { return { ok: false, code: 'CREW_PLUGIN_NOT_LOADABLE' }; }
}

export function ensureCrewPluginRegistration({ home = homedir(), root, name } = {}) {
  const result = ensurePluginRegistration({ profileRoot: crewProfileDir({ home }), root, name });
  if (!result.ok) return result;
  const reconciled = reconcileCrewProfileProviders({ home, profileRoot: result.profileRoot });
  if (!reconciled.ok) return reconciled;
  return { ...result, changed: result.changed || reconciled.changed, provider_reconciliation: reconciled.removed ?? [] };
}

/**
 * Remove one Crew plugin registration without invoking a package manager.
 * This is intentionally limited to the derived Crew profile directory so a
 * status/uninstall probe cannot touch the official web profile or download
 * anything merely to remove a stale registration.
 */
export function removeCrewPluginRegistration({ home = homedir(), name, profileRoot = crewProfileDir({ home }) } = {}) {
  if (!isSafePackageName(name)) {
    return { ok: false, code: 'INVALID_CREW_PLUGIN_NAME' };
  }
  const packageFile = join(profileRoot, 'package.json');
  if (!existsSync(packageFile)) return { ok: true, removed: false };
  let pkg;
  try { pkg = JSON.parse(readFileSync(packageFile, 'utf8')); } catch { return { ok: false, code: 'CREW_PROFILE_METADATA_INVALID' }; }
  if (!isObject(pkg)
    || (pkg.dependencies !== undefined && !isObject(pkg.dependencies))
    || (pkg.dsh !== undefined && !isObject(pkg.dsh))
    || (pkg.dsh?.profile !== undefined && !isObject(pkg.dsh.profile))
    || (pkg.dsh?.profile?.bundles !== undefined
      && (!Array.isArray(pkg.dsh.profile.bundles)
        || pkg.dsh.profile.bundles.some((item) => !isSafePackageName(item))))) {
    return { ok: false, code: 'CREW_PROFILE_METADATA_INVALID' };
  }
  const hadDependency = Boolean(pkg.dependencies?.[name]);
  const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const hadBundle = bundles.includes(name);
  if (!hadDependency && !hadBundle) return { ok: true, removed: false };
  const linkPath = profileLinkPath(profileRoot, name);
  let linkStat;
  try { linkStat = lstatSync(linkPath); } catch { linkStat = null; }
  if (linkStat && !linkStat.isSymbolicLink()) return { ok: false, code: 'CREW_PLUGIN_LINK_CONFLICT' };
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
  if (linkStat) unlinkSync(linkPath);
  return { ok: true, removed: true };
}
