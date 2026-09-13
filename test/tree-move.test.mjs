import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TRANSIENT_RENAME_CODES, renameTree } from '../src/install/tree-move.mjs';

const themed = (code) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

test('a transient Windows refusal is absorbed', () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-rename-'));
  try {
    const from = join(home, 'from');
    const to = join(home, 'to');
    mkdirSync(from);
    writeFileSync(join(from, 'a.txt'), 'x');
    let refusals = 0;
    const rename = (a, b) => {
      if (refusals < 3) { refusals += 1; throw themed(TRANSIENT_RENAME_CODES[0]); }
      renameSync(a, b);
    };
    assert.equal(renameTree(from, to, { rename }).ok, true);
    assert.equal(refusals, 3, 'the refusal really happened and was retried');
    assert.equal(existsSync(to), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a non-transient failure is raised at once, not retried', () => {
  let attempts = 0;
  const rename = () => { attempts += 1; throw themed('ENOENT'); };
  assert.throws(() => renameTree('/nope', '/there', { rename }), /ENOENT/);
  assert.equal(attempts, 1, 'a missing source will not appear on the next attempt');
});

test('a refusal that never passes is reported, not swallowed', () => {
  let attempts = 0;
  const rename = () => { attempts += 1; throw themed('EPERM'); };
  assert.throws(() => renameTree('/a', '/b', { rename, delays: [0, 1, 1] }), /EPERM/);
  assert.equal(attempts, 3, 'every allowed attempt was made before reporting');
});

test('the first attempt is immediate', () => {
  const home = mkdtempSync(join(tmpdir(), 'crew-rename-first-'));
  try {
    const from = join(home, 'from');
    const to = join(home, 'to');
    mkdirSync(from);
    const started = Date.now();
    renameTree(from, to, { delays: [0, 5000] });
    assert.ok(Date.now() - started < 1000, 'a successful rename does not wait for the retry budget');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
