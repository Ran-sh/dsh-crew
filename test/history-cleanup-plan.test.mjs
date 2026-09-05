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
