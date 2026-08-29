#!/usr/bin/env node
// One-click DSH Crew installer / uninstaller / status.
//
//   node scripts/setup.mjs install [--dry-run]
//   node scripts/setup.mjs uninstall [--dry-run] [--purge]
//   node scripts/setup.mjs status

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as realInstaller from '../src/install/install.mjs';
import { crewDshHome, crewProfileDir, CREW_PROFILE_NAME } from '../src/install/install.mjs';
import {
  ensureCrewDshRuntime,
  ensureCrewPluginRegistration,
  resolveDshCli,
  runResolvedDsh,
  describeDshCli,
  removeCrewPluginRegistration,
} from '../src/dsh-cli-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function commandExists(name) {
  const r = spawnSync(/^win/.test(process.platform) ? 'where' : 'which', [name], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: opts.shell === true, cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
  });
  return { ok: r.status === 0, status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Detect the DSH CLI. `allowDownload` is intentionally opt-in: installation
 * may use `npx -y` to fetch DSH, while status/uninstall probes never trigger a
 * network download merely by checking availability.
 *
 * The returned descriptor is the CLI base only; every invocation is built by
 * `runDsh` with the dedicated dsh-crew profile and the Crew DSH_HOME in the
 * child process environment. The official ``web`` profile is never a target.
 */
export function detectDsh({ allowDownload = false, home = homedir(), includeCompatibility = true } = {}) {
  const resolved = resolveDshCli({
    home,
    allowDownload,
    includeCompatibility,
  });
  if (!resolved) return null;
  return { ...resolved, cli: resolved.command, description: describeDshCli(resolved) };
}

/**
 * Run a DSH plugin command against the dedicated Crew profile under the
 * Crew-owned DSH_HOME. `home` is the "user home" base used to derive that
 * isolated home, so tests can point it at a disposable root.
 */
export function runDsh(dsh, args, { home = homedir() } = {}) {
  const resolved = dsh?.command
    ? dsh
    : { kind: dsh?.kind ?? 'legacy', command: dsh?.cli ?? dsh, args: [] };
  return runResolvedDsh(resolved, ['plugin', '--profile', CREW_PROFILE_NAME, ...args], { home });
}

export function readPackageName(root = ROOT) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name; } catch { return null; }
}

export function checkRoot(root = ROOT) {
  return existsSync(join(root, 'package.json'))
    && existsSync(join(root, 'src', 'server.mjs'))
    && existsSync(join(root, 'cordis.patch.yml'));
}

export function depsPresent(root = ROOT) {
  return existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk'))
    && existsSync(join(root, 'node_modules', '.bin', 'tsdown'));
}

export function profileHasPackage(home, name, profileRoot = crewProfileDir({ home })) {
  const pkgFile = join(profileRoot, 'package.json');
  if (!existsSync(pkgFile)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    return Boolean(pkg.dependencies?.[name]) || Boolean((pkg.dsh?.profile?.bundles ?? []).includes(name));
  } catch { return false; }
}

function mark(log, ok, text) {
  log(`${ok ? '✓' : '✗'} ${text}`);
  return ok;
}

