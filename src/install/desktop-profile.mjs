// Desktop-client integration for the official DSH desktop application.
//
// The desktop app (an Electron client) boots its own Harness against ~/.dsh with
// the app-exclusive `desktop` profile — the CLI refuses to manage that profile —
// and applies that profile's user patch layer, which the Harness hot-watches. So
// the only way the desktop app shows the Crew panel is an insert in
// <official home>/profiles/desktop/cordis.patch.yml pointing at the Crew web
// bridge snapshot. That file lives in the official home, which Crew otherwise
// treats as read-only: this module is reachable ONLY from the explicit
// `dsh-crew desktop attach|detach|status` commands and never runs during install,
// update or any supervision path. attach is idempotent and re-points a stale
// revision; detach removes exactly the block this module wrote, leaving the rest
// of the file byte for byte.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const BRIDGE_ID = 'dsh-crew-official-web-bridge';
const BRIDGE_PACKAGE = '@ran-sh/dsh-crew-web-bridge';
const MARKER = '# dsh-crew desktop bridge (managed by dsh-crew; remove with: dsh-crew desktop detach)';
const REVISION_RE = /^[a-f0-9]{64}$/;

export function desktopPatchFile({ home = homedir() } = {}) {
  return join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
}

/** The bridge entry the Crew launcher itself would load, straight from the overlay. */
export function crewBridgeEntry({ home = homedir() } = {}) {
  const overlayFile = join(home, '.config', 'dsh-crew', 'frontend', 'official-web.patch.json');
  let parsed;
  try { parsed = JSON.parse(readFileSync(overlayFile, 'utf8')); } catch { return { ok: false, code: 'CREW_BRIDGE_OVERLAY_UNAVAILABLE', overlayFile }; }
  const root = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  const insert = root && Array.isArray(root.insert) && root.insert.length === 1 ? root.insert[0] : null;
  const entryUri = insert && typeof insert.name === 'string' ? insert.name : null;
  if (!entryUri || insert.id !== BRIDGE_ID || !entryUri.startsWith('file://')) {
    return { ok: false, code: 'CREW_BRIDGE_OVERLAY_INVALID', overlayFile };
  }
  let entryPath;
  try { entryPath = fileURLToPath(entryUri); } catch { return { ok: false, code: 'CREW_BRIDGE_OVERLAY_INVALID', overlayFile }; }
  if (!existsSync(entryPath)) return { ok: false, code: 'CREW_BRIDGE_SNAPSHOT_MISSING', overlayFile, entry: entryUri };
  // The launcher checks the same pair before it starts a frontend: the snapshot's
  // own manifest must claim to be Crew-managed and must agree with the revision
  // its directory is named after.
  const revision = basename(dirname(dirname(entryPath)));
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(dirname(entryPath), 'package.json'), 'utf8')); } catch { manifest = null; }
  if (!manifest || manifest.name !== BRIDGE_PACKAGE || manifest.dshCrewManagedFrontend !== true
    || manifest.dshCrewFrontendRevision !== revision || !REVISION_RE.test(revision)) {
    return { ok: false, code: 'CREW_BRIDGE_SNAPSHOT_INVALID', overlayFile, entry: entryUri, revision };
  }
  return { ok: true, overlayFile, entry: entryUri, entryPath, revision };
}

function blockFor(entryUri, eol) {
  return [
    MARKER,
    '- insert:',
    `    - id: ${BRIDGE_ID}`,
    `      name: '${entryUri}'`,
    '',
  ].join(eol);
}

function blockPattern(eol) {
  const e = eol === '\r\n' ? '\\r\\n' : '\\n';
  return new RegExp(
    `^${MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${e}- insert:${e} {4}- id: ${BRIDGE_ID}${e} {6}name: '[^'${e}]*'${e}?`,
    'm',
  );
}

function detectsEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

