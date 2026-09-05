import { existsSync } from 'node:fs';
import { historyPath, readHistoryBytes, writeHistoryBytes } from './archive-store.mjs';

export const TERMINAL_HISTORY_PHASES = ['DONE', 'FAILED', 'ROLLED_BACK'];
const phases = ['QUEUED', 'STOPPING', 'APPLYING', 'STARTING', 'VERIFYING', 'RECOVERY_REQUIRED', ...TERMINAL_HISTORY_PHASES];
export function readHistoryState(root) {
  const file = historyPath(root, 'history/active.json');
  if (!existsSync(file)) return null;
  let value;
  try { value = JSON.parse(readHistoryBytes(file)); } catch { throw Error('HISTORY_STATE_INVALID'); }
  if (value?.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(value.id) || !phases.includes(value.phase)
    || !['archive', 'delete', 'restore'].includes(value.operation) || typeof value.runtimeId !== 'string'
    || !/^[a-f0-9-]{36}$/.test(value.lease)) throw Error('HISTORY_STATE_INVALID');
  return value;
}
export function writeHistoryState(root, value) {
  writeHistoryBytes(root, 'history/active.json', JSON.stringify({ ...value, updatedAt: Date.now() }));
}
export function historyPending(root) {
  const state = readHistoryState(root);
  return state !== null && !TERMINAL_HISTORY_PHASES.includes(state.phase);
}
export function publicHistoryState(state) {
  if (!state) return { phase: 'IDLE' };
  return { id: state.id, phase: state.phase, operation: state.operation, counts: state.counts,
    archiveId: state.archiveId, code: state.code, updatedAt: state.updatedAt };
}
