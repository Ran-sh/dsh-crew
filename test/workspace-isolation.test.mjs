// PR3 git-worktree isolation tests: injectable-git unit coverage for the
// lifecycle (create / capture / cleanup / prune) and a real temp-repo
// integration check. Windows-safe paths only — no shell string building.
// Run with: node --test test/workspace-isolation.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  createIsolatedWorkspace,
  captureCandidate,
  cleanupIsolatedWorkspace,
  staleWorktrees,
  pruneWorktrees,
  clampMaxParallel,
  concurrencyGate,
  inspectRepository,
  NOT_GIT_REPOSITORY,
  WORKTREE_LOCKED,
} from '../src/workspace-isolation.mjs';

const REV = 'abc123';
const WORKTREE = join(tmpdir(), 'dsh-crew-wt-test-0000');

function fakeRunner(rules) {
  const calls = [];
  const runner = async (args, { cwd } = {}) => {
    calls.push({ args, cwd });
    const key = args.join(' ');
    const rule = rules.find((r) => r.pat.test(key));
    if (!rule) return { code: 1, stdout: '', stderr: `unsupported: ${key}` };
    if (typeof rule.out === 'function') return rule.out(calls);
    return { code: rule.out.code ?? 0, stdout: rule.out.stdout ?? '', stderr: rule.out.stderr ?? '' };
  };
  return { runner, calls };
}

// ---------- inspectRepository ----------

test('inspectRepository resolves root + HEAD and degrades on a non-repo', async () => {
  const { runner } = fakeRunner([
    { pat: /^rev-parse --show-toplevel$/, out: { stdout: '/repo\n' } },
    { pat: /^rev-parse HEAD$/, out: { stdout: `${REV}\n` } },
  ]);
  const r = await inspectRepository({ cwd: '/repo', git: runner });
  assert.equal(r.ok, true);
  assert.equal(r.repoRoot, resolve('/repo'));
  assert.equal(r.baseRevision, REV);
});

test('inspectRepository non-git degrades to NOT_GIT_REPOSITORY without throwing', async () => {
  const { runner } = fakeRunner([
    { pat: /^rev-parse --show-toplevel$/, out: { code: 128, stderr: 'fatal: not a git repository\n' } },
  ]);
  const r = await inspectRepository({ cwd: '/nope', git: runner });
  assert.equal(r.ok, false);
  assert.equal(r.reason, NOT_GIT_REPOSITORY);
});

// ---------- createIsolatedWorkspace ----------

test('createIsolatedWorkspace allocates a unique detached worktree at the base revision', async () => {
  const { runner, calls } = fakeRunner([
    { pat: /^rev-parse --show-toplevel$/, out: { stdout: '/repo\n' } },
    { pat: /^rev-parse HEAD$/, out: { stdout: `${REV}\n` } },
    { pat: /^worktree add --detach /, out: { stdout: '' } },
  ]);
  const c = await createIsolatedWorkspace({ cwd: '/repo', jobId: 'j1', root: tmpdir(), git: runner });
  assert.equal(c.ok, true);
  assert.equal(c.baseRevision, REV);
  assert.ok(c.worktreePath.startsWith(join(tmpdir(), 'dsh-crew-j1-')));
  const add = calls.find((x) => x.args[0] === 'worktree');
  assert.deepEqual(add.args, ['worktree', 'add', '--detach', c.worktreePath, REV]);
});

test('createIsolatedWorkspace propagates a git failure', async () => {
  const { runner } = fakeRunner([
    { pat: /^rev-parse --show-toplevel$/, out: { stdout: '/repo\n' } },
    { pat: /^rev-parse HEAD$/, out: { stdout: `${REV}\n` } },
    { pat: /^worktree add /, out: { code: 128, stderr: 'fatal: could not resolve HEAD\n' } },
  ]);
  const c = await createIsolatedWorkspace({ cwd: '/repo', root: tmpdir(), git: runner });
  assert.equal(c.ok, false);
});

// ---------- captureCandidate ----------

test('captureCandidate builds a bounded, redacted candidate with name status + stat', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-wt-cap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { runner, calls } = fakeRunner([
    { pat: /^status --porcelain$/, out: { stdout: ' M src/a.mjs\n?? .env\n' } },
    { pat: /^diff --name-status HEAD$/, out: { stdout: 'M\tsrc/a.mjs\n' } },
    { pat: /^diff --stat HEAD$/, out: { stdout: ' src/a.mjs | 2 +-\n' } },
    { pat: /^diff --binary HEAD$/, out: { stdout: 'diff --git a/src/a.mjs b/src/a.mjs\n+export const x = 1;\n' } },
  ]);
  const c = await captureCandidate({ worktreePath: dir, baseRevision: REV, git: runner });
  assert.equal(c.ok, true);
  assert.equal(c.kind, 'git-worktree');
  assert.equal(c.base_revision, REV);
  assert.ok(c.changed_files.includes('src/a.mjs'));
  assert.match(c.patch, /src\/a\.mjs/);
  // .env is redacted: the patch must carry only the marker path, never content
  assert.match(c.patch, /\[REDACTED SENSITIVE FILE: \.env\]/);
  assert.ok(c.sensitive_paths_redacted.includes('.env'));
  assert.ok(calls.some((x) => x.args[0] === 'diff'));
});

