import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const load = () => import('../src/history/archive-store.mjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'crew-history-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'harness/storages'), { recursive: true });
  const file = 'harness/sessions/project/session-a/session.jsonl';
  mkdirSync(join(root, 'harness/sessions/project/session-a'), { recursive: true });
  writeFileSync(join(root, file), 'private conversation\n');
  const workspace = { unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [] },
    tables: { workspaces: { w1: { path: '/project/source', title: 'Example', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', sessionIds: ['session-a'] } } } };
  const bytes = Buffer.from(JSON.stringify(workspace));
  writeFileSync(join(root, 'harness/storages/workspace.json'), bytes);
  return { root, file, bytes, workspace, request: { operation: 'archive', workspaceHash: hash(bytes), workspaceIds: ['w1'], sessionIds: ['session-a'],
    artifacts: [{ sessionId: 'session-a', relativePath: file, sha256: hash(readFileSync(join(root, file))) }] } };
}

test('archive removes only scoped registration/log and restores exact bytes and record identity', async t => {
  const f = fixture(t); const api = await load();
  const result = await api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => true });
  assert.equal(existsSync(join(f.root, f.file)), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'harness/storages/workspace.json'))).global.workspaceIds, []);
  await api.restoreHistory({ crewRoot: f.root, archiveId: result.id, assertStopped: () => true });
  assert.equal(readFileSync(join(f.root, f.file), 'utf8'), 'private conversation\n');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'harness/storages/workspace.json'))), f.workspace);
});

test('archive refuses live backend, stale bytes and paths outside the session allowlist', async t => {
  const f = fixture(t); const api = await load();
  await assert.rejects(api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => false }), /NOT_STOPPED/);
  await assert.rejects(api.archiveHistory({ crewRoot: f.root, request: { ...f.request, workspaceHash: 'bad' }, assertStopped: () => true }), /CHANGED/);
  for (const path of ['../official/session.jsonl', '/project/source', 'harness/settings.yaml']) {
    await assert.rejects(api.archiveHistory({ crewRoot: f.root, request: { ...f.request, artifacts: [{ ...f.request.artifacts[0], relativePath: path }] }, assertStopped: () => true }));
  }
  assert.equal(readFileSync(join(f.root, f.file), 'utf8'), 'private conversation\n');
});

// The state this whole path exists for: a workspace left behind by an earlier
// cleanup, whose sessions are already gone. There is no artifact to delete, so
// the only thing the request can do is remove the record — and it has to prove
// the session really is gone before that record goes.
test('a workspace whose session is already gone can be removed, and the claim is proven', async t => {
  const f = fixture(t); const api = await load();
  const store = JSON.parse(readFileSync(join(f.root, 'harness/storages/workspace.json'), 'utf8'));
  store.tables.workspaces.w1.sessionIds = ['gone-session'];
  const bytes = Buffer.from(JSON.stringify(store));
  writeFileSync(join(f.root, 'harness/storages/workspace.json'), bytes);
  rmSync(join(f.root, f.file), { force: true });
  const claim = { operation: 'archive', workspaceHash: hash(bytes), workspaceIds: ['w1'], sessionIds: [], absentSessionIds: ['gone-session'], artifacts: [] };

  // A live session named as absent would drop its workspace and leave the
  // artifact behind, so the claim is checked against the session store.
  const liveArtifact = join(f.root, 'harness/sessions/project/gone-session/session.jsonl');
  mkdirSync(join(f.root, 'harness/sessions/project/gone-session'), { recursive: true });
  writeFileSync(liveArtifact, 'still here\n');
  await assert.rejects(api.archiveHistory({ crewRoot: f.root, request: claim, assertStopped: () => true }), /CHANGED/);
  rmSync(liveArtifact, { force: true });

  const result = await api.archiveHistory({ crewRoot: f.root, request: claim, assertStopped: () => true });
  assert.equal(result.counts.workspaces, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'harness/storages/workspace.json'), 'utf8')).global.workspaceIds, []);
  await api.restoreHistory({ crewRoot: f.root, archiveId: result.id, assertStopped: () => true });
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'harness/storages/workspace.json'), 'utf8')), store,
    'the record comes back exactly, with the gone child still named');
});

