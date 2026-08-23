// v0.3.3 npx-managed lifecycle: install / status / update / uninstall.
//
// Public UX:
//   npx @ran-sh/dsh-crew@latest install|status|update|uninstall
//
// An npx invocation runs from a transient package-manager extraction/cache
// path. This module therefore persists the already-built package payload into
// Crew-owned state BEFORE registering it with the Harness profile, so the
// registration never depends on the cache, tarball, or temp extraction dir:
//
//   <home>/.config/dsh-crew/app/current.json        active-release pointer
//   <home>/.config/dsh-crew/app/releases/<stamp>/   durable installed payloads
//
// Everything else (config.json, credentials, backups, the isolated Harness
// home) is never touched by install/update; uninstall removes only the
// Crew-managed payload above plus registrations/integrations, and keeps the
// normal Crew config unless --purge is explicitly requested.
//
// Source checkouts keep using scripts/setup.mjs; this module is for the
// packaged npm payload and never requires pnpm lockfiles, devDependencies,
// or a client rebuild.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import * as realInstaller from './install.mjs';
import { crewProfileDir } from './install.mjs';
import { ensureCrewDshRuntime, ensureCrewPluginRegistration, removeCrewPluginRegistration } from '../dsh-cli-runtime.mjs';

export const CREW_APP_DIRNAME = 'app';
export const RELEASES_DIRNAME = 'releases';
export const CURRENT_POINTER_FILENAME = 'current.json';
export const KEEP_RELEASES = 2;
export const INCOMPLETE_MARKER = '.dsh-crew-incomplete';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function crewAppRoot({ home = homedir() } = {}) {
  return join(home, '.config', 'dsh-crew', CREW_APP_DIRNAME);
}

export function crewReleasesDir({ home = homedir() } = {}) {
  return join(crewAppRoot({ home }), RELEASES_DIRNAME);
}

export function currentPointerFile({ home = homedir() } = {}) {
  return join(crewAppRoot({ home }), CURRENT_POINTER_FILENAME);
}

/** Package root of the currently executing (candidate) instance. */
export function runningPackageRoot() {
  return PACKAGE_ROOT;
}

