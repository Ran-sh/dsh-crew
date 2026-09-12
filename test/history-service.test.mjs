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
  // The default provenance source is the machine-global ledger, and the plan
  // revision hashes its whole contents — so a test that reads the operator's real
  // ledger gets a revision any other process can change underneath it. That was
  // an intermittent HISTORY_PREVIEW_CHANGED under parallel CI load, in two
  // different tests of this file. The fixture owns this input like it already
  // owns the store and the clock.
  const service = createHistoryService({ crewRoot: root, agents, persistence, runtimeId: 'test-runtime', launch: async id => launched.push(id), now: () => now, readOrigins: () => new Set() });
  t.after(() => service.dispose());
  return { root, file, agents, persistence, service, launched, advance: () => { now += 700000; } };
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
  // A native agent actively driving a turn must fence the cleanup.
  f.agents.list = () => [{ id: 'native-agent', status: 'running' }];
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

test('one corrupt archive is explicitly reported without blocking healthy archive browsing', async t => {
  const f = await fixture(t);
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  mkdirSync(join(f.root, `history/transactions/${id}`), { recursive: true });
  writeFileSync(join(f.root, `history/transactions/${id}/manifest.json`), 'broken');
  const archives = f.service.archives();
  assert.equal(archives.length, 1); assert.equal(archives[0].invalid, true);
  assert.equal(archives[0].code, 'HISTORY_INVALID_MANIFEST');
  await assert.rejects(f.service.restore({ archiveId: id, confirm: true }), /NOT_RESTORABLE/);
});

test('recovery of an unstarted request cancels it without stopping a runtime or changing data', async t => {
  const f = await fixture(t); const { runHistoryOperation } = await import('../src/history/operation.mjs');
  const p = await f.service.preview({ scope: 'all' }); const op = await f.service.execute({ planId: p.planId, confirm: true });
  let stops = 0;
  await runHistoryOperation({ crewRoot: f.root, id: op.id, recover: true, acquire: () => ({ ok: true }), release: () => ({ ok: true }),
    supervisor: { stopOwnedBackend: async () => { stops++; return { ok: true }; } } });
  assert.equal(stops, 0); assert.equal(f.service.status().phase, 'FAILED'); assert.equal(existsSync(f.file), true);
});

test('a legacy plain log is resolved from the official locator directory, but ambiguous encodings reject', async t => {
  const f = await fixture(t); f.persistence.locate = () => ({ kind: 'jsonl', path: `${f.file}.zstd` });
  assert.equal((await f.service.preview({ scope: 'all' })).counts.sessions, 1);
  writeFileSync(`${f.file}.zstd`, 'conflicting encoding');
  await assert.rejects(f.service.preview({ scope: 'all' }), /AMBIGUOUS/);
});

test('recovery with a proven stopped lease does not query the offline live API', async t => {
  const f = await fixture(t); const { runHistoryOperation } = await import('../src/history/operation.mjs');
  const { readHistoryState, writeHistoryState } = await import('../src/history/state.mjs');
  const p = await f.service.preview({ scope: 'all' }); const op = await f.service.execute({ planId: p.planId, confirm: true });
  writeHistoryState(f.root, { ...readHistoryState(f.root), phase: 'STOPPING' });
  let liveCalls = 0; let stopped = true;
  await runHistoryOperation({ crewRoot: f.root, id: op.id, recover: true, acquire: () => ({ ok: true }), release: () => ({ ok: true }),
    assertStopped: () => stopped, checkFence: () => { liveCalls++; throw Error('offline'); },
    supervisor: { stopOwnedBackend: async () => ({ ok: true }), startOwnedBackend: async () => { stopped = false; return { ok: true }; } }, verifyRunning: async () => !stopped });
  assert.equal(liveCalls, 0); assert.equal(f.service.status().phase, 'DONE');
});

test('a stale executor never overwrites a later operation state after acquiring its lock', async t => {
  const f = await fixture(t); const { runHistoryOperation } = await import('../src/history/operation.mjs');
  const { readHistoryState, writeHistoryState } = await import('../src/history/state.mjs');
  const p = await f.service.preview({ scope: 'all' }); const op = await f.service.execute({ planId: p.planId, confirm: true });
  const nextId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  await assert.rejects(runHistoryOperation({ crewRoot: f.root, id: op.id, acquire: () => { writeHistoryState(f.root, { ...readHistoryState(f.root), id: nextId }); return { ok: true }; }, release: () => ({ ok: true }) }), /CHANGED/);
  assert.equal(readHistoryState(f.root).id, nextId);
});

