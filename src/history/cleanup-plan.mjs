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

/**
 * Pure preview only. No filesystem or project-path operations are performed.
 *
 * `scope` defaults to `crew`: a caller that forgets to narrow the range gets the
 * one range that cannot remove sessions the operator opened themselves. Widening
 * to `all` is always an explicit choice.
 */
export function planHistoryCleanup(snapshot, { operation = 'archive', scope = 'crew', before } = {}) {
  if (!['archive', 'delete'].includes(operation) || !['all', 'crew', 'worktree', 'before'].includes(scope)) throw new Error('HISTORY_INVALID_OPTIONS');
  const cutoff = scope === 'before' ? instant(before) : null;
  if (scope === 'before' && (typeof before !== 'string' || cutoff === null)) throw new Error('HISTORY_INVALID_CUTOFF');
  const workspaces = records(snapshot.workspaces);
  const sessions = records(snapshot.sessions);
  const active = ids(snapshot.activeSessionIds);
  // `crew` and `worktree` narrow by provenance, never by project path: a session
  // is Crew's own only when Crew recorded creating it, and worktree scope adds
  // the isolated-workspace marker the hub stamps at dispatch.
  const origin = new Set(Array.isArray(snapshot.crewSessionIds) ? snapshot.crewSessionIds : []);
  const admitted = (row) => {
    if (scope === 'crew') return origin.has(row.id);
    if (scope === 'worktree') return origin.has(row.id) && row.worktree === true;
    return true;
  };
  const withinTime = (row) => cutoff === null
    || (instant(row.createdAt) !== null && instant(row.createdAt) < cutoff);
  const selected = new Set(sessions.filter(row => admitted(row) && withinTime(row)).map(row => row.id));
  // A workspace carries no provenance of its own: it follows its sessions, and
  // only when every one of them is selected. Checking `admitted(row)` here would
  // test a workspace id against a session ledger and always fail. A provenance
  // scope additionally requires at least one selected child — an empty workspace
  // holds no Crew work, so it is not Crew's to remove; `all` keeps its historical
  // behaviour of following an empty workspace.
  const requiresOwnedChild = scope === 'crew' || scope === 'worktree';
  const workspaceIds = workspaces.filter(row => {
    const children = ids(row.sessionIds);
    return withinTime(row) && (!requiresOwnedChild || children.length > 0)
      && children.every(id => selected.has(id));
  }).map(row => row.id).sort();
  const sessionIds = [...selected].sort();
  const signature = {
    operation, scope, cutoff,
    workspaces: workspaces.map(row => ({ id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt, sessionIds: ids(row.sessionIds) })),
    sessions: sessions.map(row => ({ id: row.id, createdAt: row.createdAt, revision: row.revision })),
    active,
    crewSessionIds: [...origin].sort(),
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
