import { existsSync } from 'node:fs';
import { archiveHistory, restoreHistory, recoverHistory, finalizeHistoryDeletion, readHistoryManifest,
  historyPath, readHistoryBytes, historyHash, decodeWorkspaceStore } from './archive-store.mjs';
import { readHistoryState, writeHistoryState, TERMINAL_HISTORY_PHASES } from './state.mjs';
import { safeHistoryError } from './service.mjs';

function verifyDisk(root, manifest) {
  const restored = manifest.state === 'RESTORED';
  const rolledBack = manifest.state === 'ROLLED_BACK';
  if (!['APPLIED', 'RESTORED', 'ROLLED_BACK', 'DELETING', 'DELETED'].includes(manifest.state)) throw Error('HISTORY_DISK_NOT_VERIFIED');
  const expected = restored ? manifest.restoreAfter : rolledBack ? manifest.before : manifest.after;
  const current = decodeWorkspaceStore(readHistoryBytes(historyPath(root, 'harness/storages/workspace.json')));
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw Error('HISTORY_DISK_NOT_VERIFIED');
  for (const file of manifest.files) {
    const path = historyPath(root, file.relativePath);
    if (restored || rolledBack) {
      if (!existsSync(path) || historyHash(readHistoryBytes(path)) !== file.sha256) throw Error('HISTORY_DISK_NOT_VERIFIED');
    } else if (existsSync(path)) throw Error('HISTORY_DISK_NOT_VERIFIED');
  }
}

/** Detached executor core; injected boundaries make the real transaction testable. */
export async function runHistoryOperation({ crewRoot, id, acquire, release, supervisor, checkFence,
  assertStopped, verifyRunning, recover = false }) {
  let state = readHistoryState(crewRoot);
  if (!state || state.id !== id) throw Error('HISTORY_OPERATION_CHANGED');
  if (TERMINAL_HISTORY_PHASES.includes(state.phase)) return state;
  if (!recover && state.phase !== 'QUEUED') throw Error('HISTORY_RECOVERY_REQUIRED');
  const lock = await acquire();
  if (!lock?.ok) throw Error('HISTORY_UPDATE_BUSY');
  const originalPhase = state.phase === 'RECOVERY_REQUIRED' ? state.resumePhase : state.phase;
  const save = phase => { state = { ...state, phase, code: undefined }; writeHistoryState(crewRoot, state); };
  let result;
  let ownsState = false;
  try {
    const currentState = readHistoryState(crewRoot);
    if (currentState?.id !== state.id || currentState.phase !== state.phase) throw Error('HISTORY_OPERATION_CHANGED');
    ownsState = true;
    if (recover && originalPhase === 'QUEUED') {
      state.code = 'HISTORY_CANCELLED_BEFORE_STOP';
      state.phase = 'FAILED'; writeHistoryState(crewRoot, state);
      return state;
    }
    // A process may have died after a successful restart but before finalization.
    const alreadyStarted = recover && ['STARTING', 'VERIFYING'].includes(originalPhase) && await verifyRunning(state);
    if (!alreadyStarted) {
      if (!recover || await assertStopped(state) !== true) await checkFence(state);
      save('STOPPING');
      const stopped = await supervisor.stopOwnedBackend({ lease: state.lease, runtimeId: state.runtimeId });
      if (!stopped?.ok || await assertStopped(state) !== true) throw Error('HISTORY_STOP_NOT_VERIFIED');
      const archiveId = state.operation === 'restore' ? state.archiveId : state.id;
      const manifestFile = historyPath(crewRoot, `history/transactions/${archiveId}/manifest.json`);
      save('APPLYING');
      const m = existsSync(manifestFile) ? readHistoryManifest(crewRoot, archiveId) : null;
      if (recover && m && ['PREPARING', 'PREPARED', 'APPLYING', 'RESTORING'].includes(m.state)) {
        result = await recoverHistory({ crewRoot, archiveId, assertStopped: () => assertStopped(state) });
        state.rolledBack = true;
      } else if (recover && m && ((state.operation !== 'restore' && ['APPLIED', 'DELETING', 'DELETED', 'ROLLED_BACK'].includes(m.state)) || m.state === 'RESTORED')) {
        result = { id: archiveId, state: m.state };
        state.rolledBack = m.state === 'ROLLED_BACK';
      } else if (state.operation === 'restore') {
        result = await restoreHistory({ crewRoot, archiveId, assertStopped: () => assertStopped(state) });
      } else {
        result = await archiveHistory({ crewRoot, archiveId, request: state.request, assertStopped: () => assertStopped(state) });
      }
      state.archiveId = result.id;
      const manifest = readHistoryManifest(crewRoot, result.id);
      // Recovery of a half-restored archive leaves the original archived state.
      verifyDisk(crewRoot, manifest);
      save('STARTING');
      const started = await supervisor.startOwnedBackend({ lease: state.lease, runtimeId: state.runtimeId });
      if (!started?.ok) throw Error('HISTORY_RESTART_NOT_VERIFIED');
    }
    save('VERIFYING');
    if (await verifyRunning(state) !== true) throw Error('HISTORY_RESTART_NOT_VERIFIED');
    if (state.operation === 'delete' && !state.rolledBack) {
      await finalizeHistoryDeletion({ crewRoot, archiveId: state.archiveId ?? state.id, assertRestarted: () => verifyRunning(state) });
    }
    save(state.rolledBack ? 'ROLLED_BACK' : 'DONE');
    return state;
  } catch (error) {
    state = { ...state, phase: 'RECOVERY_REQUIRED', resumePhase: state.phase, code: safeHistoryError(error) };
    if (ownsState) writeHistoryState(crewRoot, state);
    throw error;
  } finally { await release(lock); }
}
