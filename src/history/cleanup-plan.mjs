import { createHash } from 'node:crypto';

const MAX_RECORDS = 10_000;

function instant(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(y, m - 1, d);
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function ids(values) {
  if (!Array.isArray(values) || values.length > MAX_RECORDS) throw new Error('HISTORY_INVALID_IDENTITIES');
  if (values.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(id))) throw new Error('HISTORY_INVALID_IDENTITY');
  if (new Set(values).size !== values.length) throw new Error('HISTORY_DUPLICATE_IDENTITY');
  return [...values].sort();
}

function records(values) {
  if (!Array.isArray(values) || values.some(row => !row || typeof row !== 'object')) throw new Error('HISTORY_INVALID_RECORDS');
  ids(values.map(row => row.id));
  return [...values].sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

/** Pure preview only. No filesystem or project-path operations are performed. */
export function planHistoryCleanup(snapshot, { operation = 'archive', scope = 'all', before } = {}) {
  if (!['archive', 'delete'].includes(operation) || !['all', 'before'].includes(scope)) throw new Error('HISTORY_INVALID_OPTIONS');
  const cutoff = scope === 'before' ? instant(before) : null;
  if (scope === 'before' && (typeof before !== 'string' || cutoff === null)) throw new Error('HISTORY_INVALID_CUTOFF');
  const workspaces = records(snapshot.workspaces);
  const sessions = records(snapshot.sessions);
  const active = ids(snapshot.activeSessionIds);
  const selected = new Set(sessions.filter(row => scope === 'all' || (instant(row.createdAt) !== null && instant(row.createdAt) < cutoff)).map(row => row.id));
  const workspaceIds = workspaces.filter(row => {
    const children = ids(row.sessionIds);
    return (scope === 'all' || (instant(row.createdAt) !== null && instant(row.createdAt) < cutoff))
      && children.every(id => selected.has(id));
  }).map(row => row.id).sort();
  const sessionIds = [...selected].sort();
  const signature = {
    operation, scope, cutoff,
    workspaces: workspaces.map(row => ({ id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt, sessionIds: ids(row.sessionIds) })),
    sessions: sessions.map(row => ({ id: row.id, createdAt: row.createdAt, revision: row.revision })),
    active,
  };
  return {
    schemaVersion: 1, operation, scope,
    before: cutoff === null ? null : new Date(cutoff).toISOString(),
    timeBasis: 'createdAt', workspaceIds, sessionIds,
    counts: { workspaces: workspaceIds.length, sessions: sessionIds.length },
    protectedCounts: { workspaces: workspaces.length - workspaceIds.length, sessions: sessions.length - sessionIds.length },
    executable: active.length === 0 && (workspaceIds.length > 0 || sessionIds.length > 0),
    blockedReason: active.length > 0 ? 'ACTIVE_SESSIONS' : workspaceIds.length + sessionIds.length === 0 ? 'EMPTY_SELECTION' : null,
    activeSessionCount: active.length,
    projectFilesAffected: false,
    revision: createHash('sha256').update(JSON.stringify(signature)).digest('hex'),
  };
}