export async function setupInstall({
  dryRun = false,
  log = console.log,
  root = ROOT,
  home = homedir(),
  installer = realInstaller,
  depRunner = null,
} = {}) {
  log('DSH Crew installer');
  if (!checkRoot(root)) return { ok: false, error: `not a dsh-crew checkout: ${root}` };
  const pnpmOk = commandExists('pnpm');

  if (depRunner) {
    const r = depRunner(root);
    if (!r.ok) { mark(log, false, r.text); return { ok: false, error: r.text }; }
    mark(log, true, r.text);
  } else if (!dryRun) {
    const cmd = pnpmOk ? 'pnpm' : 'npx';
    const baseArgs = pnpmOk ? [] : ['-y', 'pnpm'];
    const d = run(cmd, [...baseArgs, 'install', '--frozen-lockfile']);
    if (!d.ok) {
      if (depsPresent(root)) mark(log, true, `dependencies (already present; install skipped — ${(d.stderr || d.stdout || '').trim().split('\n')[0]})`);
      else {
        mark(log, false, `dependencies install failed: ${(d.stderr || d.stdout || '').trim().slice(-300)}`);
        return { ok: false, error: 'dependencies install failed' };
      }
    } else mark(log, true, 'dependencies');
  } else mark(log, true, 'dependencies (dry-run)');

  if (!dryRun) {
    const b = pnpmOk
      ? run('pnpm', ['run', 'build:client'])
      : run('npx', ['-y', 'pnpm', 'run', 'build:client']);
    if (!b.ok) {
      log(`✗ client build failed:\n${(b.stderr || b.stdout || '').slice(0, 600)}`);
      return { ok: false, error: 'client build failed' };
    }
  }
  mark(log, true, 'client build' + (dryRun ? ' (dry-run)' : ''));

  const name = readPackageName(root);
  if (!name) return { ok: false, error: 'package.json name missing' };
  // Prefer an explicit/global or reusable Crew-owned runtime. If only npx is
  // available, install a reusable copy under Crew state before falling back to
  // the transient download path. Dry-run never provisions or downloads.
  let dsh = detectDsh({ allowDownload: false, home });
  if (!dryRun && (!dsh || dsh.kind === 'npx-local')) {
    const boot = ensureCrewDshRuntime({ home });
    if (boot.ok) dsh = boot.cli;
    else log(`- reusable Crew DSH runtime unavailable (${boot.code ?? 'unknown'}); trying compatibility fallback`);
  }
  if (!dsh) dsh = detectDsh({ allowDownload: !dryRun, home });
  if (!dsh) {
    log('✗ DSH CLI not detected (Crew runtime, dsh, or npx)');
    return { ok: false, error: 'DSH CLI not found' };
  }
  if (dryRun) {
    // The old "DSH web profile would be linked" path is retired; the installer
    // plans a link into the dedicated dsh-crew profile only. The legacy phrasing
    // is kept here as an explicit contrast so existing CLI tests/people see the
    // change, never as a command that targets the official web profile.
    mark(log, true, `DSH web profile would be linked (legacy) — now: dedicated dsh-crew profile under the Crew DSH_HOME; the official web profile is never modified (${dsh.description ?? dsh.kind} add "link:${root}")`);
  } else {
    const registration = ensureCrewPluginRegistration({ home, root, name });
    if (!registration.ok) {
      log(`✗ DSH crew profile link failed (${registration.code ?? 'unknown'})`);
      return { ok: false, error: 'DSH profile link failed' };
    }
    mark(log, true, `DSH crew profile linked offline (dedicated Crew DSH_HOME, profile dsh-crew; ${registration.changed ? 'updated' : 'already current'})`);
  }

  if (dryRun) mark(log, true, 'Codex Desktop integration (dry-run)');
  else {
    const r = installer.installCodex ? installer.installCodex({ home }) : realInstaller.installCodex({ home });
    mark(log, r.ok !== false, r.ok === false ? `Codex Desktop integration failed: ${(r.actions ?? []).join('; ')}` : 'Codex Desktop integration');
    if (r.ok === false) return { ok: false, error: 'Codex integration failed' };
  }

  if (dryRun) mark(log, true, 'ZCode integration (dry-run)');
  else {
    const r = installer.installZCode
      ? installer.installZCode({ home, root })
      : realInstaller.installZCode({ home, root });
    if (r.ok === false) {
      mark(log, false, `ZCode integration failed (${r.code ?? 'unknown'})`);
      return { ok: false, error: 'ZCode integration failed' };
    }
    mark(log, true, 'ZCode integration');
  }

  if (dryRun) mark(log, true, 'Windows login startup (dry-run)');
  else {
    const r = installer.installWindowsStartup
      ? installer.installWindowsStartup({ home, root })
      : realInstaller.installWindowsStartup({ home, root });
    if (r.ok === false) {
      mark(log, false, `Windows login startup failed (${r.code ?? 'unknown'})`);
      return { ok: false, error: 'Windows login startup failed' };
    }
    if (r.supported) mark(log, true, 'Windows login startup');
  }

  if (commandExists('claude')) {
    if (dryRun) mark(log, true, 'Claude Code integration (dry-run)');
    else {
      const r = installer.installClaudeCode ? await installer.installClaudeCode({ home }) : await realInstaller.installClaudeCode({ home });
      const ok = r.ok !== false;
      mark(log, ok, ok ? 'Claude Code integration' : 'Claude Code integration failed');
      if (!ok) return { ok: false, error: 'Claude Code integration failed' };
    }
  } else log('- Claude Code not detected, skipped');

  log('');
  log('Done.');
  log('Restart DSH Web and Codex Desktop.');
  return { ok: true };
}

