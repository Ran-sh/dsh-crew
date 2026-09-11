import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSessionOrigin, readSessionOrigins, sessionOriginsFile } from '../src/session-origins.mjs';

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-origins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('recorded sessions are read back, and unrecorded ones stay unclaimed', (t) => {
  const home = tempHome(t);
  assert.equal(appendSessionOrigin({ home, sessionId: 'session-a', role: 'worker', jobId: 'job-1' }), true);
  assert.equal(appendSessionOrigin({ home, sessionId: 'session-b', role: 'reviewer' }), true);
  const ids = readSessionOrigins({ home });
  assert.deepEqual([...ids].sort(), ['session-a', 'session-b']);
  assert.equal(ids.has('session-never-recorded'), false);
});

test('the ledger appends and preserves earlier records', (t) => {
  const home = tempHome(t);
  appendSessionOrigin({ home, sessionId: 'session-a' });
  appendSessionOrigin({ home, sessionId: 'session-b' });
  assert.deepEqual([...readSessionOrigins({ home })].sort(), ['session-a', 'session-b']);
  const lines = readFileSync(sessionOriginsFile({ home }), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).sessionId, 'session-a');
});

// Losing a line must never make cleanup unusable, and must never widen scope:
// a session the ledger cannot vouch for is treated as the operator's.
test('a torn tail is skipped rather than failing the whole ledger', (t) => {
  const home = tempHome(t);
  appendSessionOrigin({ home, sessionId: 'session-a' });
  writeFileSync(sessionOriginsFile({ home }), readFileSync(sessionOriginsFile({ home }), 'utf8') + '{"sessionId":"session-b"\n');
  const ids = readSessionOrigins({ home });
  assert.deepEqual([...ids], ['session-a']);
});

test('a missing ledger is empty, and an unusable path never throws', (t) => {
  const home = tempHome(t);
  assert.equal(existsSync(sessionOriginsFile({ home })), false);
  assert.deepEqual([...readSessionOrigins({ home })], []);
  assert.equal(appendSessionOrigin({ home, sessionId: '' }), false);
  assert.equal(appendSessionOrigin({ home }), false);
});
