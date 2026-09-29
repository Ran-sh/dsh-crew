// Mirror the operator's user-level DSH configuration from the OFFICIAL home into
// Crew's own home, so the Crew hub works with the same models, providers, policy
// and MCP servers as the desktop app the operator actually uses.
//
// The official home is read-only here — nothing under ~/.dsh is ever written.
// Secrets are never copied either: provider entries reference their keys through
// `apiKeyEnv`, and those variables live in the operator's user environment, which
// every harness process inherits.
//
// Two hazards shape the rules:
//   1. The desktop app runs a DIFFERENT cohort than Crew pins (0.1.7-rc.2 vs
//      0.1.6-alpha.1), so an entry may name a package Crew's runtime does not
//      have. The Harness installs patches fail-loud, so such an entry would break
//      the hub: it is skipped and reported instead.
//   2. Crew's own managed blocks (the desktop bridge insert) are not user
//      configuration and are never mirrored.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { crewDshHome } from './install.mjs';
import { crewDshRuntimeRoot } from '../dsh-cli-runtime.mjs';
import { DESKTOP_BRIDGE_ID, DESKTOP_BRIDGE_MARKER } from './desktop-profile.mjs';

const CREW_PROFILE_NAME = 'dsh-crew';

export function officialHomeDir({ home = homedir() } = {}) {
  return join(home, '.dsh');
}

export function configMirrorTargets({ home = homedir() } = {}) {
  const crewHome = crewDshHome({ home });
  const official = officialHomeDir({ home });
  return {
    crewHome,
    homeLayer: {
      label: 'home layer (MCP servers)',
      source: join(official, 'cordis.patch.yml'),
      target: join(crewHome, 'cordis.patch.yml'),
    },
    profileLayer: {
      label: 'profile layer (models/providers/policy)',
      source: join(official, 'profiles', 'desktop', 'cordis.patch.yml'),
      target: join(crewHome, 'profiles', CREW_PROFILE_NAME, 'cordis.patch.yml'),
    },
  };
}

// Does the Harness's resolution of this specifier succeed inside the Crew runtime
// tree? npm nests whole subtrees under family packages, so the nested scopes are
// checked too — that is where a hoisted sibling actually resolves from.
function resolvesInRuntime(runtimeRoot, specifier) {
  if (typeof specifier !== 'string' || specifier === '') return true;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) return true;
  const moduleRoot = join(runtimeRoot, 'node_modules');
  const parts = specifier.split('/');
  if (existsSync(join(moduleRoot, ...parts))) return true;
  const scopeDir = join(moduleRoot, '@deepseek-ai');
  let packages;
  try { packages = readdirSync(scopeDir); } catch { return false; }
  for (const name of packages) {
    const nested = join(scopeDir, name, 'node_modules');
    if (existsSync(join(nested, ...parts))) return true;
    let inner;
    try { inner = readdirSync(join(nested, '@deepseek-ai')); } catch { continue; }
    for (const deeper of inner) {
      if (existsSync(join(nested, '@deepseek-ai', deeper, 'node_modules', ...parts))) return true;
    }
  }
  return false;
}

// Split a patch layer into its top-level entries, verbatim. A comment at column 0
// is NOT part of the preceding entry — it separates entries (Crew's own managed
// block marker sits between entries, and attaching it to the entry above would
// drop that entry from the mirror).
function splitEntries(text) {
  const entries = [];
  let current = null;
  const flush = () => { if (current) entries.push(current); current = null; };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('- ') || line === '-') {
      flush();
      current = [line];
      continue;
    }
    if (line.startsWith('#')) {
      flush();
      entries.push([line]);
      continue;
    }
    if (current) current.push(line);
  }
  flush();
  return entries.map((lines) => lines.join('\n').replace(/\s+$/, ''));
}