test('captureCandidate on a missing worktree path degrades without throwing', async () => {
  const { runner } = fakeRunner([]);
  const c = await captureCandidate({ worktreePath: join(tmpdir(), 'does-not-exist-xyz'), git: runner });
  assert.equal(c.ok, false);
});

// ---------- cleanup / prune ----------

test('cleanupIsolatedWorkspace removes via git worktree remove --force', async () => {
  const { runner, calls } = fakeRunner([
    { pat: /^rev-parse --git-common-dir$/, out: { stdout: '/repo/.git\n' } },
    { pat: /^worktree remove --force /, out: { stdout: '' } },
  ]);
  const r = await cleanupIsolatedWorkspace({ worktreePath: WORKTREE, git: runner });
  assert.equal(r.ok, true);
  assert.equal(r.removed, true);
  assert.ok(calls.some((x) => x.args[0] === 'worktree' && x.args[1] === 'remove'));
});

test('cleanupIsolatedWorkspace reports a locked worktree instead of hiding it', async () => {
  const { runner } = fakeRunner([
    { pat: /^rev-parse --git-common-dir$/, out: { stdout: '/repo/.git\n' } },
    { pat: /^worktree remove --force /, out: { code: 128, stderr: 'fatal: Unable to delete ... permission denied\n' } },
  ]);
  const r = await cleanupIsolatedWorkspace({ worktreePath: WORKTREE, git: runner });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WORKTREE_LOCKED);
  assert.equal(r.cleanupBlocked, true);
});

test('staleWorktrees/prune identify only dsh-crew worktrees outside the allowed set', async () => {
  const { runner } = fakeRunner([
    { pat: /^rev-parse --show-toplevel$/, out: { stdout: '/repo\n' } },
    { pat: /^rev-parse HEAD$/, out: { stdout: `${REV}\n` } },
    {
      pat: /^worktree list --porcelain$/,
      out: { stdout: `worktree ${WORKTREE}\nHEAD ${REV}\n\nworktree /repo\nHEAD ${REV}\n\nworktree ${join(tmpdir(), 'user-wt')}\nHEAD ${REV}\n\n` },
    },
  ]);
  const stale = await staleWorktrees({ git: runner, allowed: [WORKTREE] });
  assert.ok(!stale.includes(WORKTREE), 'allowed worktree must not be stale');
  assert.equal(stale.length, 0, 'only dsh-crew-* worktrees outside allowed are stale');
});

test('concurrency gate clamps to max parallel and blocks beyond it', () => {
  assert.equal(clampMaxParallel(0), 1);
  assert.equal(clampMaxParallel(3), 3);
  assert.equal(clampMaxParallel(999), 16);
  const g = concurrencyGate({ maxParallel: 2, active: 2 });
  assert.equal(g.ok, false);
  assert.equal(g.blocked, true);
  assert.equal(concurrencyGate({ maxParallel: 2, active: 1 }).ok, true);
});

// ---------- real repo integration (git available) ----------

function haveGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const maybe = haveGit() ? test : test.skip;

maybe('real temp repo: create worktree, edit, capture candidate, cleanup', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-crew-isolation-repo-'));
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-isolation-root-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });

    const created = await createIsolatedWorkspace({ cwd: repo, jobId: 'real', root });
    assert.equal(created.ok, true);
    assert.ok(existsSync(created.worktreePath));
    // The worktree starts clean at base; edit a file inside it.
    writeFileSync(join(created.worktreePath, 'a.mjs'), 'export const a = 2;\n');

    const candidate = await captureCandidate({ worktreePath: created.worktreePath, baseRevision: created.baseRevision });
    assert.equal(candidate.ok, true);
    assert.ok(candidate.changed_files.includes('a.mjs'));
    assert.match(candidate.patch, /export const a = 2/);

    // The primary working tree must remain untouched by all of the above.
    const primary = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    assert.equal(primary.trim(), '');

    const cleaned = await cleanupIsolatedWorkspace({ worktreePath: created.worktreePath, git: undefined });
    assert.equal(cleaned.ok, true, `cleanup failed: ${cleaned.error ?? ''}`);
  } finally {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