// Fail closed on a patch layer whose shape this module does not understand: a
// top-level YAML array of patch entries. Anything else is somebody's file.
function looksLikePatchArray(text) {
  const firstMeaningful = text.split(/\r?\n/).find((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  if (firstMeaningful === undefined) return true;
  const trimmed = firstMeaningful.trimStart();
  return trimmed.startsWith('-') || trimmed === '[]' || trimmed === '---';
}

export function desktopStatus({ home = homedir() } = {}) {
  const patchFile = desktopPatchFile({ home });
  const bridge = crewBridgeEntry({ home });
  let text = null;
  try { text = readFileSync(patchFile, 'utf8'); } catch { text = null; }
  const eol = text === null ? '\n' : detectsEol(text);
  const block = text === null ? null : blockPattern(eol).exec(text);
  return {
    ok: true,
    path: patchFile,
    file_present: text !== null,
    bridge: bridge.ok ? { entry: bridge.entry, revision: bridge.revision } : null,
    bridge_error: bridge.ok ? null : bridge.code,
    attached: block !== null,
    current: block !== null && bridge.ok ? block[0].includes(bridge.entry) : false,
  };
}

function writeAtomic(file, text) {
  const temp = `${file}.dsh-crew.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
}

export function desktopAttach({ home = homedir(), dryRun = false, log = () => {} } = {}) {
  const bridge = crewBridgeEntry({ home });
  if (!bridge.ok) return { ok: false, code: bridge.code, error: `Crew bridge snapshot is unavailable (${bridge.code})` };
  const patchFile = desktopPatchFile({ home });
  let text = null;
  try { text = readFileSync(patchFile, 'utf8'); } catch { text = null; }
  const eol = text === null ? '\n' : detectsEol(text);
  if (text !== null && !looksLikePatchArray(text)) {
    return { ok: false, code: 'DESKTOP_PATCH_SHAPE_UNSUPPORTED', error: `${patchFile} is not a top-level patch array; refusing to edit it`, path: patchFile };
  }
  const block = blockFor(bridge.entry, eol);
  const withoutBlock = text === null ? null : text.replace(blockPattern(eol), '');
  const current = withoutBlock !== null && text.includes(bridge.entry) && withoutBlock !== text;
  const base = withoutBlock ?? '';
  const separator = base === '' || base.endsWith('\n') ? '' : eol;
  const next = `${base}${separator}${block}`;
  if (text !== null && next === text) {
    log(`- desktop app already carries the Crew bridge for revision ${bridge.revision}`);
    return { ok: true, changed: false, path: patchFile, entry: bridge.entry, revision: bridge.revision };
  }
  if (dryRun) {
    log(`- would ${current ? 're-point' : 'attach'} the Crew bridge in ${patchFile} (revision ${bridge.revision})`);
    return { ok: true, changed: true, dryRun: true, path: patchFile, entry: bridge.entry, revision: bridge.revision };
  }
  mkdirSync(dirname(patchFile), { recursive: true });
  writeAtomic(patchFile, next);
  log(`✓ desktop app ${current ? 're-pointed to' : 'attached to'} the Crew bridge (revision ${bridge.revision})`);
  log('  the Harness hot-watches this patch layer; if the panel does not appear, restart the desktop app');
  return { ok: true, changed: true, path: patchFile, entry: bridge.entry, revision: bridge.revision };
}

export function desktopDetach({ home = homedir(), dryRun = false, log = () => {} } = {}) {
  const patchFile = desktopPatchFile({ home });
  let text;
  try { text = readFileSync(patchFile, 'utf8'); } catch {
    log('- desktop patch layer is absent; nothing to remove');
    return { ok: true, changed: false, path: patchFile };
  }
  const eol = detectsEol(text);
  const next = text.replace(blockPattern(eol), '');
  if (next === text) {
    log('- the Crew bridge is not present in the desktop patch layer');
    return { ok: true, changed: false, path: patchFile };
  }
  if (dryRun) return { ok: true, changed: true, dryRun: true, path: patchFile };
  // A file this module created holds only its own block: remove the file rather
  // than leave an empty one behind.
  if (next.trim() === '') {
    rmSync(patchFile, { force: true });
    log('✓ removed the Crew bridge from the desktop patch layer (the file held nothing else)');
    return { ok: true, changed: true, path: patchFile, removed_file: true };
  }
  writeAtomic(patchFile, next);
  log('✓ removed the Crew bridge from the desktop patch layer');
  return { ok: true, changed: true, path: patchFile };
}

export { MARKER as DESKTOP_BRIDGE_MARKER, BRIDGE_ID as DESKTOP_BRIDGE_ID };