function readManifest(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function timestampStamp(now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
}

let releaseSalt = 0;
function uniqueReleaseName(version) {
  // Second-resolution timestamps can collide across rapid sequential runs in
  // the same process; a process-local counter keeps release names unique so
  // an update never reuses (and thus never clobbers) an existing release.
  releaseSalt += 1;
  return `${timestampStamp()}-${process.pid}-${releaseSalt.toString(36)}-${version}`;
}

function isoNow() {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())}T${pad(new Date().getHours())}:${pad(new Date().getMinutes())}:${pad(new Date().getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// ---- installed-payload pointer ----------------------------------------------

/**
 * Read the active installed-release pointer. Returns null when no valid
 * pointer exists. The pointed-at directory must still exist with a matching
 * manifest to count as installed.
 */
export function readCurrentPointer({ home = homedir() } = {}) {
  const file = currentPointerFile({ home });
  if (!existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.name !== 'string' || typeof raw.version !== 'string' || typeof raw.path !== 'string') return null;
  if (!isAbsolute(raw.path)) return null;
  return raw;
}

function writeCurrentPointer({ home, name, version, path }) {
  mkdirSync(dirname(currentPointerFile({ home })), { recursive: true });
  const pointer = { name, version, path, installed_at: isoNow(), managed_by: 'npx' };
  writeFileSync(currentPointerFile({ home }), JSON.stringify(pointer, null, 2) + '\n');
  return pointer;
}

// ---- dependency tree materialization ----------------------------------------

function listPackageEdges(manifest) {
  // Returns [{name, optional}] covering dependencies and
  // optionalDependencies; platform-specific optional bits stay non-fatal.
  const edges = [];
  for (const [name] of Object.entries(manifest?.dependencies ?? {})) {
    edges.push({ name, optional: false });
  }
  for (const [name] of Object.entries(manifest?.optionalDependencies ?? {})) {
    if (!edges.some((edge) => edge.name === name)) edges.push({ name, optional: true });
  }
  return edges.filter((edge) => typeof edge.name === 'string' && edge.name.trim());
}

function findPackageDir(fromRoot, name, exists = existsSync) {
  // Node-style upward resolution: for each ancestor directory of fromRoot,
  // probe <ancestor>/node_modules/<name>. Covers npm's hoisted npx cache and
  // pnpm's virtual store (once a package is realpathed into .pnpm/<pkg>/
  // node_modules, walking up finds its exact sibling closure).
  const parts = name.split('/');
  const seen = new Set();
  let cursor = fromRoot;
  while (true) {
    const candidate = join(cursor, 'node_modules', ...parts);
    if (exists(candidate)) {
      try {
        const real = realpathSync(candidate);
        if (!seen.has(real)) { seen.add(real); return real; }
      } catch { /* skip unreadable entry */ }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/**
 * Copy the dependency closure of `names` out of the running instance's
 * dependency tree into `<toRoot>/node_modules`. Offline-safe: it replicates
 * exactly the dependency bits the candidate just executed with. Optional
 * edges (e.g. cross-platform native binaries) are copied when present but
 * reported separately when absent, so npm can reconcile them per-platform.
 * Returns { copied: Map<name, realSource>, missing: string[], missingOptional: string[] }.
 */
export function copyProductionDependencyTree({
  fromRoot,
  toRoot,
  names,
  exists = existsSync,
  copyDir = (src, dest) => cpSync(src, dest, { recursive: true, force: true, dereference: true }),
} = {}) {
  const toNodeModules = join(toRoot, 'node_modules');
  mkdirSync(toNodeModules, { recursive: true });
  const copied = new Map();
  const missing = [];
  const missingOptional = [];
  const queue = names.map((entry) => (typeof entry === 'string'
    ? { name: entry, fromRoot, optional: false }
    : { ...entry, fromRoot }));
  while (queue.length > 0) {
    const { name, fromRoot: searchRoot, optional } = queue.shift();
    if (copied.has(name) || missing.includes(name) || missingOptional.includes(name)) continue;
    const source = findPackageDir(searchRoot ?? fromRoot, name, exists);
    if (!source) {
      if (optional) missingOptional.push(name);
      else missing.push(name);
      continue;
    }
    const dest = join(toNodeModules, ...name.split('/'));
    copyDir(source, dest);
    copied.set(name, source);
    const depManifest = readManifest(source);
    for (const edge of listPackageEdges(depManifest)) {
      if (!copied.has(edge.name) && !missing.includes(edge.name) && !missingOptional.includes(edge.name)) {
        // Resolve children relative to the copied package's own physical
        // location so nested/virtual-store layouts resolve correctly.
        queue.push({ name: edge.name, fromRoot: dirname(source), optional: edge.optional || optional });
      }
    }
  }
  return { copied, missing, missingOptional };
}

function defaultNpmInstaller(stageRoot, log) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, [
    'install', '--prefix', stageRoot,
    '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-package-lock', '--loglevel=error',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', timeout: 600_000, windowsHide: true, env: sanitizedPackageManagerEnv() });
  if (result.status !== 0) {
    log(`- npm fallback install failed (${result.status}): ${(result.stderr || result.stdout || '').trim().slice(-300)}`);
    return false;
  }
  return true;
}

// ---- payload staging ---------------------------------------------------------

/**
 * Stage the candidate into its FINAL release directory, guarded by an
 * incompleteness marker. Committing = removing the marker (a single-file
 * operation that is reliable on all platforms); activation = writing the
 * pointer last. This avoids directory renames, which Windows can refuse with
 * transient EPERM while a freshly written tree is being scanned.
 *
 * The persisted manifest merges the exact-pinned DSH peer cohort into
 * `dependencies` (peer declarations are dropped): the installed payload runs
 * standalone — `src/server.mjs` statically imports DSH peers — so those
 * packages must exist inside the release, not be assumed from a host.
 */
export function stageCandidatePayload({
  sourceRoot = runningPackageRoot(),
  home = homedir(),
  log = () => {},
  now = new Date(),
  npmInstaller = defaultNpmInstaller,
  copyTree = copyProductionDependencyTree,
  smoke = defaultPayloadSmoke,
} = {}) {
  const manifest = readManifest(sourceRoot);
  if (!manifest?.name || !manifest?.version) return { ok: false, code: 'CANDIDATE_MANIFEST_INVALID' };
  if (!existsSync(join(sourceRoot, 'src', 'server.mjs')) || !existsSync(join(sourceRoot, 'cordis.patch.yml'))) {
    return { ok: false, code: 'CANDIDATE_NOT_RUNNABLE' };
  }

  const releasesDir = crewReleasesDir({ home });
  mkdirSync(releasesDir, { recursive: true });
  const stageDir = join(releasesDir, uniqueReleaseName(manifest.version));
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, INCOMPLETE_MARKER), String(Date.now()) + '\n');

  // Copy every top-level entry referenced by manifest.files (directories are
  // copied whole; single-segment wildcards match within their directory).
  const entries = new Set(['package.json']);
  for (const pattern of manifest.files ?? []) {
    if (typeof pattern !== 'string' || !pattern.trim()) continue;
    if (!pattern.includes('*')) { entries.add(pattern); continue; }
    const base = dirname(pattern);
    const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    const scanDir = join(sourceRoot, base);
    if (!existsSync(scanDir)) continue;
    for (const item of readdirSync(scanDir)) {
      const candidatePath = base === '.' ? item : `${base.replace(/\\/g, '/')}/${item}`;
      if (regex.test(candidatePath)) entries.add(candidatePath);
    }
  }

  for (const entry of entries) {
    const source = join(sourceRoot, entry);
    if (!existsSync(source)) continue;
    cpSync(source, join(stageDir, entry), { recursive: true, force: true, dereference: true });
  }

  // Persist an adjusted manifest: identity/runtime fields stay; production
  // dependencies gain the exact-pinned peer cohort so the payload runs
  // standalone (src/server.mjs statically imports DSH peers). Optional
  // dependencies keep their own section so npm reconciles them per-platform.
  const stagedManifest = { ...manifest };
  delete stagedManifest.devDependencies;
  delete stagedManifest.peerDependencies;
  delete stagedManifest.peerDependenciesMeta;
  const optionalNames = new Set(Object.keys(manifest.optionalDependencies ?? {}));
  stagedManifest.dependencies = {
    ...(manifest.peerDependencies ?? {}),
    ...(manifest.dependencies ?? {}),
  };
  writeFileSync(join(stageDir, 'package.json'), JSON.stringify(stagedManifest, null, 2) + '\n');

  // Materialize dependencies: prefer replicating the exact bits the candidate
  // ran with (offline-safe); fall back to npm for the rest (under npx this is
  // normally the exact-pinned DSH peer cohort).
  const depEdges = [
    ...Object.keys(stagedManifest.dependencies).map((name) => ({ name, optional: false })),
    ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
  ];
  const { missing, missingOptional } = copyTree({ fromRoot: sourceRoot, toRoot: stageDir, names: depEdges });
  if (missingOptional.length > 0) {
    log(`- platform-optional dependencies left to npm (${missingOptional.slice(0, 4).join(', ')}${missingOptional.length > 4 ? ', …' : ''})`);
  }
  if (missing.length > 0) {
    log(`- local dependency replication incomplete (${missing.join(', ')}); falling back to npm`);
    if (!npmInstaller(stageDir, log)) {
      rmSync(stageDir, { recursive: true, force: true });
      return { ok: false, code: 'DEPENDENCY_MATERIALIZE_FAILED', missing };
    }
  }

  const validated = validateInstalledPayload(stageDir, { expectedName: manifest.name, expectedVersion: manifest.version, allowIncomplete: true });
  if (!validated.ok) {
    rmSync(stageDir, { recursive: true, force: true });
    return { ok: false, code: 'STAGE_VALIDATION_FAILED', detail: validated.errors };
  }
  const smoked = smoke(stageDir);
  if (!smoked.ok) {
    rmSync(stageDir, { recursive: true, force: true });
    return { ok: false, code: 'STAGE_SMOKE_FAILED', detail: smoked.detail };
  }
  return { ok: true, stageDir, manifest, releasesDir };
}

/**
 * Boot-smoke a staged payload with the real Node binary: the CLI entry must
 * start and answer --help from inside the staged tree alone.
 */
export function defaultPayloadSmoke(dir, { nodePath = process.execPath, runner = spawnSync } = {}) {
  const result = runner(nodePath, [join(dir, 'bin', 'dsh-crew.mjs'), '--help'], {
    encoding: 'utf8', timeout: 120_000, windowsHide: true,
    env: { ...process.env },
  });
  if (result.status === 0) return { ok: true };
  return { ok: false, detail: `bin --help exited ${result.status}: ${(result.stderr || result.stdout || '').trim().slice(-300)}` };
}

// Keyword boundaries reject identifiers containing the keywords
// ('legacy-import') and member calls (.from); captures stay on one line and
// bounded — real specifiers never span lines.
const IMPORT_SPECIFIER_RE = /(?<![\w.\-])(?:from|import|require)\b\s*\(?\s*["']([^"'\n]{1,200})["']/g;

function collectExternalSpecifiers(dir) {
  const specifiers = new Set();
  const walk = (root) => {
    if (!existsSync(root)) return;
    for (const item of readdirSync(root, { withFileTypes: true })) {
      const full = join(root, item.name);
      if (item.isDirectory()) walk(full);
      else if (/\.(?:mjs|js)$/.test(item.name)) {
        let content = '';
        try { content = readFileSync(full, 'utf8'); } catch { continue; }
        for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
          specifiers.add(match[1]);
        }
      }
    }
  };
  walk(join(dir, 'src'));
  walk(join(dir, 'bin'));
  return [...specifiers].filter((spec) =>
    !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:') && !isAbsolute(spec));
}

/**
 * Prove a payload directory is runnable on its own: correct identity, all
 * shipped runtime artifacts present, every declared dependency vendored, and
 * every external module specifier the payload's source actually imports
 * resolvable FROM THE PERSISTED LOCATION (never from a cache or checkout).
 */
export function validateInstalledPayload(dir, { expectedName, expectedVersion, allowIncomplete = false } = {}) {
  const errors = [];
  const manifest = readManifest(dir);
  if (!manifest) errors.push('package.json missing or invalid');
  else {
    if (expectedName && manifest.name !== expectedName) errors.push(`package name mismatch (${manifest.name})`);
    if (expectedVersion && manifest.version !== expectedVersion) errors.push(`package version mismatch (${manifest.version})`);
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (!existsSync(join(dir, 'node_modules', ...dep.split('/'), 'package.json'))) {
        errors.push(`vendored dependency missing from payload: ${dep}`);
      }
    }
  }
  if (manifest) {
    const requireFromPayload = createRequire(join(dir, 'package.json'));
    for (const spec of collectExternalSpecifiers(dir)) {
      try {
        requireFromPayload.resolve(spec);
      } catch {
        errors.push(`import target not resolvable from payload: ${spec}`);
      }
    }
  }
  for (const rel of ['cordis.patch.yml', 'src/server.mjs', 'src/hub/entry.mjs', 'lib/client.js', 'bin/dsh-crew.mjs']) {
    if (!existsSync(join(dir, rel))) errors.push(`payload artifact missing: ${rel}`);
  }
  if (!allowIncomplete && existsSync(join(dir, INCOMPLETE_MARKER))) errors.push('release is still marked incomplete');
  return { ok: errors.length === 0, errors, manifest };
}

// ---- release commit / activation ---------------------------------------------

function commitStagedRelease({ stageDir, manifest, home }) {
  rmSync(join(stageDir, INCOMPLETE_MARKER));
  writeCurrentPointer({ home, name: manifest.name, version: manifest.version, path: stageDir });
  gcOldReleases({ home });
  return stageDir;
}

const STALE_INCOMPLETE_MS = 24 * 60 * 60 * 1000;

function gcOldReleases({ home, keep = KEEP_RELEASES }) {
  const pointer = readCurrentPointer({ home });
  const releasesDir = crewReleasesDir({ home });
  if (!existsSync(releasesDir)) return;
  const removed = [];
  const dirs = readdirSync(releasesDir)
    .map((name) => join(releasesDir, name))
    .filter((dir) => !pointer || dir !== pointer.path);
  const incomplete = [];
  const complete = [];
  for (const dir of dirs) {
    if (existsSync(join(dir, INCOMPLETE_MARKER))) {
      // Never race a concurrent staging; only reap clearly abandoned ones.
      try {
        if (Date.now() - lstatSync(dir).mtimeMs > STALE_INCOMPLETE_MS) incomplete.push(dir);
      } catch { /* ignore */ }
      continue;
    }
    complete.push(dir);
  }
  complete.sort();
  while (complete.length > Math.max(0, keep - 1)) {
    const victim = complete.shift();
    try { rmSync(victim, { recursive: true, force: true }); removed.push(victim); } catch { /* best effort */ }
  }
  for (const victim of incomplete) {
    try { rmSync(victim, { recursive: true, force: true }); removed.push(victim); } catch { /* best effort */ }
  }
  return removed;
}

function registrationLinkPath({ home, name }) {
  return join(crewProfileDir({ home }), 'node_modules', ...name.split('/'));
}

function registrationHealthy({ home, name, releaseDir }) {
  const link = registrationLinkPath({ home, name });
  if (!existsSync(link)) return false;
  try { return realpathSync(link) === realpathSync(releaseDir); } catch { return false; }
}

/**
 * Environment for child package managers. Under `npm exec`/npx the process
 * inherits dozens of npm_config_* variables describing the transient exec
 * context; leaking them into pnpm/npm children can misdirect their stores and
 * config resolution. Package-manager children must see the user's real
 * environment, not our execution context.
 */
export function sanitizedPackageManagerEnv(baseEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (/^npm_(config_|lifecycle|package_|execpath$|node_execpath$)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

async function ensureRuntimeStep({ home, log, ensureRuntime }) {
  const ensure = ensureRuntime ?? ((opts) => {
    const r = ensureCrewDshRuntime({ ...opts, env: sanitizedPackageManagerEnv() });
    if (!r.ok && r.stderrTail) {
      log(`  (runtime installer said: ${r.stderrTail})`);
    }
    return r.ok ? { ok: true, version: r.cli?.version ?? null } : { ok: false, error: r.error ?? r.code ?? 'runtime bootstrap failed' };
  });
  const r = await ensure({ home });
  if (!r?.ok) {
    log(`✗ reusable Crew DSH runtime unavailable: ${r?.error ?? 'unknown error'}`);
    return false;
  }
  log(`✓ reusable Crew DSH runtime${r.version ? ` (@${r.version})` : ''}`);
  return true;
}

// ---- commands -----------------------------------------------------------------

function currentInstallationHealth({ home }) {
  const pointer = readCurrentPointer({ home });
  if (!pointer) return { installed: false, healthy: false };
  if (!existsSync(pointer.path)) return { installed: false, healthy: false, pointer };
  const validated = validateInstalledPayload(pointer.path, { expectedName: pointer.name, expectedVersion: pointer.version });
  const registered = registrationHealthy({ home, name: pointer.name, releaseDir: pointer.path });
  return { installed: true, healthy: validated.ok && registered, validated, registered, pointer };
}

async function activateRelease({ home, releaseDir, manifest, log, installer }) {
  const registration = ensureCrewPluginRegistration({ home, root: releaseDir, name: manifest.name });
  if (!registration.ok) {
    log(`✗ Harness registration failed (${registration.code ?? 'unknown'})`);
    return false;
  }
  log(`✓ Harness plugin registered (dedicated dsh-crew profile → ${releaseDir})`);

  const codex = installer.installCodex({ home, root: releaseDir });
  if (codex.ok === false) {
    log(`✗ Codex Desktop integration failed: ${(codex.actions ?? []).join('; ')}`);
    return false;
  }
  log('✓ Codex Desktop integration');

  const claude = await installer.installClaudeCode({ home, root: releaseDir });
  if (claude.ok === false) {
    log(`✗ Claude Code integration failed`);
    return false;
  }
  log('✓ Claude Code integration');
  return true;
}

export async function npxInstall({
  home = homedir(),
  log = console.log,
  sourceRoot,
  installer = realInstaller,
  ensureRuntime,
  npmInstaller,
} = {}) {
  log('DSH Crew installer (npx-managed)');
  const candidateRoot = sourceRoot ?? runningPackageRoot();
  const manifest = readManifest(candidateRoot);
  if (!manifest?.name || !manifest?.version) return { ok: false, error: 'candidate package manifest invalid' };

  const health = currentInstallationHealth({ home });
  if (health.installed && health.pointer.version === manifest.version && health.validated.ok) {
    // Same-version reinstall: repair activation surfaces without restaging.
    log(`- installed payload ${manifest.version} already present and valid; repairing activation`);
    const activated = await activateRelease({ home, releaseDir: health.pointer.path, manifest, log, installer });
    if (!activated) return { ok: false, error: 'activation failed' };
    if (!await ensureRuntimeStep({ home, log, ensureRuntime })) return { ok: false, error: 'Crew DSH runtime bootstrap failed' };
    log('');
    log('Done.');
    return { ok: true, repaired: true, version: manifest.version, path: health.pointer.path };
  }

  const staged = stageCandidatePayload({ sourceRoot: candidateRoot, home, log, npmInstaller });
  if (!staged.ok) {
    log(`✗ staging failed (${staged.code})${staged.detail ? `: ${staged.detail.join('; ')}` : ''}`);
    return { ok: false, error: `staging failed (${staged.code})` };
  }
  log(`✓ candidate payload staged (${manifest.version})`);

  const releaseDir = commitStagedRelease({ stageDir: staged.stageDir, manifest, home });
  log(`✓ durable release committed under Crew-owned state`);

  const activated = await activateRelease({ home, releaseDir, manifest, log, installer });
  if (!activated) return { ok: false, error: 'activation failed' };

  if (!await ensureRuntimeStep({ home, log, ensureRuntime })) return { ok: false, error: 'Crew DSH runtime bootstrap failed' };

  log('');
  log('Done.');
  log('Restart DeepSeek Harness and Codex Desktop.');
  return { ok: true, version: manifest.version, path: releaseDir };
}

export async function npxUpdate({
  home = homedir(),
  log = console.log,
  sourceRoot,
  installer = realInstaller,
  ensureRuntime,
  npmInstaller,
} = {}) {
  log('DSH Crew updater (npx-managed)');
  const candidateRoot = sourceRoot ?? runningPackageRoot();
  const manifest = readManifest(candidateRoot);
  if (!manifest?.name || !manifest?.version) return { ok: false, error: 'candidate package manifest invalid' };

  const health = currentInstallationHealth({ home });

  if (health.installed && health.healthy && health.pointer.version === manifest.version) {
    log(`- already current (${manifest.version}); repairing registration/integrations idempotently`);
    const activated = await activateRelease({ home, releaseDir: health.pointer.path, manifest, log, installer });
    if (!activated) return { ok: false, error: 'activation failed' };
    if (!await ensureRuntimeStep({ home, log, ensureRuntime })) return { ok: false, error: 'Crew DSH runtime bootstrap failed' };
    log('');
    log('Done.');
    return { ok: true, idempotent: true, version: manifest.version, path: health.pointer.path };
  }

  // Stale, unhealthy, or missing installation: stage the candidate fully and
  // validate it before switching. The previous usable release is left in place
  // until the replacement has been committed and activated successfully.
  if (health.installed && !health.healthy) {
    log('- existing installation is stale or incomplete; repairing via fresh candidate staging');
  }

  const staged = stageCandidatePayload({ sourceRoot: candidateRoot, home, log, npmInstaller });
  if (!staged.ok) {
    log(`✗ staging failed (${staged.code})${staged.detail ? `: ${staged.detail.join('; ')}` : ''}`);
    return { ok: false, error: `staging failed (${staged.code})` };
  }
  log(`✓ candidate payload staged and validated (${manifest.version})`);

  const releaseDir = commitStagedRelease({ stageDir: staged.stageDir, manifest, home });
  log('✓ durable release committed under Crew-owned state');

  const activated = await activateRelease({ home, releaseDir, manifest, log, installer });
  if (!activated) return { ok: false, error: 'activation failed' };

  if (!await ensureRuntimeStep({ home, log, ensureRuntime })) return { ok: false, error: 'Crew DSH runtime bootstrap failed' };

  log('');
  log('Done.');
  log('Restart DeepSeek Harness and Codex Desktop.');
  return { ok: true, updated: true, version: manifest.version, path: releaseDir };
}

export function npxStatus({
  home = homedir(),
  log = console.log,
  sourceRoot,
  installer = realInstaller,
} = {}) {
  const candidateRoot = sourceRoot ?? runningPackageRoot();
  const manifest = readManifest(candidateRoot);
  const candidateVersion = manifest?.version ?? null;

  const pointer = readCurrentPointer({ home });
  let installedLine = 'not installed';
  let installedVersion = null;
  if (pointer) {
    if (existsSync(pointer.path)) {
      const validated = validateInstalledPayload(pointer.path, { expectedName: pointer.name, expectedVersion: pointer.version });
      if (validated.ok) {
        installedVersion = pointer.version;
        installedLine = `${pointer.version} (${pointer.path})`;
      } else {
        installedVersion = pointer.version;
        installedLine = `${pointer.version} at ${pointer.path} (unverifiable/damaged)`;
      }
    } else {
      installedLine = `pointer references missing payload (${pointer.path})`;
    }
  }

  // Read-only DSH plugin state from the dedicated Crew profile only; the
  // official web profile layout is intentionally never inspected.
  let dshPlugin = 'not installed';
  const profilePkgFile = join(crewProfileDir({ home }), 'package.json');
  const packageName = manifest?.name ?? pointer?.name ?? null;
  if (packageName && existsSync(profilePkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(profilePkgFile, 'utf8'));
      const listed = Boolean(pkg.dependencies?.[packageName]) || Boolean(pkg.dsh?.profile?.bundles?.includes?.(packageName));
      const linkOk = packageName && existsSync(registrationLinkPath({ home, name: packageName }));
      dshPlugin = listed && linkOk ? 'installed' : listed ? 'registered but payload link missing' : 'not installed';
    } catch { dshPlugin = 'unknown'; }
  }

  const st = installer.installStatus ? installer.installStatus({ home }) : realInstaller.installStatus({ home });
  const codex = st?.codex?.installed ? 'installed' : 'not installed';
  const claude = st?.claude?.installed ? 'installed' : 'not installed';

  log(`DSH Crew CLI (npx candidate): ${candidateVersion ?? 'unknown'}`);
  log(`Installed DSH Crew: ${installedLine}`);
  log(`DSH plugin: ${dshPlugin} (dedicated dsh-crew profile; official web profile ignored)`);
  log(`Codex Desktop integration: ${codex}`);
  log(`Claude Code integration: ${claude}`);

  return {
    ok: true,
    candidateVersion,
    installedVersion,
    installedPath: pointer?.path ?? null,
    dshPlugin,
    codex,
    claude,
  };
}

export async function npxUninstall({
  home = homedir(),
  purge = false,
  log = console.log,
  installer = realInstaller,
} = {}) {
  log('DSH Crew uninstaller (npx-managed)');
  const failures = [];
  const fail = (text) => { log(`✗ ${text}`); failures.push(text); };

  const pointer = readCurrentPointer({ home });
  const name = pointer?.name ?? readManifest(runningPackageRoot())?.name;

  const cx = installer.uninstallCodex({ home });
  if (cx.ok !== false) log('✓ Codex Desktop integration removed');
  else fail('Codex Desktop integration removal failed');

  const cl = installer.uninstallClaudeCode ? await installer.uninstallClaudeCode({ home }) : realInstaller.uninstallClaudeCode({ home });
  if (cl.ok !== false) log('✓ Claude Code integration removed');
  else fail('Claude Code integration removal failed');

  if (name) {
    const removed = removeCrewPluginRegistration({ home, name });
    if (!removed.ok) fail(`Harness registration removal failed (${removed.code ?? 'unknown'})`);
    else log(removed.removed ? '✓ Harness plugin registration removed (offline, Crew-owned state)' : '- Harness plugin registration already absent');
  } else {
    fail('installed package name unknown; registration not removed');
  }

  if (purge) {
    try {
      rmSync(join(home, '.config', 'dsh-crew'), { recursive: true, force: true });
      log('✓ ~/.config/dsh-crew purged');
    } catch { fail('could not purge ~/.config/dsh-crew'); }
  } else {
    // Remove ONLY the Crew-managed installed payload; config, credentials,
    // backups, and the isolated Harness home stay untouched.
    try {
      rmSync(crewAppRoot({ home }), { recursive: true, force: true });
      log('✓ Crew-managed installed payload removed (config/backups kept)');
    } catch { fail('could not remove the Crew-managed installed payload'); }
  }

  if (failures.length > 0) {
    log('');
    log('FAILED: uninstall incomplete');
    return { ok: false, failures };
  }
  log('');
  log('Done.');
  return { ok: true, failures: [] };
}

// ---- CLI dispatch --------------------------------------------------------------

export const USAGE = `usage: dsh-crew <command> [--purge]

Commands:
  install     persist the candidate package into Crew-owned state and register it
  status      read-only report of candidate/installed versions and integrations
  update      upgrade-aware update: stages/validates first, repairs, idempotent when current
  uninstall   remove the Crew-managed payload, registration, and integrations (config kept)

Options:
  --purge     with uninstall: also remove ~/.config/dsh-crew config/backups (destructive)
  --help      show this help

Source checkouts use scripts/setup.mjs instead.`;

function normalizeCommand(argv) {
  const flags = argv.slice(1);
  const knownFlags = new Set(['--purge']);
  const unknown = flags.filter((f) => f.startsWith('--') && !knownFlags.has(f));
  return { command: argv[0], purge: flags.includes('--purge'), unknown };
}

/**
 * CLI dispatcher used by bin/dsh-crew.mjs. Returns a process exit code.
 */
export async function runNpxCli({
  argv = process.argv.slice(2),
  log = console.log,
  error = console.error,
  commands = {},
} = {}) {
  const { command, purge, unknown } = normalizeCommand(argv);
  if (command === '--help' || command === '-h' || command === 'help') {
    log(USAGE);
    return 0;
  }
  if (!command) {
    error(USAGE);
    return 1;
  }
  if (unknown.length > 0 || !['install', 'status', 'update', 'uninstall'].includes(command)) {
    error(`unknown command: ${command ?? '<none>'}\n\n${USAGE}`);
    return 1;
  }
  try {
    const actions = {
      install: commands.install ?? npxInstall,
      status: commands.status ?? npxStatus,
      update: commands.update ?? npxUpdate,
      uninstall: commands.uninstall ?? npxUninstall,
    };
    const result = command === 'uninstall'
      ? await actions.uninstall({ purge, log })
      : await actions[command]({ log });
    return result?.ok === false ? 1 : 0;
  } catch (err) {
    error(`dsh-crew ${command} failed: ${err?.message ?? err}`);
    return 1;
  }
}
