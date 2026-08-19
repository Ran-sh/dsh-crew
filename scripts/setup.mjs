#!/usr/bin/env node
// One-click DSH Crew installer / uninstaller / status.
//
//   node scripts/setup.mjs install [--dry-run]
//   node scripts/setup.mjs uninstall [--dry-run] [--purge]
//   node scripts/setup.mjs status
//
// Installs the LOCAL checkout (link:<ROOT>) into the DSH web profile plus the
// Codex Desktop integration (no codex CLI needed) and, when the Claude CLI is
// detected, the Claude Code integration. Uninstall removes only dsh-crew's own
// artifacts; config / backups / credentials are kept by default.
//
// Windows: install.cmd / uninstall.cmd are thin wrappers over this file.
//
// The setup functions accept an injectable `installer` so tests can stub the
// real file/DSH side effects (see test/setup.test.mjs).

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as realInstaller from '../src/install/install.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function commandExists(name) {
  const r = spawnSync(/^win/.test(process.platform) ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: opts.shell === true, cwd: opts.cwd ?? ROOT });
  return { ok: r.status === 0, status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Detect the DSH CLI to use for profile operations. */
export function detectDsh() {
  if (commandExists('dsh')) return { kind: 'dsh', cli: 'dsh plugin --profile web' };
  // Probe via the shell so the npx shim resolves on every platform.
  const probe = run('npx --no-install @deepseek-ai/dsh --version', [], { shell: true });
  if (probe.ok) return { kind: 'npx', cli: 'npx --no-install @deepseek-ai/dsh plugin --profile web' };
  return null;
}

/**
 * Run a dsh profile subcommand (add/remove). `cmd` is a base CLI string like
 * "dsh plugin --profile web" or "npx --no-install @deepseek-ai/dsh plugin --profile web".
 */
export function runDsh(cmd, args) {
  const argStr = args.map((a) => (/^[A-Za-z0-9_./:@-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
  return run(`${cmd} ${argStr}`, [], { shell: true });
}

/** Read package.json.name (DSH package identity) without hardcoding it. */
export function readPackageName(root = ROOT) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name; } catch { return null; }
}

/** True when the checkout looks like a valid dsh-crew source tree. */
export function checkRoot(root = ROOT) {
  return existsSync(join(root, 'package.json'))
    && existsSync(join(root, 'src', 'server.mjs'))
    && existsSync(join(root, 'cordis.patch.yml'));
}

/** True when the essential runtime deps are already installed. */
export function depsPresent(root = ROOT) {
  return existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk'))
    && existsSync(join(root, 'node_modules', '.bin', 'tsdown'));
}

/** True when the DSH web profile still references the package. */
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

/**
 * Install: dependencies → client build → DSH web profile link → Codex Desktop
 * → Claude Code (when detected). Never touches credentials, providers, or
 * starts DSH. `installer` is injected for tests.
 */
export async function setupInstall({
  dryRun = false,
  log = console.log,
  root = ROOT,
  home = homedir(),
  installer = realInstaller,
  depRunner = null, // injected for tests: (root) => [{ok,text}]
} = {}) {
  log('DSH Crew installer');
  if (!checkRoot(root)) return { ok: false, error: `not a dsh-crew checkout: ${root}` };

  // 1. dependencies
  if (depRunner) {
    const r = depRunner(root);
    if (!r.ok) { mark(log, false, r.text); return { ok: false, error: r.text }; }
    mark(log, true, r.text);
  } else if (!dryRun) {
    const pnpmOk = commandExists('pnpm');
    const cmd = pnpmOk ? 'pnpm' : 'npx';
    const baseArgs = pnpmOk ? [] : ['-y', 'pnpm'];
    let d = run(cmd, [...baseArgs, 'install', '--frozen-lockfile']);
    if (!d.ok) {
      // frozen-lockfile (or newer pnpm's ignored-builds policy) can fail even
      // when the tree is already installed; never silently rewrite the
      // lockfile. If the key packages are present, report it and continue.
      if (depsPresent(root)) {
        mark(log, true, `dependencies (already present; install skipped — ${(d.stderr || d.stdout || '').trim().split('\n')[0]})`);
      } else {
        mark(log, false, `dependencies install failed: ${(d.stderr || d.stdout || '').trim().slice(-300)}`);
        return { ok: false, error: 'dependencies install failed' };
      }
    } else {
      mark(log, true, 'dependencies');
    }
  } else {
    mark(log, true, 'dependencies (dry-run)');
  }

  // 2. client build (equivalent of pnpm run build:client). Runs via npx so the
  // local tsdown shim resolves inside the shell on every platform.
  if (!dryRun) {
    const b = run('npx --no-install tsdown src/client/index.tsx --format cjs --platform browser --target es2022 --tsconfig tsconfig.client.json --deps.never-bundle react --deps.never-bundle react/jsx-runtime --deps.never-bundle react-dom --deps.never-bundle react-dom/client --out-dir .client-build --clean --logLevel warn && node scripts/build-client.mjs', [], { shell: true });
    if (!b.ok) {
      log(`✗ client build failed:\n${(b.stderr || b.stdout || '').slice(0, 600)}`);
      return { ok: false, error: 'client build failed' };
    }
  }
  mark(log, true, 'client build' + (dryRun ? ' (dry-run)' : ''));

  // 3. DSH web profile link.
  const dsh = detectDsh();
  if (!dsh) { log('✗ DSH CLI not detected (dsh or npx @deepseek-ai/dsh)'); return { ok: false, error: 'DSH CLI not found' }; }
  const name = readPackageName(root);
  if (!name) return { ok: false, error: 'package.json name missing' };
  if (dryRun) {
    mark(log, true, `DSH web profile would be linked: ${dsh.kind} add "link:${root}"`);
  } else {
    const add = runDsh(dsh.cli, ['add', `link:${root}`]);
    if (!add.ok) { log(`✗ DSH web profile link failed:\n${(add.stderr || add.stdout || '').slice(0, 400)}`); return { ok: false, error: 'DSH profile link failed' }; }
    mark(log, true, 'DSH web profile linked');
  }

  // 4. Codex Desktop integration (no codex CLI needed).
  if (dryRun) {
    mark(log, true, 'Codex Desktop integration (dry-run)');
  } else {
    const r = installer.installCodex ? installer.installCodex({ home }) : realInstaller.installCodex({ home });
    mark(log, r.ok !== false, r.ok === false ? `Codex Desktop integration failed: ${(r.actions ?? []).join('; ')}` : 'Codex Desktop integration');
    if (r.ok === false) return { ok: false, error: 'Codex integration failed' };
  }

  // 5. Claude Code (optional).
  if (commandExists('claude')) {
    if (dryRun) {
      mark(log, true, 'Claude Code integration (dry-run)');
    } else {
      const r = installer.installClaudeCode ? await installer.installClaudeCode({ home }) : await realInstaller.installClaudeCode({ home });
      mark(log, r.ok !== false, r.ok === false ? 'Claude Code integration failed' : 'Claude Code integration');
    }
  } else {
    log('- Claude Code not detected, skipped');
  }

  log('');
  log('Done.');
  log('Restart DSH Web and Codex Desktop.');
  return { ok: true };
}

/**
 * Uninstall: Codex Desktop integration → Claude integration → DSH web profile
 * remove. Keeps ~/.config/dsh-crew, backups and credentials by default
 * (remove them explicitly with --purge). Never touches the repo, DSH,
 * Codex Desktop or Claude Code themselves.
 */
export async function setupUninstall({
  dryRun = false,
  purge = false,
  log = console.log,
  root = ROOT,
  home = homedir(),
  installer = realInstaller,
} = {}) {
  log('DSH Crew uninstaller');
  if (dryRun) {
    mark(log, true, 'Codex Desktop integration would be removed');
    mark(log, true, 'Claude Code integration would be removed');
    mark(log, true, 'DSH web profile would be removed');
  } else {
    const cx = installer.uninstallCodex ? installer.uninstallCodex({ home }) : realInstaller.uninstallCodex({ home });
    mark(log, cx.ok !== false, 'Codex Desktop integration removed');
    const cl = installer.uninstallClaudeCode ? installer.uninstallClaudeCode({ home }) : realInstaller.uninstallClaudeCode({ home });
    mark(log, cl.ok !== false, 'Claude Code integration removed');

    const dsh = detectDsh();
    const name = readPackageName(root);
    if (!name) {
      log('✗ DSH plugin removal skipped: package name missing');
      return { ok: false, error: 'DSH profile removal failed' };
    }
    if (!dsh) {
      log('✗ DSH plugin removal skipped: DSH CLI not found');
      return { ok: false, error: 'DSH profile removal failed' };
    }
    // Idempotency: if the profile no longer lists the package, nothing to do —
    // pnpm remove on an already-absent dependency errors out.
    if (!profileHasPackage(home, name)) {
      mark(log, true, 'DSH web profile already removed');
    } else {
      const rm = runDsh(dsh.cli, ['remove', name]);
      if (!rm.ok) {
        log(`✗ DSH web profile removal failed:\n${(rm.stderr || rm.stdout || '').slice(0, 400)}`);
        return { ok: false, error: 'DSH profile removal failed' };
      }
      mark(log, true, 'DSH web profile removed');
    }
  }

  if (!purge && !dryRun) log('\nConfig/backups kept.');
  if (purge && !dryRun) {
    try { rmSync(join(home, '.config', 'dsh-crew'), { recursive: true, force: true }); mark(log, true, '~/.config/dsh-crew purged'); } catch { mark(log, false, 'could not purge ~/.config/dsh-crew'); }
  }
  log('Done.');
  return { ok: true };
}

/** Report what is installed where. Never prints credentials. */
export async function setupStatus({ log = console.log, root = ROOT, home = homedir(), installer = realInstaller } = {}) {
  const st = installer.installStatus ? installer.installStatus({ home }) : realInstaller.installStatus({ home });
  const claude = st?.claude?.installed ? 'installed' : 'not installed';
  const codex = st?.codex?.installed ? 'installed' : 'not installed';
  let dshPlugin = 'unknown';
  const { existsSync } = await import('node:fs');
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

// ---------- CLI entry ----------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) || (
  process.argv[1] && resolve(join(process.cwd(), process.argv[1])) === fileURLToPath(import.meta.url)
);
if (isMain) {
  const action = process.argv[2];
  const flags = new Set(process.argv.slice(3));
  const dryRun = flags.has('--dry-run');
  const purge = flags.has('--purge');
  try {
    if (action === 'install') await setupInstall({ dryRun });
    else if (action === 'uninstall') await setupUninstall({ dryRun, purge });
    else if (action === 'status') await setupStatus({});
    else {
      console.error('usage: node scripts/setup.mjs <install|uninstall|status> [--dry-run] [--purge]');
      process.exit(1);
    }
  } catch (err) {
    console.error(`setup failed: ${err?.message ?? err}`);
    process.exit(1);
  }
}
