// Tests for the read-only workspace audit (src/workspace-audit.mjs). Pure-logic
// cases use an injected fake `git` runner (no real git needed); one
// integration case inits a throwaway git repo under the OS temp dir to prove
// baseline→modify→diff works against real git. Both stay read-only: the module
// never issues reset/stash/clean, and nothing is written to the repo.
//
// Run with: node --test test/workspace-audit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  captureWorkspaceBaseline,
  captureWorkspaceDiff,
  isSensitivePath,
  parseChanges,
  NOT_A_GIT_REPOSITORY,
  GIT_TIMEOUT,
  GIT_TIMEOUT_MS,
  resolveWindowsGit,
  DIFF_LIMIT,
} from '../src/workspace-audit.mjs';

/** Fake git runner: map of joined-args → stdout string or {stdout, stderr}. */
function fakeRunner(map) {
  return async (args, _opts) => {
    const hit = map[args.join(' ')];
    if (hit === undefined) return { code: 0, stdout: '', stderr: '' };
    if (typeof hit === 'string') return { code: 0, stdout: hit, stderr: '' };
    return { code: 0, stdout: '', stderr: '', ...hit };
  };
}

const GIT_OK = {
  'status --porcelain': '',
  'diff --name-status': '',
  'diff --stat': '',
};

// ---------- isSensitivePath ----------

test('isSensitivePath redacts env / credentials / secrets / keys / pems', () => {
  for (const p of ['.env', '.env.local', 'config/.env.production', 'credentials.json', 'secrets.yaml', 'secret-key.pem', 'server.key', 'deploy/prod.key']) {
    assert.equal(isSensitivePath(p), true, `${p} should be sensitive`);
  }
});

test('git timeout degrades with GIT_TIMEOUT instead of failing the worker', async () => {
  const error = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true });
  const result = await captureWorkspaceBaseline({ cwd: '/proj', git: async () => { throw error; } });
  assert.equal(result.kind, 'no-git');
  assert.equal(result.reason, GIT_TIMEOUT);
});

test('Windows Git resolver prefers where.exe and applies the audit timeout', async () => {
  let options;
  const resolved = await resolveWindowsGit({
    exec: async (file, args, opts) => { options = { file, args, opts }; return { stdout: 'C:\\Git\\cmd\\git.exe\r\nC:\\Git\\bin\\git.exe\r\n' }; },
    env: {}, exists: () => false,
  });
  assert.equal(resolved, 'C:\\Git\\cmd\\git.exe');
  assert.equal(options.file, 'where.exe');
  assert.deepEqual(options.args, ['git']);
  assert.equal(options.opts.timeout, GIT_TIMEOUT_MS);
});

test('Windows Git resolver falls back to bounded known install paths', async () => {
  const expected = 'C:\\Program Files\\Git\\bin\\git.exe';
  const checked = [];
  const resolved = await resolveWindowsGit({
    exec: async () => { throw new Error('where unavailable'); },
    env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    exists: (candidate) => { checked.push(candidate); return candidate === expected; },
  });
  assert.equal(resolved, expected);
  assert.deepEqual(checked, ['C:\\Program Files\\Git\\cmd\\git.exe', expected]);
});

test('isSensitivePath leaves ordinary source files alone', () => {
  for (const p of ['src/main.js', 'package.json', '.gitignore', 'README.md', 'docs/guide.md']) {
    assert.equal(isSensitivePath(p), false, `${p} should not be sensitive`);
  }
});

// ---------- parseChanges ----------

test('parseChanges folds renames onto the destination and lists untracked separately', () => {
  const ns = 'M\tsrc/a.mjs\nD\tsrc/old.mjs\nR100\ta.ts\tb.ts\n';
  const st = '?? newfile.txt\n?? .env\n';
  const c = parseChanges(ns, st);
  assert.deepEqual(c.modified.sort(), ['b.ts', 'src/a.mjs'].sort());
  assert.deepEqual(c.deleted, ['src/old.mjs']);
  assert.deepEqual(c.renamed, ['a.ts']);
  assert.deepEqual(c.untracked.sort(), ['.env', 'newfile.txt'].sort());
});

// ---------- captureWorkspaceBaseline (fake runner) ----------

test('baseline reports a clean repo as not dirty', async () => {
  const git = fakeRunner({ ...GIT_OK });
  const b = await captureWorkspaceBaseline({ cwd: '/proj', git });
  assert.equal(b.kind, 'git');
  assert.equal(b.dirty, false);
  assert.deepEqual(b.changes.modified, []);
});

test('baseline flags a pre-dirty workspace', async () => {
  const git = fakeRunner({
    'status --porcelain': ' M src/a.mjs\n?? todo.md',
    'diff --name-status': 'M\tsrc/a.mjs',
    'diff --stat': ' src/a.mjs | 1 +\n',
  });
  const b = await captureWorkspaceBaseline({ cwd: '/proj', git });
  assert.equal(b.kind, 'git');
  assert.equal(b.dirty, true);
  assert.deepEqual(b.changes.modified, ['src/a.mjs']);
  assert.deepEqual(b.changes.untracked, ['todo.md']);
});

test('baseline degrades to NOT_A_GIT_REPOSITORY without throwing', async () => {
  const git = fakeRunner({
    'status --porcelain': { stderr: "fatal: not a git repository (or any of the parent directories): .git" },
  });
  const b = await captureWorkspaceBaseline({ cwd: '/nope', git });
  assert.equal(b.kind, 'no-git');
  assert.equal(b.reason, NOT_A_GIT_REPOSITORY);
});

