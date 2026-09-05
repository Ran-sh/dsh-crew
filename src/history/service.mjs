import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { planHistoryCleanup } from './cleanup-plan.mjs';
import { installHistoryAdmissionGate } from './admission-gate.mjs';
import { historyHash, historyPath, readHistoryBytes, decodeWorkspaceStore, readHistoryManifest } from './archive-store.mjs';
import { readHistoryState, writeHistoryState, historyPending, publicHistoryState } from './state.mjs';

export function createHistoryService({ crewRoot, agents, persistence, runtimeId, launch, now = Date.now }) {
  const gate = installHistoryAdmissionGate(agents, () => historyPending(crewRoot));
  const plans = new Map();
  let entering = false;
  async function snapshot(options) {
    if (typeof persistence?.listSnapshots !== 'function' || typeof persistence?.locate !== 'function'
      || persistence.supportsRawArtifacts !== true) throw Error('HISTORY_STORAGE_UNSUPPORTED');
    const bytes = readHistoryBytes(historyPath(crewRoot, 'harness/storages/workspace.json'));
    const store = decodeWorkspaceStore(bytes);
    const listed = await persistence.listSnapshots();
    if (!Array.isArray(listed) || listed.length > 10000) throw Error('HISTORY_INVENTORY_TOO_LARGE');
    let total = 0;
    const sessions = listed.map(({ header, revision }) => {
      if (!header || typeof header.id !== 'string') throw Error('HISTORY_INVENTORY_INVALID');
      const location = persistence.locate(header);
      if (location?.kind !== 'jsonl') throw Error('HISTORY_STORAGE_UNSUPPORTED');
      const path = relative(crewRoot, location.path).replaceAll('\\', '/');
      if (!/^harness\/sessions\/[^/]+\/[^/]+\/session\.jsonl(?:\.zstd)?$/.test(path)
        || path.split('/')[3] !== header.id) throw Error('HISTORY_STORAGE_UNSUPPORTED');
      const raw = readHistoryBytes(historyPath(crewRoot, path)); total += raw.length;
      if (total > 512 * 1024 * 1024) throw Error('HISTORY_INVENTORY_TOO_LARGE');
      return { id: header.id, createdAt: header.createdAt, parentSession: header.parentSession,
        revision: JSON.stringify([revision, historyHash(raw)]), artifact: { sessionId: header.id, relativePath: path, sha256: historyHash(raw) } };
    });
    // A retained child keeps its ancestor chain; do not leave a newer fork orphaned.
    const workspaces = Object.entries(store.tables.workspaces).map(([id, row]) => ({ id, ...row }));
    const plan = planHistoryCleanup({ workspaces, sessions, activeSessionIds: gate.idle() ? [] : ['active-agent'] }, options);
    const selected = new Set(plan.sessionIds);
    const byId = new Map(sessions.map(row => [row.id, row]));
    const queue = sessions.filter(row => !selected.has(row.id));
    for (let i = 0; i < queue.length; i++) {
      const parent = byId.get(queue[i].parentSession);
      if (parent && selected.delete(parent.id)) queue.push(parent);
    }
    plan.sessionIds = plan.sessionIds.filter(id => selected.has(id));
    plan.workspaceIds = plan.workspaceIds.filter(id => store.tables.workspaces[id].sessionIds.every(sid => selected.has(sid)));
    plan.counts = { workspaces: plan.workspaceIds.length, sessions: plan.sessionIds.length };
    plan.executable = gate.idle() && plan.counts.workspaces + plan.counts.sessions > 0;
    if (!plan.executable && !plan.blockedReason) plan.blockedReason = 'EMPTY_SELECTION';
    const request = { operation: plan.operation, workspaceHash: historyHash(bytes), workspaceIds: plan.workspaceIds,
      sessionIds: plan.sessionIds, artifacts: sessions.filter(row => selected.has(row.id)).map(row => row.artifact) };
    const revision = historyHash(JSON.stringify([runtimeId, plan.revision, request]));
    return { plan: { ...plan, revision, items: workspaces.filter(row => plan.workspaceIds.includes(row.id)).slice(0, 100).map(row => ({ id: row.id, title: row.title })) }, request };
  }
  async function preview(options = {}) {
    if (historyPending(crewRoot)) throw Error('HISTORY_MAINTENANCE_PENDING');
    const result = await snapshot(options); const planId = randomUUID();
    plans.set(planId, { ...result, options, expiresAt: now() + 600000 });
    while (plans.size > 16) plans.delete(plans.keys().next().value);
    return { ...result.plan, planId, expiresAt: now() + 600000 };
  }
  async function submit(operation, build) {
    if (entering || historyPending(crewRoot)) throw Error('HISTORY_MAINTENANCE_PENDING');
    entering = true;
    let state;
    try {
      state = { schemaVersion: 1, id: randomUUID(), operation, phase: 'QUEUED', lease: randomUUID(), runtimeId };
      writeHistoryState(crewRoot, state); // Fence BEFORE the last idle/snapshot check.
      if (!gate.idle()) throw Error('HISTORY_ACTIVE_SESSIONS');
      Object.assign(state, await build(), { phase: 'QUEUED' });
      writeHistoryState(crewRoot, state);
      await launch(state.id);
      return publicHistoryState(state);
    } catch (error) {
      if (state) writeHistoryState(crewRoot, { ...state, phase: 'FAILED', code: safeHistoryError(error) });
      throw error;
    } finally { entering = false; }
  }
  async function execute({ planId, confirm, acknowledgement } = {}) {
    const saved = plans.get(planId);
    if (!saved || saved.expiresAt < now()) throw Error('HISTORY_PLAN_EXPIRED');
    if (confirm !== true || (saved.plan.operation === 'delete' && acknowledgement !== 'DELETE')) throw Error('HISTORY_CONFIRMATION_REQUIRED');
    return submit(saved.plan.operation, async () => {
      const fresh = await snapshot(saved.options);
      if (fresh.plan.revision !== saved.plan.revision) throw Error('HISTORY_PREVIEW_CHANGED');
      if (!fresh.plan.executable) throw Error('HISTORY_EMPTY_SELECTION');
      plans.delete(planId);
      return { request: fresh.request, options: saved.options, revision: fresh.plan.revision, counts: fresh.plan.counts };
    });
  }
  function archives() {
    const directory = historyPath(crewRoot, 'history/transactions');
    if (!existsSync(directory)) return [];
    const ids = readdirSync(directory).filter(id => /^[a-f0-9-]{36}$/.test(id));
    if (ids.length > 10000) throw Error('HISTORY_ARCHIVE_LIMIT');
    return ids.map(id => readHistoryManifest(crewRoot, id)).filter(m => m.operation === 'archive' && m.state === 'APPLIED')
      .map(m => ({ id: m.id, createdAt: m.createdAt, sessions: m.files.length,
        workspaces: m.before.global.workspaceIds.filter(id => !m.after.global.workspaceIds.includes(id)).length })).reverse();
  }
  async function restore({ archiveId, confirm } = {}) {
    if (confirm !== true) throw Error('HISTORY_CONFIRMATION_REQUIRED');
    return submit('restore', async () => {
      const archive = archives().find(a => a.id === archiveId);
      if (!archive) throw Error('HISTORY_ARCHIVE_NOT_RESTORABLE');
      return { archiveId, counts: { sessions: archive.sessions, workspaces: archive.workspaces } };
    });
  }
  async function fencedCheck() {
    const state = readHistoryState(crewRoot);
    if (!state || !historyPending(crewRoot) || state.runtimeId !== runtimeId || !gate.idle()) throw Error('HISTORY_FENCE_NOT_IDLE');
    if (state.operation !== 'restore') {
      const fresh = await snapshot(state.options);
      if (fresh.plan.revision !== state.revision) throw Error('HISTORY_PREVIEW_CHANGED');
    }
    return true;
  }
  async function recover({ confirm } = {}) {
    const state = readHistoryState(crewRoot);
    if (confirm !== true) throw Error('HISTORY_CONFIRMATION_REQUIRED');
    if (!state || !historyPending(crewRoot)) throw Error('HISTORY_RECOVERY_UNAVAILABLE');
    await launch(state.id, true);
    return publicHistoryState(state);
  }
  return { preview, execute, restore, recover, archives, fencedCheck, status: () => publicHistoryState(readHistoryState(crewRoot)), dispose: () => gate.dispose() };
}
export function safeHistoryError(error) {
  return /^HISTORY_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'HISTORY_OPERATION_FAILED';
}
