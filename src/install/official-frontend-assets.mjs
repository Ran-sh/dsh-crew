import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { renameTree } from './tree-move.mjs';

function plan(home, root) {
  const bridge = join(root, 'official-web-bridge');
  const metadata = JSON.parse(readFileSync(join(bridge, 'package.json'), 'utf8'));
  if (metadata.name !== '@ran-sh/dsh-crew-web-bridge') throw new Error('invalid frontend package');
  const files = new Map([
    ['official-web-bridge/entry.mjs', readFileSync(join(bridge, 'overlay-entry.mjs'))],
    ['official-web-bridge/lib/client.js', readFileSync(join(bridge, 'lib', 'client.js'))],
    ['src/local-request-guard.mjs', readFileSync(join(root, 'src', 'local-request-guard.mjs'))],
  ]);
  // The snapshot is a canonical artifact: these sources are text that either line
  // ending serves, so its bytes and its revision both normalize to LF. Otherwise a
  // `core.autocrlf=true` checkout hashes to a different revision than the npm
  // payload it installs, which made readiness look for a snapshot that does not
  // exist and reported "needs repair" on a correct install (and made every payload
  // update look like a stale desktop revision). Lone CR collapses too: one line
  // break is one line break in these sources.
  const canonicalBytes = (bytes) => (bytes.includes(0) ? bytes
    : Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8'));
  for (const [name, bytes] of files) files.set(name, canonicalBytes(bytes));
  const hash = createHash('sha256').update(JSON.stringify(metadata));
  for (const [name, bytes] of files) hash.update(name).update(bytes);
  const revision = hash.digest('hex');
  files.set('official-web-bridge/package.json', Buffer.from(JSON.stringify({ ...metadata,
    dshCrewManagedFrontend: true, dshCrewFrontendRevision: revision,
    dsh: { ...metadata.dsh, bundle: undefined },
  }, null, 2) + '\n'));
  const frontendRoot = join(home, '.config', 'dsh-crew', 'frontend');
  const snapshotRoot = join(frontendRoot, 'revisions', revision);
  const overlayFile = join(frontendRoot, 'official-web.patch.json');
  const overlay = JSON.stringify([{ insert: [{ id: 'dsh-crew-official-web-bridge',
    name: pathToFileURL(join(snapshotRoot, 'official-web-bridge', 'entry.mjs')).href,
  }] }], null, 2) + '\n';
  return { frontendRoot, snapshotRoot, revision, overlayFile, overlay, files };
}

// Git checks a `core.autocrlf=true` Windows tree out as CRLF while the installed
// snapshot was written from the npm payload (LF). The bridge sources are text that
// either line ending serves, so a CRLF checkout must not read as a drifted snapshot;
// bytes are still compared first, and the tolerant path only applies to text.
// Lone CR is normalized as well, so a file saved with classic-Mac endings reads as
// the same source rather than as content drift.
function sameTextContent(installed, expected) {
  if (installed.equals(expected)) return true;
  if (installed.includes(0) || expected.includes(0)) return false;
  const normalize = (buffer) => buffer.toString('utf8').replace(/\r\n?/g, '\n');
  return normalize(installed) === normalize(expected);
}

function matches(p) {
  try { return [...p.files].every(([name, bytes]) => {
    const file = join(p.snapshotRoot, name);
    return lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() && sameTextContent(readFileSync(file), bytes);
  }); } catch { return false; }
}

export function officialFrontendAssetsReady({ home = homedir(), root } = {}) {
  try {
    const p = plan(home, root);
    const overlay = readFileSync(p.overlayFile, 'utf8');
    return matches(p) && (overlay === p.overlay || overlay.replace(/\r\n?/g, '\n') === p.overlay.replace(/\r\n?/g, '\n'));
  } catch { return false; }
}

export function installOfficialFrontendAssets({ home = homedir(), root } = {}) {
  let stage;
  let temp;
  try {
    const p = plan(home, root);
    for (const path of [p.frontendRoot, join(p.frontendRoot, 'revisions'), p.snapshotRoot, p.overlayFile]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('linked frontend destination');
    }
    const already = officialFrontendAssetsReady({ home, root });
    if (already) return { ok: true, changed: false, revision: p.revision, snapshotRoot: p.snapshotRoot, overlayFile: p.overlayFile };
    mkdirSync(join(p.frontendRoot, 'revisions'), { recursive: true });
    if (!existsSync(p.snapshotRoot)) {
      stage = mkdtempSync(join(p.frontendRoot, '.stage-'));
      for (const [name, bytes] of p.files) {
        const file = join(stage, name);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, bytes);
      }
      // Windows can refuse this rename for a moment when something else holds a
      // handle under the destination, and the refusal is not about the rename:
      // the same call succeeds shortly after. Producing the snapshot first in a
      // concurrent installer is the other outcome this tolerates.
      try { renameTree(stage, p.snapshotRoot); stage = null; }
      catch (error) { if (!matches(p)) throw error; }
    }
    if (!matches(p)) throw new Error('frontend snapshot conflicts with its revision');
    temp = `${p.overlayFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, p.overlay, { flag: 'wx', mode: 0o600 });
    renameTree(temp, p.overlayFile); temp = null;
    return { ok: true, changed: true, revision: p.revision, snapshotRoot: p.snapshotRoot, overlayFile: p.overlayFile };
  } catch (error) {
    return { ok: false, code: 'OFFICIAL_FRONTEND_ASSETS_FAILED', error: error.message };
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (temp) rmSync(temp, { force: true });
  }
}
