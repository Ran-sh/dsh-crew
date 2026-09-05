import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

function plan(home, root) {
  const bridge = join(root, 'official-web-bridge');
  const metadata = JSON.parse(readFileSync(join(bridge, 'package.json'), 'utf8'));
  if (metadata.name !== '@ran-sh/dsh-crew-web-bridge') throw new Error('invalid frontend package');
  const files = new Map([
    ['official-web-bridge/entry.mjs', readFileSync(join(bridge, 'overlay-entry.mjs'))],
    ['official-web-bridge/lib/client.js', readFileSync(join(bridge, 'lib', 'client.js'))],
    ['src/local-request-guard.mjs', readFileSync(join(root, 'src', 'local-request-guard.mjs'))],
  ]);
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

function matches(p) {
  try { return [...p.files].every(([name, bytes]) => {
    const file = join(p.snapshotRoot, name);
    return lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink() && readFileSync(file).equals(bytes);
  }); } catch { return false; }
}

export function officialFrontendAssetsReady({ home = homedir(), root } = {}) {
  try {
    const p = plan(home, root);
    return matches(p) && readFileSync(p.overlayFile, 'utf8') === p.overlay;
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
      try { renameSync(stage, p.snapshotRoot); stage = null; }
      catch (error) { if (!matches(p)) throw error; }
    }
    if (!matches(p)) throw new Error('frontend snapshot conflicts with its revision');
    temp = `${p.overlayFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, p.overlay, { flag: 'wx', mode: 0o600 });
    renameSync(temp, p.overlayFile); temp = null;
    return { ok: true, changed: true, revision: p.revision, snapshotRoot: p.snapshotRoot, overlayFile: p.overlayFile };
  } catch (error) {
    return { ok: false, code: 'OFFICIAL_FRONTEND_ASSETS_FAILED', error: error.message };
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (temp) rmSync(temp, { force: true });
  }
}