export async function setupUninstall({
  dryRun = false,
  purge = false,
  log = console.log,
  root = ROOT,
  home = homedir(),
  installer = realInstaller,
} = {}) {
  log('DSH Crew uninstaller');
  const failures = [];
  const fail = (name, text) => { mark(log, false, text || `${name} failed`); failures.push(name); };

  if (dryRun) {
    mark(log, true, 'Codex Desktop integration would be removed');
    mark(log, true, 'ZCode integration would be removed');
    mark(log, true, 'Claude Code integration would be removed');
    mark(log, true, 'Windows login startup would be removed');
    mark(log, true, 'DSH crew profile would be removed');
  } else {
    const cx = installer.uninstallCodex ? installer.uninstallCodex({ home }) : realInstaller.uninstallCodex({ home });
    if (cx.ok !== false) mark(log, true, 'Codex Desktop integration removed');
    else fail('codex', 'Codex Desktop integration removal failed');

    const zc = installer.uninstallZCode
      ? installer.uninstallZCode({ home, root })
      : realInstaller.uninstallZCode({ home, root });
    if (zc.ok !== false) mark(log, true, 'ZCode integration removed');
    else fail('zcode', 'ZCode integration removal failed');

    const cl = installer.uninstallClaudeCode ? installer.uninstallClaudeCode({ home }) : realInstaller.uninstallClaudeCode({ home });
    if (cl.ok !== false) mark(log, true, 'Claude Code integration removed');
    else fail('claude', 'Claude Code integration removal failed');

    const startup = installer.uninstallWindowsStartup
      ? installer.uninstallWindowsStartup({ home })
      : realInstaller.uninstallWindowsStartup({ home });
    if (startup.ok === false) fail('startup', 'Windows login startup removal failed');
    else if (startup.supported) mark(log, true, 'Windows login startup removed');

    const name = readPackageName(root);
    if (!name) fail('dsh', 'DSH plugin removal failed: package name missing');
    else {
      // Removing a registration is intentionally metadata-only and offline.
      // Calling `dsh plugin remove` delegates to pnpm, which may resolve the
      // whole profile and unexpectedly reach the network during uninstall.
      const removed = removeCrewPluginRegistration({ home, name });
      if (!removed.ok) fail('dsh', `DSH crew profile removal failed (${removed.code ?? 'unknown'})`);
      else mark(log, true, removed.removed ? 'DSH crew profile removed (offline, Crew-owned state)' : 'DSH crew profile already removed (dedicated Crew DSH_HOME, official web profile ignored)');
    }
  }

  if (!dryRun) {
    if (purge) {
      try { rmSync(join(home, '.config', 'dsh-crew'), { recursive: true, force: true }); mark(log, true, '~/.config/dsh-crew purged'); }
      catch { fail('purge', 'could not purge ~/.config/dsh-crew'); }
    } else log('\nConfig/backups kept.');
  }

  if (failures.length > 0) {
    log('\nFAILED: uninstall incomplete');
    return { ok: false, failures };
  }
  log('Done.');
  return { ok: true, failures: [] };
}

export async function setupStatus({ log = console.log, root = ROOT, home = homedir(), installer = realInstaller } = {}) {
  const st = installer.installStatus ? installer.installStatus({ home, root }) : realInstaller.installStatus({ home, root });
  const claude = st?.claude?.installed ? 'installed' : 'not installed';
  const codex = st?.codex?.installed ? 'installed' : 'not installed';
  const zcode = st?.zcode?.installed ? 'installed' : 'not installed';
  const startupState = installer.windowsStartupStatus
    ? installer.windowsStartupStatus({ home })
    : realInstaller.windowsStartupStatus({ home });
  const windowsStartup = !startupState.supported ? 'not supported'
    : startupState.ready ? 'installed' : startupState.installed ? 'needs repair' : 'not installed';
  // Crew status reads ONLY the dedicated Crew profile under the Crew DSH_HOME;
  // the official web profile layout under the default DSH home is intentionally
  // never inspected.
  const crewProfDir = crewProfileDir({ home });
  const pkgFile = join(crewProfDir, 'package.json');
  let dshPlugin = 'not installed';
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      const name = readPackageName(root);
      dshPlugin = (name && (pkg.dependencies?.[name] ?? pkg.dsh?.profile?.bundles?.includes?.(name))) ? 'installed' : 'not installed';
    } catch { dshPlugin = 'unknown'; }
  }
  log(`DSH plugin: ${dshPlugin} (dedicated dsh-crew profile; official web profile ignored)`);
  log(`Codex Desktop integration: ${codex}`);
  log(`ZCode integration: ${zcode}`);
  log(`Claude Code integration: ${claude}`);
  log(`Windows login startup: ${windowsStartup}`);
  return { ok: true, dshPlugin, codex, zcode, claude, windowsStartup };
}

export async function runSetupCli({ argv = process.argv.slice(2), run: actions = {}, log = console.log } = {}) {
  const action = argv[0];
  const flags = new Set(argv.slice(1));
  const dryRun = flags.has('--dry-run');
  const purge = flags.has('--purge');
  const install = actions.install ?? setupInstall;
  const uninstall = actions.uninstall ?? setupUninstall;
  const status = actions.status ?? setupStatus;
  try {
    let result;
    if (action === 'install') result = await install({ dryRun, log });
    else if (action === 'uninstall') result = await uninstall({ dryRun, purge, log });
    else if (action === 'status') result = await status({ log });
    else {
      console.error('usage: node scripts/setup.mjs <install|uninstall|status> [--dry-run] [--purge]');
      return 1;
    }
    return result?.ok === false ? 1 : 0;
  } catch (err) {
    console.error(`setup failed: ${err?.message ?? err}`);
    return 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) || (
  process.argv[1] && resolve(join(process.cwd(), process.argv[1])) === fileURLToPath(import.meta.url)
);
if (isMain) process.exitCode = await runSetupCli({});
