import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const WORKSPACE = 'harness/storages/workspace.json';
const LIMIT = 512 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(id);
const fail = code => { throw new Error(`HISTORY_${code}`); };

function pathInside(root, relativePath) {
  if (typeof relativePath !== 'string' || isAbsolute(relativePath) || relativePath.includes('\\')
    || relativePath.includes(':') || relativePath.split('/').some(p => !p || p === '.' || p === '..')) fail('INVALID_PATH');
  let current = resolve(root);
  if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) fail('LINKED_ROOT');
  for (const part of relativePath.split('/')) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) fail('LINKED_PATH'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}

function artifactPath(root, file) {
  if (!validId(file?.sessionId) || typeof file.relativePath !== 'string'
    || !/^harness\/sessions\/[^/]+\/[^/]+\/session\.jsonl(?:\.zstd)?$/.test(file.relativePath)
    || file.relativePath.split('/')[3] !== file.sessionId) fail('INVALID_ARTIFACT');
  return pathInside(root, file.relativePath);
}

function readBounded(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT) fail('INVALID_FILE');
  const bytes = readFileSync(file);
  if (bytes.length > LIMIT || bytes.length !== info.size) fail('FILE_CHANGED');
  return bytes;
}

function atomic(root, relativePath, bytes) {
  const file = pathInside(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  pathInside(root, relativePath);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function decodeStore(bytes) {
  const store = JSON.parse(bytes.toString('utf8'));
  if (store?.unit?.name !== 'workspace' || store.unit.version !== 2 || store.global?.initialized !== true
    || store.global.pendingMutation || !Array.isArray(store.global.workspaceIds) || !Array.isArray(store.global.archivedSessionIds)
    || !store.tables?.workspaces || Array.isArray(store.tables.workspaces)) fail('UNSUPPORTED_STORAGE');
  const table = store.tables.workspaces;
  if (Object.keys(table).length > 10000 || store.global.workspaceIds.length !== Object.keys(table).length
    || new Set(store.global.workspaceIds).size !== store.global.workspaceIds.length
    || store.global.workspaceIds.some(id => !validId(id) || !Object.hasOwn(table, id))) fail('INVALID_STORAGE');
  for (const record of Object.values(table)) if (!record || !Array.isArray(record.sessionIds)
    || record.sessionIds.some(id => !validId(id)) || typeof record.path !== 'string') fail('INVALID_STORAGE');
  return store;
}

function batchPath(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail('INVALID_ARCHIVE_ID');
  return `history/transactions/${id}`;
}

function saveManifest(root, manifest) {
  atomic(root, `${batchPath(manifest.id)}/manifest.json`, JSON.stringify(manifest));
}

function loadManifest(root, id) {
  const manifest = JSON.parse(readBounded(pathInside(root, `${batchPath(id)}/manifest.json`)));
  if (manifest.id !== id || manifest.schemaVersion !== 1 || !['archive', 'delete'].includes(manifest.operation)
    || !Array.isArray(manifest.files) || manifest.files.length > 10000) fail('INVALID_MANIFEST');
  decodeStore(Buffer.from(JSON.stringify(manifest.before)));
  decodeStore(Buffer.from(JSON.stringify(manifest.after)));
  for (const file of manifest.files) artifactPath(root, file);
  return manifest;
}

async function requireStopped(assertStopped) {
  if (typeof assertStopped !== 'function' || await assertStopped() !== true) fail('BACKEND_NOT_STOPPED');
}

/** Internal offline primitive: caller must own the maintenance lease + update lock. */
export async function archiveHistory({ crewRoot, request, assertStopped }) {
  await requireStopped(assertStopped);
  if (!request || !['archive', 'delete'].includes(request.operation) || !Array.isArray(request.artifacts)
    || !Array.isArray(request.sessionIds) || !Array.isArray(request.workspaceIds)
    || request.artifacts.length > 10000 || request.workspaceIds.length > 10000) fail('INVALID_REQUEST');
  const selectedSessions = new Set(request.sessionIds);
  const selectedWorkspaces = new Set(request.workspaceIds);
  if ([...selectedSessions, ...selectedWorkspaces].some(id => !validId(id))
    || selectedSessions.size !== request.sessionIds.length || selectedWorkspaces.size !== request.workspaceIds.length
    || request.artifacts.length !== selectedSessions.size
    || new Set(request.artifacts.map(f => f.sessionId)).size !== selectedSessions.size
    || request.artifacts.some(f => !selectedSessions.has(f.sessionId))) fail('INVALID_SELECTION');
  const beforeBytes = readBounded(pathInside(crewRoot, WORKSPACE));
  if (hash(beforeBytes) !== request.workspaceHash) fail('PREVIEW_CHANGED');
  const before = decodeStore(beforeBytes);
  const after = structuredClone(before);
  for (const id of selectedWorkspaces) {
    const record = before.tables.workspaces[id];
    if (!record || record.sessionIds.some(sid => !selectedSessions.has(sid))) fail('PREVIEW_CHANGED');
    delete after.tables.workspaces[id];
  }
  after.global.workspaceIds = after.global.workspaceIds.filter(id => !selectedWorkspaces.has(id));
  after.global.archivedSessionIds = after.global.archivedSessionIds.filter(id => !selectedSessions.has(id));
  for (const record of Object.values(after.tables.workspaces)) record.sessionIds = record.sessionIds.filter(id => !selectedSessions.has(id));
  let size = 0;
  const files = request.artifacts.map(file => {
    const bytes = readBounded(artifactPath(crewRoot, file));
    size += bytes.length;
    if (size > LIMIT) fail('ARCHIVE_TOO_LARGE');
    if (hash(bytes) !== file.sha256) fail('PREVIEW_CHANGED');
    return { sessionId: file.sessionId, relativePath: file.relativePath, sha256: file.sha256, size: bytes.length };
  });
  const manifest = { schemaVersion: 1, id: randomUUID(), operation: request.operation,
    createdAt: new Date().toISOString(), state: 'PREPARING', files, before, after };
  saveManifest(crewRoot, manifest);
  try {
    for (const [index, file] of files.entries()) {
      atomic(crewRoot, `${batchPath(manifest.id)}/files/${index}.bin`, readBounded(artifactPath(crewRoot, file)));
      if (hash(readBounded(pathInside(crewRoot, `${batchPath(manifest.id)}/files/${index}.bin`))) !== file.sha256) fail('BACKUP_CHANGED');
    }
    manifest.state = 'PREPARED'; saveManifest(crewRoot, manifest);
    await requireStopped(assertStopped);
    if (hash(readBounded(pathInside(crewRoot, WORKSPACE))) !== request.workspaceHash) fail('PREVIEW_CHANGED');
    for (const file of files) if (hash(readBounded(artifactPath(crewRoot, file))) !== file.sha256) fail('PREVIEW_CHANGED');
    manifest.state = 'APPLYING'; saveManifest(crewRoot, manifest);
    for (const file of files) unlinkSync(artifactPath(crewRoot, file));
    atomic(crewRoot, WORKSPACE, JSON.stringify(after));
    manifest.state = 'APPLIED'; saveManifest(crewRoot, manifest);
    return { id: manifest.id, state: manifest.state, operation: manifest.operation, counts: { sessions: files.length, workspaces: selectedWorkspaces.size } };
  } catch (error) {
    // The caller retains the stopped lease. Never restart after this exception
    // without explicitly recovering the referenced durable transaction.
    error.archiveId = manifest.id;
    throw error;
  }
}

export async function restoreHistory({ crewRoot, archiveId, assertStopped }) {
  await requireStopped(assertStopped);
  const manifest = loadManifest(crewRoot, archiveId);
  if (manifest.operation !== 'archive' || manifest.state !== 'APPLIED') fail('ARCHIVE_NOT_RESTORABLE');
  const current = decodeStore(readBounded(pathInside(crewRoot, WORKSPACE)));
  const next = structuredClone(current);
  for (const [id, old] of Object.entries(manifest.before.tables.workspaces)) {
    const after = manifest.after.tables.workspaces[id];
    if (equal(old, after)) continue;
    if (!equal(current.tables.workspaces[id], after)) fail('RESTORE_CONFLICT');
    if (Object.entries(current.tables.workspaces).some(([other, record]) => other !== id && record.path === old.path)) fail('RESTORE_CONFLICT');
    next.tables.workspaces[id] = old;
  }
  next.global.workspaceIds = [...manifest.before.global.workspaceIds.filter(id => !current.global.workspaceIds.includes(id)), ...current.global.workspaceIds];
  const selected = new Set(manifest.files.map(file => file.sessionId));
  next.global.archivedSessionIds = [...new Set([...current.global.archivedSessionIds, ...manifest.before.global.archivedSessionIds.filter(id => selected.has(id))])];
  for (const [index, file] of manifest.files.entries()) {
    if (existsSync(artifactPath(crewRoot, file))) fail('RESTORE_CONFLICT');
    if (hash(readBounded(pathInside(crewRoot, `${batchPath(archiveId)}/files/${index}.bin`))) !== file.sha256) fail('BACKUP_CHANGED');
  }
  manifest.restoreBefore = current; manifest.restoreAfter = next; manifest.state = 'RESTORING'; saveManifest(crewRoot, manifest);
  await requireStopped(assertStopped);
  for (const [index, file] of manifest.files.entries()) {
    const target = artifactPath(crewRoot, file);
    mkdirSync(dirname(target), { recursive: true });
    // Exclusive publication: never overwrite a concurrently created artifact.
    const fd = openSync(artifactPath(crewRoot, file), 'wx', 0o600);
    try { writeFileSync(fd, readBounded(pathInside(crewRoot, `${batchPath(archiveId)}/files/${index}.bin`))); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  atomic(crewRoot, WORKSPACE, JSON.stringify(next));
  manifest.state = 'RESTORED'; saveManifest(crewRoot, manifest);
  return { id: archiveId, state: manifest.state };
}
