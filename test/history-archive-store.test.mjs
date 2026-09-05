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

test('symlinked storage is rejected instead of following it', async t => {
  const f = fixture(t); const api = await load();
  const outside = mkdtempSync(join(tmpdir(), 'crew-history-outside-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(outside, 'session-a'));
  rmSync(join(f.root, 'harness/sessions/project'), { recursive: true });
  symlinkSync(outside, join(f.root, 'harness/sessions/project'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.archiveHistory({ crewRoot: f.root, request: f.request, assertStopped: () => true }), /LINK/);
});
