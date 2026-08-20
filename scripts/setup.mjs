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
  });
  return { ok: r.status === 0, status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Detect the DSH CLI. `allowDownload` is intentionally opt-in: installation
 * may use `npx -y` to fetch DSH, while status/uninstall probes never trigger a
 * network download merely by checking availability.
 */
export function detectDsh({ allowDownload = false } = {}) {
  if (commandExists('dsh')) return { kind: 'dsh', cli: 'dsh plugin --profile web' };
  if (!commandExists('npx')) return null;
  if (allowDownload) return { kind: 'npx', cli: 'npx -y @deepseek-ai/dsh plugin --profile web' };
  const probe = run('npx --no-install @deepseek-ai/dsh --version', [], { shell: true });
  if (probe.ok) return { kind: 'npx', cli: 'npx --no-install @deepseek-ai/dsh plugin --profile web' };
  return null;
}

export function runDsh(cmd, args) {
  const argStr = args.map((a) => (/^[A-Za-z0-9_./:@-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
  return run(`${cmd} ${argStr}`, [], { shell: true });
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

export function profileHasPackage(home, name, profileRoot = join(home, '.dsh', 'profiles', 'web')) {
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

  if (depRunner) {
    const r = depRunner(root);
    if (!r.ok) { mark(log, false, r.text); return { ok: false, error: r.text }; }
    mark(log, true, r.text);
  } else if (!dryRun) {
    const pnpmOk = commandExists('pnpm');
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
    const b = run('npx --no-install tsdown src/client/index.tsx --format cjs --platform browser --target es2022 --tsconfig tsconfig.client.json --deps.never-bundle react --deps.never-bundle react/jsx-runtime --deps.never-bundle react-dom --deps.never-bundle react-dom/client --out-dir .client-build --clean --logLevel warn && node scripts/build-client.mjs', [], { shell: true });
    if (!b.ok) {
      log(`✗ client build failed:\n${(b.stderr || b.stdout || '').slice(0, 600)}`);
      return { ok: false, error: 'client build failed' };
    }
  }
  mark(log, true, 'client build' + (dryRun ? ' (dry-run)' : ''));

  const name = readPackageName(root);
  if (!name) return { ok: false, error: 'package.json name missing' };
  // Install is the one operation allowed to fetch the DSH CLI via npx. A
  // dry-run only checks that npx exists; detectDsh itself performs no network.
  const dsh = detectDsh({ allowDownload: true });
  if (!dsh) {
    log('✗ DSH CLI not detected (dsh or npx)');
    return { ok: false, error: 'DSH CLI not found' };
  }
  if (dryRun) mark(log, true, `DSH web profile would be linked: ${dsh.kind} add "link:${root}"`);
  else {
    const add = runDsh(dsh.cli, ['add', `link:${root}`]);
    if (!add.ok) {
      log(`✗ DSH web profile link failed:\n${(add.stderr || add.stdout || '').slice(0, 400)}`);
      return { ok: false, error: 'DSH profile link failed' };
    }
    mark(log, true, 'DSH web profile linked');
  }

  if (dryRun) mark(log, true, 'Codex Desktop integration (dry-run)');
  else {
    const r = installer.installCodex ? installer.installCodex({ home }) : realInstaller.installCodex({ home });
    mark(log, r.ok !== false, r.ok === false ? `Codex Desktop integration failed: ${(r.actions ?? []).join('; ')}` : 'Codex Desktop integration');
    if (r.ok === false) return { ok: false, error: 'Codex integration failed' };
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
    mark(log, true, 'Claude Code integration would be removed');
    mark(log, true, 'DSH web profile would be removed');
  } else {
    const cx = installer.uninstallCodex ? installer.uninstallCodex({ home }) : realInstaller.uninstallCodex({ home });
    if (cx.ok !== false) mark(log, true, 'Codex Desktop integration removed');
    else fail('codex', 'Codex Desktop integration removal failed');

    const cl = installer.uninstallClaudeCode ? installer.uninstallClaudeCode({ home }) : realInstaller.uninstallClaudeCode({ home });
    if (cl.ok !== false) mark(log, true, 'Claude Code integration removed');
    else fail('claude', 'Claude Code integration removal failed');

    const name = readPackageName(root);
    if (!name) fail('dsh', 'DSH plugin removal failed: package name missing');
    else if (!profileHasPackage(home, name)) mark(log, true, 'DSH web profile already removed');
    else {
      // Uninstall must not surprise the user or CI by downloading a CLI just
      // to probe. Use only an already available dsh / locally resolvable npx.
      const dsh = detectDsh();
      if (!dsh) fail('dsh', 'DSH plugin removal failed: DSH CLI not found');
      else {
        const rm = runDsh(dsh.cli, ['remove', name]);
        if (!rm.ok) fail('dsh', `DSH web profile removal failed: ${(rm.stderr || rm.stdout || '').trim().slice(0, 300)}`);
        else mark(log, true, 'DSH web profile removed');
      }
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
  const st = installer.installStatus ? installer.installStatus({ home }) : realInstaller.installStatus({ home });
  const claude = st?.claude?.installed ? 'installed' : 'not installed';
  const codex = st?.codex?.installed ? 'installed' : 'not installed';
  let dshPlugin = 'unknown';
  if (existsSync(join(home, '.dsh', 'profiles', 'web', 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(home, '.dsh', 'profiles', 'web', 'package.json'), 'utf8'));
      const name = readPackageName(root);
      dshPlugin = (pkg.dependencies?.[name] ?? pkg.dsh?.profile?.bundles?.includes?.(name)) ? 'installed' : 'not installed';
    } catch { dshPlugin = 'unknown'; }
  }
  log(`DSH plugin: ${dshPlugin}`);
  log(`Codex Desktop integration: ${codex}`);
  log(`Claude Code integration: ${claude}`);
  return { ok: true, dshPlugin, codex, claude };
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
