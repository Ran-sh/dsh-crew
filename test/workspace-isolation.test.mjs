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
  isCrewWorktreeName,
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
  // The name is Crew_<date>_<time>_<purpose>; an unset purpose reads as `job`.
  assert.match(c.name, /^Crew_[0-9]{8}_[0-9]{6}_job$/);
  assert.equal(c.worktreePath, join(tmpdir(), c.name));
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
    { pat: /^rev-parse --verify /, out: { stdout: `${REV}\n` } },
    { pat: /^rev-parse HEAD$/, out: { stdout: `${REV}\n` } },
    { pat: /^diff --name-status abc123$/, out: { stdout: 'M\tsrc/a.mjs\n' } },
    { pat: /^diff --stat abc123$/, out: { stdout: ' src/a.mjs | 2 +-\n' } },
    { pat: /^status --porcelain/, out: { stdout: ' M src/a.mjs\n?? .env\n' } },
    // Path-scoped diff of the NON-sensitive tracked path only — never .env.
    { pat: /^diff --binary abc123 -- src\/a\.mjs$/, out: { stdout: 'diff --git a/src/a.mjs b/src/a.mjs\n+export const x = 1;\n' } },
  ]);
  const c = await captureCandidate({ worktreePath: dir, baseRevision: REV, git: runner });
  assert.equal(c.ok, true);
  assert.equal(c.kind, 'git-worktree');
  assert.equal(c.base_revision, REV);
  assert.ok(c.changed_files.includes('src/a.mjs'));
  assert.match(c.patch, /src\/a\.mjs/);
  // .env is redacted: the patch must carry only the marker path, never content
  assert.match(c.patch, /\[REDACTED SENSITIVE FILE: \.env(?:\s+\(.*\))?\]/);
  assert.ok(c.sensitive_paths_redacted.includes('.env'));
  assert.deepEqual(c.untracked_files, ['.env']);
  assert.match(c.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(calls.some((x) => x.args[0] === 'diff' && x.args[1] === '--binary'));
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
    { pat: /^worktree list --porcelain$/, out: { stdout: `worktree ${WORKTREE}\nHEAD ${REV}\n\nworktree /repo\nHEAD ${REV}\n\n` } },
  ]);
  const r = await cleanupIsolatedWorkspace({ worktreePath: WORKTREE, git: runner, backoffMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WORKTREE_LOCKED);
  assert.equal(r.cleanupBlocked, true);
});