// The 0.1.5 jsonl backend resolves each session's current immutable generation
// itself and reports the artifact path through `listArtifacts()`, and it no
// longer declares `supportsRawArtifacts`. The inventory must read that surface,
// or the whole cleanup feature stays UNSUPPORTED on the current cohort.
test('a 0.1.5-style backend is read through listArtifacts without the raw flag', async t => {
  const f = await fixture(t);
  delete f.persistence.listSnapshots;
  delete f.persistence.supportsRawArtifacts;
  f.persistence.listArtifacts = async () => existsSync(f.file)
    ? [{ header: { id: 'session-a', createdAt: 1767225600000 }, path: f.file }]
    : [];
  const p = await f.service.preview({ scope: 'all' });
  assert.equal(p.counts.sessions, 1);
  assert.equal(p.counts.workspaces, 1);
});

// Format version 3 names the artifact `session.v3.jsonl`; version 0 keeps the
// original `session.jsonl`. Both are canonical generations of the same session.
test('a versioned generation artifact is archived alongside the legacy name', async t => {
  const f = await fixture(t);
  const versioned = join(f.root, 'harness/sessions/example/session-a/session.v3.jsonl.zstd');
  rmSync(f.file);
  writeFileSync(versioned, 'test conversation');
  delete f.persistence.listSnapshots;
  f.persistence.listArtifacts = async () => [
    { header: { id: 'session-a', createdAt: 1767225600000 }, path: versioned },
  ];
  const p = await f.service.preview({ scope: 'all' });
  assert.equal(p.counts.sessions, 1, 'a vN generation must be a valid archive source');
});

// A backend that refuses raw artifacts outright is still a hard refusal.
test('a backend that declares no raw artifacts stays unsupported', async t => {
  const f = await fixture(t);
  f.persistence.supportsRawArtifacts = false;
  await assert.rejects(f.service.preview({ scope: 'all' }), /HISTORY_STORAGE_UNSUPPORTED/);
});

test('a newer fork protects its selected older parent and workspace from cleanup', async t => {
  const f = await fixture(t);
  const childFile = join(f.root, 'harness/sessions/example/session-child/session.jsonl');
  mkdirSync(join(f.root, 'harness/sessions/example/session-child')); writeFileSync(childFile, 'child');
  f.persistence.listSnapshots = async () => [
    { header: { id: 'session-a', createdAt: 1767225600000 }, revision: 'old' },
    { header: { id: 'session-child', createdAt: 1788220800000, parentSession: 'session-a' }, revision: 'new' },
  ];
  f.persistence.locate = header => ({ kind: 'jsonl', path: header.id === 'session-a' ? f.file : childFile });
  const p = await f.service.preview({ scope: 'before', before: '2026-08-01T00:00:00Z' });
  assert.equal(p.counts.sessions, 0); assert.equal(p.executable, false); assert.equal(p.counts.workspaces, 0);
});

test('recovery finishes deletion after a late successful restart without another stop', async t => {
  const f = await fixture(t); const { runHistoryOperation } = await import('../src/history/operation.mjs');
  const p = await f.service.preview({ operation: 'delete', scope: 'all' }); const op = await f.service.execute({ planId: p.planId, confirm: true, acknowledgement: 'DELETE' });
  const deps = { crewRoot: f.root, id: op.id, acquire: () => ({ ok: true }), release: () => ({ ok: true }), checkFence: () => f.service.fencedCheck(), assertStopped: () => true,
    supervisor: { stopOwnedBackend: async () => ({ ok: true }), startOwnedBackend: async () => ({ ok: false }) }, verifyRunning: async () => false };
  await assert.rejects(runHistoryOperation(deps));
  let stops = 0;
  await runHistoryOperation({ ...deps, recover: true, verifyRunning: async () => true, supervisor: { stopOwnedBackend: async () => { stops++; throw Error('unexpected stop'); } } });
  assert.equal(stops, 0); assert.equal(f.service.status().phase, 'DONE');
  assert.equal(existsSync(join(f.root, `history/transactions/${op.id}/files/0.bin`)), false);
});