test('an absent-session claim that overlaps the deletions it is not is rejected', async t => {
  const f = fixture(t); const api = await load();
  const overlapping = { ...f.request, sessionIds: ['session-a'], absentSessionIds: ['session-a'] };
  await assert.rejects(api.archiveHistory({ crewRoot: f.root, request: overlapping, assertStopped: () => true }), /INVALID_SELECTION/);
  const misdeclared = { ...f.request, absentSessionIds: ['session-a'] };
  await assert.rejects(api.archiveHistory({ crewRoot: f.root, request: misdeclared, assertStopped: () => true }), /INVALID_SELECTION/,
    'a session cannot be both deleted and declared already gone');
});

test('restore fails without overwriting a new conflicting log', async t => {
  const f = fixture(t); const api = await load();
  const archived = await api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => true });
  writeFileSync(join(f.root, f.file), 'new data');
  await assert.rejects(api.restoreHistory({ crewRoot: f.root, archiveId: archived.id, assertStopped: () => true }), /CONFLICT/);
  assert.equal(readFileSync(join(f.root, f.file), 'utf8'), 'new data');
});

test('restore preserves unrelated workspaces created after the archive', async t => {
  const f = fixture(t); const api = await load();
  const archived = await api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => true });
  const next = JSON.parse(readFileSync(join(f.root, 'harness/storages/workspace.json')));
  next.tables.workspaces.w2 = { ...f.workspace.tables.workspaces.w1, path: '/new/project', sessionIds: [] };
  next.global.workspaceIds.push('w2');
  writeFileSync(join(f.root, 'harness/storages/workspace.json'), JSON.stringify(next));
  await api.restoreHistory({ crewRoot: f.root, archiveId: archived.id, assertStopped: () => true });
  const restored = JSON.parse(readFileSync(join(f.root, 'harness/storages/workspace.json')));
  assert.deepEqual(restored.tables.workspaces.w2, next.tables.workspaces.w2);
  assert.ok(restored.global.workspaceIds.includes('w1'));
});

test('restore never resurrects an unrelated workspace order entry removed afterwards', async t => {
  const f = fixture(t); const api = await load();
  f.workspace.tables.workspaces.w2 = { ...f.workspace.tables.workspaces.w1, path: '/other', sessionIds: [] };
  f.workspace.global.workspaceIds.push('w2');
  const bytes = JSON.stringify(f.workspace);
  writeFileSync(join(f.root, 'harness/storages/workspace.json'), bytes); f.request.workspaceHash = hash(bytes);
  const archived = await api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => true });
  const current = JSON.parse(readFileSync(join(f.root, 'harness/storages/workspace.json')));
  delete current.tables.workspaces.w2; current.global.workspaceIds = [];
  writeFileSync(join(f.root, 'harness/storages/workspace.json'), JSON.stringify(current));
  await api.restoreHistory({ crewRoot: f.root, archiveId: archived.id, assertStopped: () => true });
  const restored = JSON.parse(readFileSync(join(f.root, 'harness/storages/workspace.json')));
  assert.deepEqual(restored.global.workspaceIds, ['w1']);
  assert.equal(restored.tables.workspaces.w2, undefined);
});

test('a linked ancestor cannot redirect an otherwise regular Crew root', async t => {
  const f = fixture(t); const api = await load();
  const alias = `${f.root}-alias`;
  symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rmSync(alias, { force: true, recursive: true }));
  mkdirSync(join(f.root, 'nested'));
  await assert.rejects(api.archiveHistory({ crewRoot: join(alias, 'nested'), request: f.request, assertStopped: () => true }), /LINK/);
});

