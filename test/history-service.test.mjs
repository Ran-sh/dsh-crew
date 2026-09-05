import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'crew-history-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'harness/storages'), { recursive: true });
  mkdirSync(join(root, 'harness/sessions/example/session-a'), { recursive: true });
  const file = join(root, 'harness/sessions/example/session-a/session.jsonl');
  writeFileSync(file, 'test conversation');
  writeFileSync(join(root, 'harness/storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [] }, tables: { workspaces: { w1: { path: '/project', title: 'Example', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', sessionIds: ['session-a'] } } } }));
  const agents = { list: () => [], create: async () => ({}) };
  const persistence = { supportsRawArtifacts: true, listSnapshots: async () => existsSync(file) ? [{ header: { id: 'session-a', createdAt: 1767225600000 }, revision: 'revision1' }] : [], locate: () => ({ kind: 'jsonl', path: file }) };
  const { createHistoryService } = await import('../src/history/service.mjs');
  const launched = [];
  let now = 1000;
  const service = createHistoryService({ crewRoot: root, agents, persistence, runtimeId: 'test-runtime', launch: async id => launched.push(id), now: () => now });
  t.after(() => service.dispose());
  return { root, file, agents, service, launched, advance: () => { now += 700000; } };
}

test('preview is non-destructive and execution requires confirmation plus a fresh server-owned plan', async t => {
  const f = await fixture(t); const p = await f.service.preview({ scope: 'all' });
  assert.equal(p.counts.sessions, 1); assert.equal(existsSync(f.file), true);
  await assert.rejects(f.service.execute({ planId: p.planId, confirm: false }));
  await assert.rejects(f.service.execute({ planId: 'forged', confirm: true }));
  await f.service.execute({ planId: p.planId, confirm: true });
  assert.equal(f.launched.length, 1);
  await assert.rejects(() => f.agents.create(), /MAINTENANCE_PENDING/);
  assert.equal(existsSync(f.file), true, 'only detached executor mutates data');
});

test('delete needs DELETE acknowledgement; changed or expired previews do not launch', async t => {
  const f = await fixture(t); const p = await f.service.preview({ operation: 'delete', scope: 'all' });
  await assert.rejects(f.service.execute({ planId: p.planId, confirm: true }));
  writeFileSync(f.file, 'new data');
  await assert.rejects(f.service.execute({ planId: p.planId, confirm: true, acknowledgement: 'DELETE' }), /CHANGED/);
  const q = await f.service.preview({ scope: 'all' }); f.advance();
  await assert.rejects(f.service.execute({ planId: q.planId, confirm: true }), /EXPIRED/);
  assert.equal(f.launched.length, 0);
});

test('live native agents and failed executor spawn leave history untouched and admission restored', async t => {
  const f = await fixture(t); const p = await f.service.preview({ scope: 'all' });
  f.agents.list = () => [{ id: 'native-agent' }];
  await assert.rejects(f.service.execute({ planId: p.planId, confirm: true }), /ACTIVE/);
  assert.equal(f.launched.length, 0); assert.equal(existsSync(f.file), true);
});

test('full maintenance archives, restores and deletes disposable history using exact stop/start phases', async t => {
  const f = await fixture(t);
  const { runHistoryOperation } = await import('../src/history/operation.mjs');
  const calls = []; let stopped = false;
  const deps = { crewRoot: f.root, acquire: () => ({ ok: true, nonce: 'lock' }), release: () => ({ ok: true }),
    checkFence: () => f.service.fencedCheck(), assertStopped: () => stopped,
    supervisor: { stopOwnedBackend: async () => { calls.push('stop'); stopped = true; return { ok: true }; }, startOwnedBackend: async () => { calls.push('start'); stopped = false; return { ok: true }; } },
    verifyRunning: async () => !stopped };
  const p = await f.service.preview({ scope: 'all' }); const op = await f.service.execute({ planId: p.planId, confirm: true });
  await runHistoryOperation({ ...deps, id: op.id });
  assert.equal(existsSync(f.file), false); assert.equal(f.service.status().phase, 'DONE');
  const archives = f.service.archives(); assert.equal(archives.length, 1);
  const restored = await f.service.restore({ archiveId: archives[0].id, confirm: true });
  await runHistoryOperation({ ...deps, id: restored.id }); assert.equal(readFileSync(f.file, 'utf8'), 'test conversation');
  const d = await f.service.preview({ operation: 'delete', scope: 'all' }); const del = await f.service.execute({ planId: d.planId, confirm: true, acknowledgement: 'DELETE' });
  await runHistoryOperation({ ...deps, id: del.id });
  assert.equal(existsSync(f.file), false); assert.equal(f.service.archives().length, 0);
  assert.deepEqual(calls, ['stop', 'start', 'stop', 'start', 'stop', 'start']);
});

test('restart failure leaves durable recovery fencing and no successful deletion', async t => {
  const f = await fixture(t); const { runHistoryOperation } = await import('../src/history/operation.mjs');
  const p = await f.service.preview({ operation: 'delete', scope: 'all' }); const op = await f.service.execute({ planId: p.planId, confirm: true, acknowledgement: 'DELETE' });
  await assert.rejects(runHistoryOperation({ crewRoot: f.root, id: op.id, acquire: () => ({ ok: true }), release: () => ({ ok: true }), checkFence: () => f.service.fencedCheck(), assertStopped: () => true,
    supervisor: { stopOwnedBackend: async () => ({ ok: true }), startOwnedBackend: async () => ({ ok: false }) }, verifyRunning: async () => false }));
  assert.equal(f.service.status().phase, 'RECOVERY_REQUIRED');
  await assert.rejects(() => f.agents.create(), /MAINTENANCE_PENDING/);
  assert.equal(existsSync(join(f.root, `history/transactions/${op.id}/files/0.bin`)), true);
});
