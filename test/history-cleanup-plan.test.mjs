import test from 'node:test';
import assert from 'node:assert/strict';

const planner = async () => (await import('../src/history/cleanup-plan.mjs')).planHistoryCleanup;
const old = '2026-01-01T00:00:00.000Z';
const recent = '2026-09-01T00:00:00.000Z';
const snapshot = () => ({
  workspaces: [
    { id: 'old-workspace', createdAt: old, sessionIds: ['old-session'] },
    { id: 'mixed-workspace', createdAt: old, sessionIds: ['old-in-mixed', 'new-session'] },
    { id: 'empty-workspace', createdAt: old, sessionIds: [] },
  ],
  sessions: [
    { id: 'old-session', createdAt: old, revision: 'r1' },
    { id: 'old-in-mixed', createdAt: old, revision: 'r2' },
    { id: 'new-session', createdAt: recent, revision: 'r3' },
    { id: 'orphan', createdAt: old, revision: 'r4' },
  ],
  activeSessionIds: [],
});

test('archive is default and all selects only exact record identities, never project paths', async () => {
  const plan = (await planner())(snapshot(), { scope: 'all' });
  assert.equal(plan.operation, 'archive');
  assert.deepEqual(plan.workspaceIds, ['empty-workspace', 'mixed-workspace', 'old-workspace']);
  assert.equal(plan.sessionIds.length, 4);
  assert.equal(plan.projectFilesAffected, false);
});

test('before means strict creation-time cutoff; newer sessions preserve their workspace', async () => {
  const plan = (await planner())(snapshot(), { operation: 'delete', scope: 'before', before: recent });
  assert.equal(plan.operation, 'delete');
  assert.deepEqual(plan.workspaceIds, ['empty-workspace', 'old-workspace']);
  assert.deepEqual(plan.sessionIds, ['old-in-mixed', 'old-session', 'orphan']);
});

test('any active session blocks stop-the-backend maintenance, even outside selected time range', async () => {
  const input = snapshot(); input.activeSessionIds = ['new-session'];
  const plan = (await planner())(input, { scope: 'before', before: recent });
  assert.equal(plan.executable, false);
  assert.equal(plan.blockedReason, 'ACTIVE_SESSIONS');
});

test('missing session metadata and invalid dates fail conservatively', async () => {
  const input = snapshot();
  input.sessions[0].createdAt = 'bad';
  input.workspaces.push({ id: 'unknown-child', createdAt: old, sessionIds: ['missing'] });
  const plan = (await planner())(input, { scope: 'before', before: recent });
  assert.ok(!plan.sessionIds.includes('old-session'));
  assert.ok(!plan.workspaceIds.includes('old-workspace'));
  assert.ok(!plan.workspaceIds.includes('unknown-child'));
});

test('invalid operations, ambiguous local dates, duplicate identities and oversized snapshots reject', async () => {
  const plan = await planner();
  for (const options of [{ scope: 'all', operation: 'purge' }, { scope: 'other' }, { scope: 'before', before: '2026-09-01' }, { scope: 'before', before: '2026-02-30T00:00:00Z' }]) {
    assert.throws(() => plan(snapshot(), options));
  }
  const duplicate = snapshot(); duplicate.sessions.push(duplicate.sessions[0]);
  assert.throws(() => plan(duplicate, { scope: 'all' }));
  assert.throws(() => plan({ ...snapshot(), workspaces: Array(10001).fill({ id: 'x' }) }, { scope: 'all' }));
});

test('same selection has stable revision; new records, active state or source revisions invalidate preview', async () => {
  const plan = await planner();
  const input = snapshot();
  const first = plan(input, { scope: 'all' });
  assert.equal(plan(snapshot(), { scope: 'all' }).revision, first.revision);
  input.sessions[0].revision = 'changed';
  assert.notEqual(plan(input, { scope: 'all' }).revision, first.revision);
  input.sessions[0].revision = 'r1'; input.activeSessionIds = ['active'];
  assert.notEqual(plan(input, { scope: 'all' }).revision, first.revision);
});

// Provenance scoping exists because a Crew worker's session and the operator's
// own session are otherwise indistinguishable: same store, same header shape.
// A header carries no field naming who asked for it, so scope can only come from
// what Crew recorded at dispatch time.
test('crew scope selects only recorded Crew sessions and never guesses', async () => {
  const plan = await planner();
  const input = snapshot();
  input.crewSessionIds = ['old-session'];
  const crew = plan(input, { scope: 'crew' });
  assert.deepEqual(crew.sessionIds, ['old-session']);
  assert.deepEqual(crew.workspaceIds, ['old-workspace'], 'only a fully covered workspace follows');

  // An unrecorded session is the operator's, even when it looks like Crew work.
  input.sessions.push({ id: 'unrecorded', createdAt: old, revision: 'r9', cwd: 'C:/tmp/dsh-crew-worktrees/x' });
  const stillCrew = plan(input, { scope: 'crew' });
  assert.ok(!stillCrew.sessionIds.includes('unrecorded'), 'absence from the ledger must never be treated as Crew authorship');
  assert.ok(plan(input, { scope: 'all' }).sessionIds.includes('unrecorded'), 'all still reaches it');
});

