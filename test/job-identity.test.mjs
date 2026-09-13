// The job identity: one name for the worktree, the session and the operator.
//
// The Harness titles a dispatched session from the opening words of the prompt the
// agent receives, so before this the conversation read "In this isolated git
// repository," or whatever the task began with, while the worktree on disk was
// `Crew_<date>_<time>_<purpose>`. An operator could not match one to the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobDisplayName, jobNamePurpose, jobNameStamp, JOB_NAME_RE } from '../src/job-identity.mjs';
import { isCrewWorktreeName, reserveWorktreeDir } from '../src/workspace-isolation.mjs';
import { prependJobIdentity, appendDeliveryInstructions, JOB_HEADER_MARKER } from '../src/delivery.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the display name is the worktree grammar', () => {
  const at = new Date(2026, 8, 13, 19, 2, 31);
  assert.equal(jobDisplayName({ purpose: 'worker', at }), 'Crew_20260913_190231_worker');
  assert.match(jobDisplayName({ purpose: 'reviewer', at }), JOB_NAME_RE);
  // The worktree allocator must recognise every name this produces, or a job's
  // conversation and its directory would use two different rules.
  assert.equal(isCrewWorktreeName(jobDisplayName({ purpose: 'worker', at })), true);
});

test('every purpose the display name can build is recognised as a Crew worktree name', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const at = new Date(2026, 8, 13, 19, 2, 31);
  let n = 0;
  for (const purpose of ['worker', 'reviewer', '', '   ', 'role/with/slashes', 'a'.repeat(31) + '-b', 'a'.repeat(64), 'ümlaut', 'UPPER', '123', null, undefined]) {
    const name = jobDisplayName({ purpose, at });
    assert.equal(isCrewWorktreeName(name), true, `not recognised: ${JSON.stringify(purpose)} -> ${name}`);
    // A fresh root, so the first reservation is the un-suffixed name and the two
    // builders can be compared directly.
    const reserved = reserveWorktreeDir({ root: join(root, `r${n++}`), purpose, at });
    assert.equal(isCrewWorktreeName(reserved.name), true, `reserved a name its own grammar rejects: ${reserved.name}`);
    assert.equal(reserved.name, name, 'the display name and the reserved name are the same string');
    // A second job in the same second takes the collision suffix, and the grammar
    // still accepts it.
    const second = reserveWorktreeDir({ root: reserved.dir.replace(/[\\/][^\\/]+$/, ''), purpose, at });
    assert.equal(isCrewWorktreeName(second.name), true, `collision suffix rejected: ${second.name}`);
  }
});

test('the purpose sanitiser cannot leave a trailing separator', () => {
  assert.equal(jobNamePurpose('a'.repeat(31) + '-b').endsWith('-'), false);
  assert.equal(jobNamePurpose(''), 'job');
  assert.equal(jobNamePurpose(null), 'job');
  assert.equal(jobNamePurpose('../../escape/me now'), 'escape-me-now');
});

test('the stamp is local wall-clock, zero padded', () => {
  assert.equal(jobNameStamp(new Date(2026, 0, 2, 3, 4, 5)), '20260102_030405');
});

test('the prompt opens with the job name so the session is titled after it', () => {
  const prompt = prependJobIdentity('Do the thing.', { name: 'Crew_20260913_190231_worker', role: 'worker' });
  assert.equal(prompt.startsWith(`${JOB_HEADER_MARKER}Crew_20260913_190231_worker`), true);
  assert.match(prompt, /Do the thing\./);
});

test('prepending is idempotent, and composes with the delivery contract', () => {
  const once = prependJobIdentity('Do the thing.', { name: 'Crew_20260913_190231_worker', role: 'worker' });
  assert.equal(prependJobIdentity(once, { name: 'Crew_20260913_190231_worker', role: 'worker' }), once, 'a re-dispatch is not doubled');
  const full = appendDeliveryInstructions(once, { tier: 'flash', role: 'worker' });
  assert.equal(full.startsWith(JOB_HEADER_MARKER), true);
  assert.match(full, /## Diff/);
  assert.equal(appendDeliveryInstructions(full, { tier: 'flash', role: 'worker' }), full);
});

test('a task with no name is returned untouched', () => {
  assert.equal(prependJobIdentity('Do the thing.', {}), 'Do the thing.');
  assert.equal(prependJobIdentity(undefined, { name: 'x' }), undefined);
});