test('symlinked storage is rejected instead of following it', async t => {
  const f = fixture(t); const api = await load();
  const outside = mkdtempSync(join(tmpdir(), 'crew-history-outside-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(outside, 'session-a'));
  rmSync(join(f.root, 'harness/sessions/project'), { recursive: true });
  symlinkSync(outside, join(f.root, 'harness/sessions/project'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => true }), /LINK/);
});

test('interrupted apply can roll back with an exact stopped lease and never overwrites conflicts', async t => {
  const f = fixture(t); const api = await load();
  const archived = await api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => true });
  const manifestPath = join(f.root, `history/transactions/${archived.id}/manifest.json`);
  const manifest = JSON.parse(readFileSync(manifestPath)); manifest.state = 'APPLYING';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const result = await api.recoverHistory({ crewRoot: f.root, archiveId: archived.id, assertStopped: () => true });
  assert.equal(result.state, 'ROLLED_BACK');
  assert.equal(readFileSync(join(f.root, f.file), 'utf8'), 'private conversation\n');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'harness/storages/workspace.json'))), f.workspace);
});

test('permanent deletion discards rollback copies only after verified restart and cannot be restored', async t => {
  const f = fixture(t); const api = await load();
  const archived = await api.archiveHistory({ crewRoot: f.root, request: { ...f.request, operation: 'delete' }, assertStopped: () => true });
  await assert.rejects(api.finalizeHistoryDeletion({ crewRoot: f.root, archiveId: archived.id, assertRestarted: () => false }));
  assert.equal(existsSync(join(f.root, `history/transactions/${archived.id}/files/0.bin`)), true);
  await api.finalizeHistoryDeletion({ crewRoot: f.root, archiveId: archived.id, assertRestarted: () => true });
  assert.equal(existsSync(join(f.root, `history/transactions/${archived.id}/files/0.bin`)), false);
  await assert.rejects(api.restoreHistory({ crewRoot: f.root, archiveId: archived.id, assertStopped: () => true }));
  assert.equal((await api.finalizeHistoryDeletion({ crewRoot: f.root, archiveId: archived.id, assertRestarted: () => true })).state, 'DELETED');
  await assert.rejects(api.recoverHistory({ crewRoot: f.root, archiveId: archived.id, assertStopped: () => true }));
});

test('failure after backup preparation rolls back without removing original data', async t => {
  const f = fixture(t); const api = await load(); let checks = 0; let archiveId;
  await assert.rejects(api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => ++checks === 1 }), error => {
    archiveId = error.archiveId; return /NOT_STOPPED/.test(error.message);
  });
  assert.ok(archiveId);
  const result = await api.recoverHistory({ crewRoot: f.root, archiveId, assertStopped: () => true });
  assert.equal(result.state, 'ROLLED_BACK');
  assert.equal((await api.recoverHistory({ crewRoot: f.root, archiveId, assertStopped: () => true })).state, 'ROLLED_BACK');
  assert.equal(readFileSync(join(f.root, f.file), 'utf8'), 'private conversation\n');
});

test('partial restore recovery returns to the archived state', async t => {
  const f = fixture(t); const api = await load();
  const archived = await api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => true });
  const path = join(f.root, `history/transactions/${archived.id}/manifest.json`);
  const manifest = JSON.parse(readFileSync(path));
  manifest.state = 'RESTORING'; manifest.restoreBefore = manifest.after; manifest.restoreAfter = manifest.before;
  writeFileSync(path, JSON.stringify(manifest));
  writeFileSync(join(f.root, f.file), 'private conversation\n');
  await api.recoverHistory({ crewRoot: f.root, archiveId: archived.id, assertStopped: () => true });
  assert.equal(existsSync(join(f.root, f.file)), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'harness/storages/workspace.json'))), manifest.after);
});

test('invalid requests and corrupted archives fail before touching source data', async t => {
  const f = fixture(t); const api = await load();
  for (const patch of [{ operation: 'bad' }, { sessionIds: ['session-a', 'session-a'] }, { workspaceIds: ['../project'] },
    { workspaceIds: ['missing'] }, { artifacts: [] }, { artifacts: [{ ...f.request.artifacts[0], sha256: 'bad' }] }]) {
    await assert.rejects(api.archiveHistory({ crewRoot: f.root, request: { ...f.request, ...patch }, assertStopped: () => true }));
  }
  await assert.rejects(api.restoreHistory({ crewRoot: f.root, archiveId: '../escape', assertStopped: () => true }));
  const archived = await api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => true });
  writeFileSync(join(f.root, `history/transactions/${archived.id}/files/0.bin`), 'tampered');
  await assert.rejects(api.restoreHistory({ crewRoot: f.root, archiveId: archived.id, assertStopped: () => true }), /BACKUP_CHANGED/);
  assert.equal(existsSync(join(f.root, f.file)), false);
});