test('worktree scope narrows crew sessions to the isolated-workspace subset', async () => {
  const plan = await planner();
  const input = snapshot();
  input.sessions[0].worktree = true;      // old-session
  input.sessions[1].worktree = false;     // old-in-mixed
  input.crewSessionIds = ['old-session', 'old-in-mixed'];
  assert.deepEqual(plan(input, { scope: 'worktree' }).sessionIds, ['old-session']);
  assert.deepEqual(plan(input, { scope: 'crew' }).sessionIds, ['old-in-mixed', 'old-session']);
});

test('scope defaults to Crew\'s own workspaces, so a forgotten range cannot reach the operator sessions', async () => {
  const plan = await planner();
  const input = snapshot();
  input.crewSessionIds = ['old-session'];
  input.sessions = input.sessions.map((s) => (s.id === 'old-session' ? { ...s, worktree: true } : s));
  assert.deepEqual(plan(input).sessionIds, ['old-session'], 'the default is Crew\'s workspaces');
  assert.deepEqual(plan(input).workspaceIds, ['old-workspace'], 'and the workspace follows its only child');
});

test('a Crew session outside a Crew workspace is not in the default scope', async () => {
  // The scope is the workspaces, not everything Crew ever ran: a job dispatched
  // with a shared workspace runs in the caller's directory, and that is not one
  // of these.
  const plan = await planner();
  const input = snapshot();
  input.crewSessionIds = ['old-session'];
  assert.deepEqual(plan(input).sessionIds, [], 'no workspace marker means no default selection');
});

test('the workspace scope takes an optional window, and a malformed one still fails', async () => {
  const plan = await planner();
  const input = snapshot();
  input.crewSessionIds = ['old-in-mixed', 'new-session'];
  input.sessions = input.sessions.map((s) => (s.id === 'old-in-mixed' || s.id === 'new-session' ? { ...s, worktree: true } : s));

  // No window: everything in Crew's workspaces.
  assert.deepEqual(plan(input, { scope: 'worktree' }).sessionIds, ['new-session', 'old-in-mixed']);

  // With a window: the newer session is held back, and because the workspace
  // still has a live child that was not selected, the workspace is held back
  // with it — a workspace never follows a subset of its children.
  const windowed = plan(input, { scope: 'worktree', before: recent });
  assert.deepEqual(windowed.sessionIds, ['old-in-mixed']);
  assert.deepEqual(windowed.workspaceIds, []);

  // A date that was supplied and is unparseable is an error, not "no window":
  // a typo must not silently widen the range to everything.
  assert.throws(() => plan(input, { scope: 'worktree', before: 'not-a-date' }), /HISTORY_INVALID_CUTOFF/);
});

// A cleanup used to be able to remove sessions and leave their workspaces behind:
// every scope required a workspace's children to be selected, and the children no
// longer existed to be selected. Those rows were then unreachable forever, and
// all the operator could see was a sidebar full of workspaces that opened
// nothing. The ledger still records who made those sessions, so the same evidence
// that makes a live session Crew's makes a gone one Crew's too.
test('a workspace whose sessions are already gone follows the ledger, not the file listing', async () => {
  const plan = await planner();
  const orphan = {
    workspaces: [{ id: 'orphaned', createdAt: old, sessionIds: ['gone-session'] }],
    sessions: [],
    activeSessionIds: [],
    crewSessionIds: ['gone-session'],
  };
  const crew = plan(orphan, { scope: 'crew' });
  assert.deepEqual(crew.workspaceIds, ['orphaned']);
  assert.deepEqual(crew.sessionIds, [], 'there is no artifact left to delete');
  assert.deepEqual(crew.absentSessionIds, ['gone-session'], 'a gone child is reported, not hidden');
  assert.equal(crew.executable, true);

  // Absence from the ledger is not authorship, in either direction.
  assert.deepEqual(plan({ ...orphan, crewSessionIds: [] }, { scope: 'crew' }).workspaceIds, []);
  assert.deepEqual(plan({ ...orphan, crewSessionIds: [] }, { scope: 'all' }).workspaceIds, [],
    'even the widest scope refuses to remove a record it cannot attribute');
});

test('a live session still protects the workspace that names it', async () => {
  const plan = await planner();
  const input = {
    workspaces: [{ id: 'mixed', createdAt: old, sessionIds: ['gone-session', 'live-session'] }],
    sessions: [{ id: 'live-session', createdAt: old, revision: 'r1' }],
    activeSessionIds: [],
    crewSessionIds: ['gone-session'],
  };
  // The gone child is covered, but the live one is not selected by this scope
  // and is not Crew's: deleting the row would delete the operator's workspace.
  assert.deepEqual(plan(input, { scope: 'crew' }).workspaceIds, [], 'a child that survives the scope keeps its workspace');
  // `all` selects that child too, so the row follows both of its children out.
  assert.deepEqual(plan(input, { scope: 'all' }).workspaceIds, ['mixed']);
});

test('worktree scope needs the path marker when there is no session header left to carry it', async () => {
  const plan = await planner();
  const orphan = {
    workspaces: [{ id: 'orphaned', createdAt: old, sessionIds: ['gone-session'] }],
    sessions: [],
    activeSessionIds: [],
    crewSessionIds: ['gone-session'],
  };
  assert.deepEqual(plan(orphan, { scope: 'worktree' }).workspaceIds, [], 'no header and no path marker');
  assert.deepEqual(plan({ ...orphan, workspaces: [{ ...orphan.workspaces[0], worktree: true }] }, { scope: 'worktree' }).workspaceIds,
    ['orphaned'], 'the workspace path under the worktree root is the marker that survives');
});