test('baseline never throws on runner errors', async () => {
  const b = await captureWorkspaceBaseline({ cwd: '/proj', git: async () => { throw new Error('boom'); } });
  assert.equal(b.kind, 'no-git');
});

// ---------- captureWorkspaceDiff (fake runner) ----------

function diffFixture(extra = {}) {
  return {
    'status --porcelain': ' M src/a.mjs\n M .env\n?? notes.md',
    'diff --name-status': 'M\tsrc/a.mjs\nM\t.env',
    'diff --stat': ' src/a.mjs | 1 +\n .env | 1 +\n',
    'diff --binary -- src/a.mjs': 'diff --git a/src/a.mjs b/src/a.mjs\n@@ -1 +1 @@\n+a\n',
    ...extra,
  };
}

test('captureWorkspaceDiff returns after-state plus redacted patch', async () => {
  const git = fakeRunner(diffFixture());
  const baseline = { kind: 'git', dirty: false };
  const d = await captureWorkspaceDiff({ cwd: '/proj', baseline, git });
  assert.equal(d.kind, 'git');
  // The .env patch is replaced by a marker (path header + no content body)…
  assert.match(d.patch, /diff --git a\/\.env b\/\.env\n\[REDACTED SENSITIVE FILE\]/);
  assert.doesNotMatch(d.patch, /\[REDACTED SENSITIVE FILE\]\n[^[]/); // nothing follows the marker
  // …and its name-status entry stays visible.
  assert.match(d.nameStatus, /\.env/);
  assert.deepEqual(d.redacted, ['.env']);
  assert.equal(d.truncated, false);
  assert.equal(d.dirtyBaseline, false);
});

test('captureWorkspaceDiff truncates oversized patches and sets the flag', async () => {
  const big = `diff --git a/src/big.mjs b/src/big.mjs\n${' '.repeat(2000)}+\n` + 'patch\n'.repeat(10000);
  const git = fakeRunner(diffFixture({ 'diff --binary -- src/a.mjs': big }));
  const d = await captureWorkspaceDiff({ cwd: '/proj', baseline: { kind: 'git', dirty: false }, git, limit: 1024 });
  assert.equal(d.truncated, true);
  assert.ok(d.patch.length <= 1024 + 3); // byte truncation on utf8
});

test('captureWorkspaceDiff includes untracked non-sensitive paths without their content', async () => {
  const git = fakeRunner(diffFixture());
  const d = await captureWorkspaceDiff({ cwd: '/proj', baseline: { kind: 'git', dirty: false }, git });
  assert.match(d.patch, /\[UNTRACKED FILE: notes\.md/);
  assert.doesNotMatch(d.patch, /untracked secret content/i);
});

test('captureWorkspaceDiff flags a dirty baseline on the diff result', async () => {
  const git = fakeRunner(diffFixture());
  const d = await captureWorkspaceDiff({ cwd: '/proj', baseline: { kind: 'git', dirty: true }, git });
  assert.equal(d.dirtyBaseline, true);
});

test('captureWorkspaceDiff with a no-git baseline degrades without throwing', async () => {
  const d = await captureWorkspaceDiff({ cwd: '/proj', baseline: { kind: 'no-git', reason: NOT_A_GIT_REPOSITORY } });
  assert.equal(d.kind, 'no-git');
});

test('captureWorkspaceDiff never throws on runner errors', async () => {
  const d = await captureWorkspaceDiff({ cwd: '/proj', baseline: { kind: 'git' }, git: async () => { throw new Error('boom'); } });
  assert.equal(d.kind, 'no-git');
});

test('captureWorkspaceDiff bounds the patch to the default 64 KiB limit', async () => {
  const huge = 'x'.repeat(DIFF_LIMIT * 2);
  const git = fakeRunner(diffFixture({ 'diff --binary -- src/a.mjs': huge }));
  const d = await captureWorkspaceDiff({ cwd: '/proj', baseline: { kind: 'git', dirty: false }, git });
  assert.equal(d.truncated, true);
  assert.ok(d.patch.length <= DIFF_LIMIT + 3);
});

// ---------- integration: real throwaway git repo ----------

function gitAvailable() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

test('real temp git repo: baseline → modify → diff with redaction', { skip: !gitAvailable() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-audit-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'audit@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'dsh-crew audit'], { cwd: dir });
    writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });

    const baseline = await captureWorkspaceBaseline({ cwd: dir });
    assert.equal(baseline.kind, 'git');
    assert.equal(baseline.dirty, false);

    writeFileSync(join(dir, 'a.mjs'), 'export const a = 2;\n');
    writeFileSync(join(dir, '.env'), 'KEY=topsecret\n');

    const diff = await captureWorkspaceDiff({ cwd: dir, baseline });
    assert.equal(diff.kind, 'git');
    assert.match(diff.status, /a\.mjs/);
    assert.match(diff.patch, /export const a = 2/);
    // .env is untracked → shows in status and as a redacted untracked marker,
    // never with its content, never with the secret value.
    assert.ok(diff.changes.untracked.includes('.env'));
    assert.match(diff.patch, /\[REDACTED SENSITIVE FILE: \.env \(untracked\)\]/);
    assert.doesNotMatch(diff.patch, /topsecret/);
    assert.deepEqual(diff.redacted, ['.env']);
    assert.equal(diff.dirtyBaseline, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
