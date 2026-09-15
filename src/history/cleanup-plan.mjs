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
  const present = new Set(sessions.map(row => row.id));
  const worktreeSessions = new Set(sessions.filter(row => row.worktree === true).map(row => row.id));
  const selected = new Set(sessions.filter(row => admitted(row) && withinTime(row)).map(row => row.id));
  // A workspace carries no provenance of its own: it follows its sessions, and
  // only when every one of them is selected. Checking `admitted(row)` here would
  // test a workspace id against a session ledger and always fail. A provenance
  // scope additionally requires at least one child — an empty workspace holds no
  // Crew work, so it is not Crew's to remove; `all` keeps its historical
  // behaviour of following an empty workspace.
  //
  // A child whose artifact is already gone cannot be "selected": there is
  // nothing left to select. Such a child still counts as covered when the ledger
  // recorded Crew creating it, the same evidence that makes a live one Crew's.
  // Without that, a workspace whose sessions were removed by an earlier cleanup
  // became permanently unreachable — every scope demanded its children, and its
  // children no longer existed — which is exactly how 48 dead rows stayed in the
  // store while the operator could only see them.
  const requiresOwnedChild = scope === 'crew' || scope === 'worktree';
  // One decision per workspace, from that row alone: what a row is allowed to
  // remove must never depend on which rows were visited before it.
  const decideWorkspace = (row) => {
    const children = ids(row.sessionIds);
    if (children.length === 0) return { ok: !requiresOwnedChild, absent: [] };
    // Worktree scope marks a live child by its session header. A gone child has
    // no header left, so the workspace's own path under the worktree root is the
    // only marker there is.
    if (scope === 'worktree' && row.worktree !== true && !children.every(id => worktreeSessions.has(id))) return { ok: false, absent: [] };
    const gone = [];
    for (const id of children) {
      if (selected.has(id)) continue;
      // Kept back by the scope, or gone with no record that Crew made it.
      if (present.has(id) || !origin.has(id)) return { ok: false, absent: [] };
      gone.push(id);
    }
    return { ok: true, absent: gone };
  };
  const absent = new Set();
  const workspaceIds = workspaces.filter(row => {
    if (!withinTime(row)) return false;
    const decision = decideWorkspace(row);
    if (!decision.ok) return false;
    for (const id of decision.absent) absent.add(id);
    return true;
  }).map(row => row.id).sort();
  const absentSessionIds = [...absent].sort();
  const sessionIds = [...selected].sort();
  const signature = {
    operation, scope, cutoff,
    workspaces: workspaces.map(row => ({ id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt, sessionIds: ids(row.sessionIds), worktree: row.worktree === true })),
    sessions: sessions.map(row => ({ id: row.id, createdAt: row.createdAt, revision: row.revision, worktree: row.worktree === true })),
    active,
    crewSessionIds: [...origin].sort(),
  };
  return {
    schemaVersion: 1, operation, scope,
    before: cutoff === null ? null : new Date(cutoff).toISOString(),
    timeBasis: 'createdAt', workspaceIds, sessionIds, absentSessionIds,
    counts: { workspaces: workspaceIds.length, sessions: sessionIds.length },
    protectedCounts: { workspaces: workspaces.length - workspaceIds.length, sessions: sessions.length - sessionIds.length },
    executable: active.length === 0 && (workspaceIds.length > 0 || sessionIds.length > 0),
    blockedReason: active.length > 0 ? 'ACTIVE_SESSIONS' : workspaceIds.length + sessionIds.length === 0 ? 'EMPTY_SELECTION' : null,
    activeSessionCount: active.length,
    projectFilesAffected: false,
    revision: createHash('sha256').update(JSON.stringify(signature)).digest('hex'),
  };
}