function entryMeta(entry) {
  return {
    id: entry.match(/^- id:[ \t]*(\S+)/m)?.[1] ?? null,
    insertId: entry.match(/^[ \t]+- id:[ \t]*(\S+)/m)?.[1] ?? null,
    name: entry.match(/^[ \t]+name:[ \t]*["']?([^"'\s]+)/m)?.[1] ?? null,
  };
}

function isOwnManagedBlock(entry, meta) {
  return entry.includes(DESKTOP_BRIDGE_MARKER) || meta.id === DESKTOP_BRIDGE_ID || meta.insertId === DESKTOP_BRIDGE_ID;
}

function mirrorLayer({ layer, crewHome, runtimeRoot, dryRun, log }) {
  const { source, target, label } = layer;
  if (!existsSync(source)) {
    log(`- ${label}: no official source at ${source}; nothing to mirror`);
    return { ok: true, changed: false, entries: 0, skipped: [], source, target, label };
  }
  const eol = readFileSync(source, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  const kept = [];
  const skipped = [];
  const isCommentOnly = (entry) => entry.split(/\r?\n/).every((line) => line.trim() === '' || line.startsWith('#'));
  for (const entry of splitEntries(readFileSync(source, 'utf8'))) {
    if (entry.trim() === '') continue;
    if (isCommentOnly(entry) && !entry.includes(DESKTOP_BRIDGE_MARKER)) continue; // file prose, not configuration
    const meta = entryMeta(entry);
    if (isOwnManagedBlock(entry, meta)) {
      skipped.push({ id: meta.insertId ?? meta.id, reason: 'crew-managed' });
      continue;
    }
    if (!meta.id && !meta.insertId) {
      skipped.push({ id: null, reason: 'unrecognized-entry' });
      continue;
    }
    if (!resolvesInRuntime(runtimeRoot, meta.name)) {
      skipped.push({ id: meta.id ?? meta.insertId, name: meta.name, reason: 'not-in-crew-cohort' });
      continue;
    }
    kept.push(entry);
  }
  const header = [
    `# Mirrored from ${source} by dsh-crew config import.`,
    '# Crew keeps its own DSH home; this layer carries the operator\'s user-level',
    '# configuration so the Crew hub matches the desktop app. Edit the source and',
    '# re-run the import — changes here are overwritten.',
    '',
  ].join(eol);
  const body = kept.length ? `${header}${kept.join(`${eol}${eol}`)}${eol}` : '';
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : null;
  for (const item of skipped) {
    log(`  ! skipped ${item.id ?? '(unknown entry)'}${item.name ? ` [${item.name}]` : ''}: ${
      item.reason === 'not-in-crew-cohort'
        ? 'package is not in the Crew runtime cohort'
        : item.reason === 'crew-managed' ? 'Crew-managed block' : 'unrecognized entry shape'
    }`);
  }
  if (existing === body) {
    log(`- ${label}: already mirrored (${kept.length} entries)`);
    return { ok: true, changed: false, entries: kept.length, skipped, source, target, label };
  }
  if (dryRun) {
    log(`- ${label}: would mirror ${kept.length} entries -> ${target}`);
    return { ok: true, changed: true, dryRun: true, entries: kept.length, skipped, source, target, label };
  }
  if (!existsSync(dirname(target))) {
    return { ok: false, code: 'CREW_HOME_LAYER_MISSING', error: `Crew directory is absent: ${dirname(target)}`, label };
  }
  const temp = `${target}.dsh-crew.${process.pid}.tmp`;
  writeFileSync(temp, body);
  renameSync(temp, target);
  log(`✓ ${label}: mirrored ${kept.length} entries -> ${target}`);
  return { ok: true, changed: true, entries: kept.length, skipped, source, target, label };
}

export function mirrorOfficialHarnessConfig({ home = homedir(), dryRun = false, log = () => {} } = {}) {
  const targets = configMirrorTargets({ home });
  const runtimeRoot = crewDshRuntimeRoot({ home });
  const layers = [];
  for (const layer of [targets.homeLayer, targets.profileLayer]) {
    const result = mirrorLayer({ layer, crewHome: targets.crewHome, runtimeRoot, dryRun, log });
    layers.push(result);
    if (!result.ok) return { ok: false, code: result.code, error: result.error, layers };
  }
  return {
    ok: true,
    changed: layers.some((layer) => layer.changed),
    dryRun,
    layers: layers.map(({ label, source, target, changed, entries, skipped }) => ({ label, source, target, changed, entries, skipped })),
  };
}

export function officialConfigMirrorStatus({ home = homedir() } = {}) {
  const targets = configMirrorTargets({ home });
  const inspect = (layer) => {
    let targetText = null;
    try { targetText = readFileSync(layer.target, 'utf8'); } catch { targetText = null; }
    return {
      label: layer.label,
      source: layer.source,
      source_present: existsSync(layer.source),
      target: layer.target,
      target_present: targetText !== null,
      mirrored: targetText !== null && targetText.includes('by dsh-crew config import'),
    };
  };
  return { ok: true, home_layer: inspect(targets.homeLayer), profile_layer: inspect(targets.profileLayer) };
}
