import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { planHistoryCleanup } from './cleanup-plan.mjs';
import { installHistoryAdmissionGate } from './admission-gate.mjs';
import { historyHash, historyPath, readHistoryBytes, decodeWorkspaceStore, readHistoryManifest, isSessionArtifactPath } from './archive-store.mjs';
import { readHistoryState, writeHistoryState, historyPending, publicHistoryState } from './state.mjs';
import { readSessionOrigins } from '../session-origins.mjs';
import { defaultWorktreeRoot } from '../workspace-isolation.mjs';

// `readOrigins` is injectable because the provenance ledger it reads by default
// is machine-global, and the plan revision hashes the whole set: anything that
// appends to that file between a preview and its execute invalidates the plan.
// That is correct in production, where the ledger is this machine's own record,
// but a caller that cannot control the ledger cannot control its own revisions.
export function createHistoryService({ crewRoot, agents, persistence, runtimeId, launch, now = Date.now, readOrigins = readSessionOrigins }) {
  const gate = installHistoryAdmissionGate(agents, () => historyPending(crewRoot));
  const plans = new Map();
  let entering = false;
  // One row per materialized session: the header to archive and the artifact
  // location the backend reported. The 0.1.5 jsonl backend resolves each
  // session's current immutable generation itself and hands back a concrete
  // path through `listArtifacts()`. The earlier backend listed snapshots and
  // only hinted at a location, leaving the encoding to be probed below.
  async function readInventory() {
    if (typeof persistence?.listArtifacts === 'function') {
      const artifacts = await persistence.listArtifacts();
      if (!Array.isArray(artifacts)) throw Error('HISTORY_INVENTORY_INVALID');
      return artifacts.map(({ header, path }) => {
        if (typeof path !== 'string') throw Error('HISTORY_STORAGE_UNSUPPORTED');
        return { header, located: path, resolved: true };
      });
    }
    if (typeof persistence?.listSnapshots === 'function') {
      const rows = await persistence.listSnapshots();
      if (!Array.isArray(rows)) throw Error('HISTORY_INVENTORY_INVALID');
      return rows.map(({ header }) => {
        const location = persistence.locate(header);
        if (location?.kind !== 'jsonl') throw Error('HISTORY_STORAGE_UNSUPPORTED');
        return { header, located: location.path, resolved: false };
      });
    }
    throw Error('HISTORY_STORAGE_UNSUPPORTED');
  }
  async function snapshot(options) {
    if (typeof persistence?.locate !== 'function') throw Error('HISTORY_STORAGE_UNSUPPORTED');
    // Refuse only a backend that explicitly declares it exposes no per-session
    // raw artifact. The 0.1.5 backend dropped the flag rather than setting it
    // false, and the artifact path itself is validated below either way.
    if (persistence.supportsRawArtifacts === false) throw Error('HISTORY_STORAGE_UNSUPPORTED');
    const bytes = readHistoryBytes(historyPath(crewRoot, 'harness/storages/workspace.json'));
    const store = decodeWorkspaceStore(bytes);
    const listed = await readInventory();
    if (listed.length > 10000) throw Error('HISTORY_INVENTORY_TOO_LARGE');
    let total = 0;
    const sessions = listed.map(({ header, located, resolved }) => {
      if (!header || typeof header.id !== 'string') throw Error('HISTORY_INVENTORY_INVALID');
      let path = relative(crewRoot, located).replaceAll('\\', '/');
      if (!isSessionArtifactPath(path, header.id)) throw Error('HISTORY_STORAGE_UNSUPPORTED');
      if (!resolved) {
        // An unresolved location is a hint that may not name the encoding that
        // actually exists, so exactly one candidate must be present on disk.
        const plain = path.replace(/\.zstd$/, '');
        const existing = [plain, `${plain}.zstd`].filter(candidate => existsSync(historyPath(crewRoot, candidate)));
        if (existing.length !== 1) throw Error('HISTORY_ARTIFACT_AMBIGUOUS');
        path = existing[0];
      }
      const raw = readHistoryBytes(historyPath(crewRoot, path)); total += raw.length;
      if (total > 512 * 1024 * 1024) throw Error('HISTORY_INVENTORY_TOO_LARGE');
      return { id: header.id, createdAt: header.createdAt, parentSession: header.parentSession, cwd: header.cwd,
        revision: JSON.stringify([header.revision, historyHash(raw)]), artifact: { sessionId: header.id, relativePath: path, sha256: historyHash(raw) } };
    });
    // A retained child keeps its ancestor chain; do not leave a newer fork orphaned.
    const workspaces = Object.entries(store.tables.workspaces).map(([id, row]) => ({ id, ...row }));
    const crewSessionIds = [...readOrigins()];
    const crewSet = new Set(crewSessionIds);
    for (const row of sessions) if (crewSet.has(row.id)) row.crew = true;
    // The isolated-workspace marker: the hub stamps every worktree session with a
    // cwd under the Crew worktree root, so that subset is scopeable on its own.
    const worktreeRoot = defaultWorktreeRoot().replaceAll('\\', '/').toLowerCase();
    for (const row of sessions) {
      if (row.crew === true && typeof row.cwd === 'string' && row.cwd.replaceAll('\\', '/').toLowerCase().startsWith(worktreeRoot)) row.worktree = true;
    }
    const plan = planHistoryCleanup({ workspaces, sessions, crewSessionIds, activeSessionIds: gate.idle() ? [] : ['active-agent'] }, options);
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
    const expiresAt = now() + 600000;
    plans.set(planId, { ...result, options, expiresAt });
    while (plans.size > 16) plans.delete(plans.keys().next().value);
    return { ...result.plan, planId, expiresAt };
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
    return ids.flatMap(id => {
      try {
        const m = readHistoryManifest(crewRoot, id);
        return m.operation === 'archive' && m.state === 'APPLIED' ? [{ id: m.id, createdAt: m.createdAt, sessions: m.files.length,
          workspaces: m.before.global.workspaceIds.filter(id => !m.after.global.workspaceIds.includes(id)).length }] : [];
      } catch {
        return [{ id, invalid: true, code: 'HISTORY_INVALID_MANIFEST', sessions: 0, workspaces: 0, createdAt: null }];
      }
    }).reverse();
  }
  async function restore({ archiveId, confirm } = {}) {
    if (confirm !== true) throw Error('HISTORY_CONFIRMATION_REQUIRED');
    return submit('restore', async () => {
      const archive = archives().find(a => a.id === archiveId && !a.invalid);
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