test('restore rechecks workspace bytes after the final asynchronous stopped proof', async t => {
  const f = fixture(t); const api = await load();
  const archived = await api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => true });
  let checks = 0;
  await assert.rejects(api.restoreHistory({ crewRoot: f.root, archiveId: archived.id, assertStopped: () => {
    if (++checks === 2) {
      const current = JSON.parse(readFileSync(join(f.root, 'harness/storages/workspace.json')));
      current.tables.workspaces.new = { ...f.workspace.tables.workspaces.w1, path: '/changed', sessionIds: [] }; current.global.workspaceIds.push('new');
      writeFileSync(join(f.root, 'harness/storages/workspace.json'), JSON.stringify(current));
    }
    return true;
  } }), /CONFLICT/);
  assert.equal(existsSync(join(f.root, f.file)), false);
});

test('malformed duplicate artifact manifests are rejected before restore publication', async t => {
  const f = fixture(t); const api = await load();
  const archived = await api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => true });
  const path = join(f.root, `history/transactions/${archived.id}/manifest.json`);
  const manifest = JSON.parse(readFileSync(path)); manifest.files.push(manifest.files[0]);
  writeFileSync(path, JSON.stringify(manifest));
  await assert.rejects(api.restoreHistory({ crewRoot: f.root, archiveId: archived.id, assertStopped: () => true }), /INVALID_MANIFEST/);
  assert.equal(existsSync(join(f.root, f.file)), false);
});

// The store this module walks and the store the reviewer evidence pointer names
// are the same directory, so both now read one literal. If they ever drift the
// failure is silent in both directions: a missing-session claim would go
// unproven against the wrong tree, or the reviewer would be handed a path that
// does not exist. This pins the two together.
test('the session store path and the artifact pattern share one source', async t => {
  const api = await load();
  const paths = await import('../src/install/crew-paths.mjs');

  assert.equal(paths.CREW_SESSIONS_REL, 'harness/sessions');
  const home = mkdtempSync(join(tmpdir(), 'crew-paths-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(
    paths.crewHarnessSessionsDir({ home }),
    join(home, '.config', 'dsh-crew', 'harness', 'sessions'),
  );

  // The literal has to be POSIX with exactly two segments: `pathInside` rejects a
  // relative path containing a backslash, and the artifact pattern is matched
  // against archive-relative paths. A backslash would land inside a segment here.
  assert.deepEqual(paths.CREW_SESSIONS_REL.split('/'), ['harness', 'sessions']);

  // Pins the wiring, not just agreement. Provenance is not provable from here —
  // a hand-written identical literal would satisfy this too — which is why the
  // literal value is pinned above as well. What this catches is the drift that
  // matters: move the store and the artifact filter moves with it.
  assert.ok(
    api.SESSION_ARTIFACT_PATTERN.source.replace(/\\\//g, '/').startsWith(`^${paths.CREW_SESSIONS_REL}/`),
    'the pattern must be compiled from CREW_SESSIONS_REL',
  );

  const artifact = `${paths.CREW_SESSIONS_REL}/project/session-a/session.jsonl`;
  assert.ok(api.SESSION_ARTIFACT_PATTERN.test(artifact));
  assert.ok(api.SESSION_ARTIFACT_PATTERN.test(`${paths.CREW_SESSIONS_REL}/project/session-a/session.v3.jsonl.zstd`));
  assert.equal(api.isSessionArtifactPath(artifact, 'session-a'), true);

  // ...and it still rejects a session artifact rooted anywhere else.
  assert.equal(api.SESSION_ARTIFACT_PATTERN.test('elsewhere/sessions/project/session-a/session.jsonl'), false);
  assert.equal(api.SESSION_ARTIFACT_PATTERN.test('harness/sessions/project/session-a/session.v0.jsonl'), false);
  assert.equal(api.SESSION_ARTIFACT_PATTERN.test('harness/sessions/project/session-a/session.jsonl.bak'), false);
});