test('cleanupIsolatedWorkspace retries a transient lock and recovers', async () => {
  const { runner, calls } = fakeRunner([
    { pat: /^rev-parse --git-common-dir$/, out: { stdout: '/repo/.git\n' } },
    {
      pat: /^worktree remove --force /,
      out: (calls) => {
        const removes = calls.filter((x) => x.args[0] === 'worktree' && x.args[1] === 'remove');
        return removes.length <= 1 ? { code: 128, stderr: 'fatal: Unable to delete ... locked\n' } : { stdout: '' };
      },
    },
  ]);
  const r = await cleanupIsolatedWorkspace({ worktreePath: WORKTREE, git: runner, backoffMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.removed, true);
  const removes = calls.filter((x) => x.args[0] === 'worktree' && x.args[1] === 'remove');
  assert.ok(removes.length >= 2, `expected a bounded retry, got ${removes.length} remove calls`);
});

test('cleanupIsolatedWorkspace never claims success while the worktree stays registered', async () => {
  const { runner, calls } = fakeRunner([
    { pat: /^rev-parse --git-common-dir$/, out: { stdout: '/repo/.git\n' } },
    { pat: /^worktree remove --force /, out: { code: 128, stderr: 'fatal: unknown switch `x`\n' } },
    { pat: /^worktree list --porcelain$/, out: { stdout: `worktree ${WORKTREE}\nHEAD ${REV}\n\nworktree /repo\nHEAD ${REV}\n\n` } },
  ]);
  const r = await cleanupIsolatedWorkspace({ worktreePath: WORKTREE, git: runner, backoffMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WORKTREE_LOCKED);
  assert.equal(r.cleanupBlocked, true);
  assert.match(r.error, /still registered/);
  assert.ok(calls.some((x) => x.args[0] === 'worktree' && x.args[1] === 'list'), 'registration verification ran');
});

test('cleanupIsolatedWorkspace verified fallback success when registration and directory are gone', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'dsh-crew-fallback-'));
  try {
    writeFileSync(join(prefix, 'keep.txt'), 'x');
    const { runner } = fakeRunner([
      { pat: /^rev-parse --git-common-dir$/, out: { stdout: '/repo/.git\n' } },
      { pat: /^worktree remove --force /, out: { code: 128, stderr: 'fatal: Unable to delete ... permission denied\n' } },
      { pat: /^worktree list --porcelain$/, out: { stdout: 'worktree /repo\nHEAD abc123\n\n' } },
    ]);
    const r = await cleanupIsolatedWorkspace({ worktreePath: prefix, git: runner, backoffMs: 0 });
    assert.equal(r.ok, true);
    assert.equal(r.removed, true);
    assert.equal(existsSync(prefix), false, 'directory removed before claiming success');
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test('cleanupIsolatedWorkspace refuses to fs-delete non-Crew-owned paths', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'user-ws-'));
  try {
    writeFileSync(join(prefix, 'data.txt'), 'keep');
    const { runner } = fakeRunner([
      { pat: /^rev-parse --git-common-dir$/, out: { stdout: '/repo/.git\n' } },
      { pat: /^worktree remove --force /, out: { code: 128, stderr: 'fatal: Unable to delete ... permission denied\n' } },
      { pat: /^worktree list --porcelain$/, out: { stdout: `worktree ${prefix}\nHEAD ${REV}\n\n` } },
    ]);
    const r = await cleanupIsolatedWorkspace({ worktreePath: prefix, git: runner, backoffMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.cleanupBlocked, true);
    assert.equal(existsSync(join(prefix, 'data.txt')), true, 'non-Crew-owned path must not be deleted');
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test('cleanupIsolatedWorkspace never treats the primary repository root as disposable', async () => {
  const { runner } = fakeRunner([
    { pat: /^rev-parse --git-common-dir$/, out: { stdout: '/repo/.git\n' } },
    { pat: /^worktree remove --force /, out: { code: 128, stderr: 'fatal: Unable to delete ... permission denied\n' } },
  ]);
  const r = await cleanupIsolatedWorkspace({ worktreePath: '/repo', repoRoot: '/repo', git: runner, backoffMs: 0 });
  assert.equal(r.ok, false);
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

// ---------- worktree naming ----------

// The name is what an operator sees in the directory list and picks out of a
// cleanup prompt, so it has to say when the job ran and what it was for.
maybe('names a worktree Crew_<date>_<time>_<purpose>', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-crew-name-repo-'));
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-name-root-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });

    const at = new Date(2026, 8, 12, 18, 30, 45);
    for (const purpose of ['worker', 'reviewer']) {
      const created = await createIsolatedWorkspace({ cwd: repo, purpose, at, root });
      assert.equal(created.ok, true, created.error ?? '');
      const expected = `Crew_20260912_183045_${purpose}`;
      assert.equal(created.name, expected);
      assert.equal(existsSync(join(root, expected)), true);
      await cleanupIsolatedWorkspace({ worktreePath: created.worktreePath });
    }
  } finally {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

// Parallel jobs can start inside the same second, so the name cannot be the
// timestamp alone or two jobs would collide on one directory.
maybe('disambiguates two jobs that start in the same second', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-crew-collide-repo-'));
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-collide-root-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });

    const at = new Date(2026, 8, 12, 18, 30, 45);
    const first = await createIsolatedWorkspace({ cwd: repo, purpose: 'worker', at, root });
    const second = await createIsolatedWorkspace({ cwd: repo, purpose: 'worker', at, root });
    assert.equal(first.name, 'Crew_20260912_183045_worker');
    assert.equal(second.name, 'Crew_20260912_183045_worker-2');
    assert.notEqual(first.worktreePath, second.worktreePath);
    await cleanupIsolatedWorkspace({ worktreePath: first.worktreePath });
    await cleanupIsolatedWorkspace({ worktreePath: second.worktreePath });
  } finally {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

// Worktrees from an earlier release are still Crew's; if the new prefix were the
// only one recognised, they would be adopted by nothing and cleaned up never.
test('adopts both the current and the legacy worktree name', () => {
  assert.equal(isCrewWorktreeName('Crew_20260912_183045_worker'), true);
  assert.equal(isCrewWorktreeName('dsh-crew-wf-mtx2rtvq-mhkh4i-e21eb640'), true, 'a pre-rename worktree is still ours');
  assert.equal(isCrewWorktreeName('someone-elses-dir'), false);
  assert.equal(isCrewWorktreeName(''), false);
  assert.equal(isCrewWorktreeName(null), false);
});

// A purpose is free-form, so it must not be able to escape the directory name.
maybe('sanitizes a purpose that is not a plain word', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-crew-purge-repo-'));
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-purge-root-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });

    const created = await createIsolatedWorkspace({ cwd: repo, purpose: '../../escape/me now', at: new Date(2026, 8, 12, 1, 2, 3), root });
    assert.equal(created.ok, true, created.error ?? '');
    assert.equal(created.name, 'Crew_20260912_010203_escape-me-now');
    assert.equal(resolve(created.worktreePath).startsWith(resolve(root)), true, 'the worktree stays under its root');
    await cleanupIsolatedWorkspace({ worktreePath: created.worktreePath });
  } finally {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

// The name is chosen before anything is created, so two jobs starting in the
// same second would both see it free and one would lose the race on
// `git worktree add`. Reserving the directory makes the choice atomic.
maybe('concurrent jobs in the same second each get their own worktree', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-crew-race-repo-'));
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-race-root-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });

    const at = new Date(2026, 8, 12, 18, 30, 45);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => createIsolatedWorkspace({ cwd: repo, purpose: 'worker', at, root })),
    );
    assert.equal(results.filter((r) => r.ok).length, 6, results.map((r) => r.error ?? 'ok').join(' | '));
    const names = results.map((r) => r.name);
    assert.equal(new Set(names).size, names.length, `names must be unique: ${names.join(', ')}`);
    // The winner of the race is whichever mkdir landed first, so the bare name is
    // somewhere in the set rather than necessarily first.
    assert.ok(names.includes('Crew_20260912_183045_worker'), `expected the bare name among: ${names.join(', ')}`);
    assert.ok(names.every((n) => /^Crew_20260912_183045_worker(-\d+)?$/.test(n)), `every name keeps the shape: ${names.join(', ')}`);
    for (const r of results) await cleanupIsolatedWorkspace({ worktreePath: r.worktreePath });
  } finally {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
