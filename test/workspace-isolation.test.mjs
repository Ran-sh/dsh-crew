// PR3 git-worktree isolation tests: injectable-git unit coverage for the
// lifecycle (create / capture / cleanup / prune) and a real temp-repo
// integration check. Windows-safe paths only — no shell string building.
// Run with: node --test test/workspace-isolation.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
  reserveWorktreeDir,
  unownedWorktrees,
} from '../src/workspace-isolation.mjs';

const REV = 'abc123';
const WORKTREE = join(tmpdir(), 'dsh-crew-wt-test-00000000');

function fakeRunner(rules) {
  const calls = [];
  const runner = async (args, { cwd } = {}) => {
    calls.push({ args, cwd });
    const key = args.join(' ');
    const rule = rules.find((r) => r.pat.test(key));
    if (!rule) return { code: 1, stdout: '', stderr: `unsupported: ${key}` };
    if (typeof rule.out === 'function') return rule.out(calls, cwd);
    return { code: rule.out.code ?? 0, stdout: rule.out.stdout ?? '', stderr: rule.out.stderr ?? '' };
  };
  return { runner, calls };
}

// The filesystem fallback force-deletes what it adopts, so it asks git which
// repository a directory belongs to. A fixture that wants the fallback to run
// has to answer that question, and answer it the same way for both paths.
const REPO = resolve('/repo');
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

// Git reports the spelling it resolved when a worktree was added, which on
// Windows can turn an 8.3 temp name (`RUNNER~1`) into its long form. Compare the
// way the source does, through the filesystem, or the assertion fails on a
// machine whose temp directory is spelled the short way.
const canon = (value) => {
  const resolved = resolve(value);
  try { return realpathSync.native ? realpathSync.native(resolved) : realpathSync(resolved); }
  catch { return resolved; }
};

/**
 * The 8.3 alias Windows keeps for a directory, or null when it has none. `for`
 * has to be given the path unquoted for `%~sI` to expand it, so paths with
 * spaces are not worth the fragility here.
 */
function windowsShortName(path) {
  if (process.platform !== 'win32' || /\s/.test(path)) return null;
  try {
    const out = execFileSync('cmd', ['/c', `for %I in (${path}) do @echo %~sI`], { encoding: 'utf8' }).trim();
    const value = out.split(/\r?\n/).pop().trim();
    return value && value !== path ? value : null;
  } catch { return null; }
}

const SAME_REPO = {
  pat: /^rev-parse --path-format=absolute --git-common-dir$/,
  out: { stdout: '/repo/.git\n' },
};
// A directory that is a real worktree — but of a different repository. The
// comparison has to go through the same resolution the source uses: on Windows
// the repo root is D:\repo, not /repo.
const OTHER_REPO = {
  pat: /^rev-parse --path-format=absolute --git-common-dir$/,
  out: (_calls, cwd) => ({ stdout: samePath(cwd, REPO) ? '/repo/.git\n' : '/elsewhere/.git\n' }),
};

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

// The defect this guards: a nonzero `git worktree add` does not mean git did
// nothing — a failing post-checkout hook used to leave the worktree registered
// and populated. Deleting only the directory stranded that registration, and
// every later attempt on the same name then failed with nothing to explain why.
test('a failed creation unregisters the worktree before releasing the name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-failcreate-'));
  try {
    const { runner, calls } = fakeRunner([
      { pat: /^rev-parse --show-toplevel$/, out: { stdout: '/repo\n' } },
      { pat: /^rev-parse HEAD$/, out: { stdout: `${REV}\n` } },
      { pat: /^worktree add /, out: { code: 128, stderr: 'fatal: could not resolve HEAD\n' } },
      // `worktree remove --force` is the path that deletes registration and
      // directory together, so the fake has to delete too.
      {
        pat: /^worktree remove --force /,
        out: (calls) => {
          const remove = calls.filter((x) => x.args[0] === 'worktree' && x.args[1] === 'remove').pop();
          rmSync(remove.args[3], { recursive: true, force: true });
          return { code: 0 };
        },
      },
      { pat: /^worktree list --porcelain$/, out: { stdout: 'worktree /repo\nHEAD abc123\n\n' } },
    ]);
    const c = await createIsolatedWorkspace({ cwd: '/repo', root, git: runner });
    assert.equal(c.ok, false);
    assert.equal(c.cleanupBlocked, undefined, 'a clean release is not reported as blocked');
    const add = calls.find((x) => x.args[0] === 'worktree' && x.args[1] === 'add');
    const remove = calls.find((x) => x.args[0] === 'worktree' && x.args[1] === 'remove');
    assert.ok(remove, 'the registration is removed explicitly');
    assert.equal(existsSync(add.args[3]), false, 'the reservation directory is released');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed creation reports a stranded registration instead of pretending the name was released', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-stranded-'));
  try {
    let reserved = null;
    const { runner } = fakeRunner([
      { pat: /^rev-parse --show-toplevel$/, out: { stdout: '/repo\n' } },
      { pat: /^rev-parse HEAD$/, out: { stdout: `${REV}\n` } },
      {
        pat: /^worktree add /,
        // A failing post-checkout hook: git registers the worktree and populates
        // it before the command exits nonzero.
        out: (calls) => {
          reserved = calls.find((x) => x.args[0] === 'worktree' && x.args[1] === 'add').args[3];
          writeFileSync(join(reserved, 'worker-output.txt'), 'work in progress');
          return { code: 128, stderr: 'fatal: could not resolve HEAD\n' };
        },
      },
      // The unregister itself fails, as it does under a transient Windows lock.
      { pat: /^worktree remove --force /, out: { code: 128, stderr: 'fatal: unable to delete: permission denied\n' } },
      // git still considers the name taken, which is what makes a retry fail.
      { pat: /^worktree list --porcelain$/, out: () => ({ stdout: `worktree /repo\nHEAD ${REV}\n\nworktree ${reserved}\nHEAD ${REV}\ndetached\n\n` }) },
    ]);
    const c = await createIsolatedWorkspace({ cwd: '/repo', root, git: runner });
    assert.equal(c.ok, false);
    assert.equal(c.cleanupBlocked, true, 'a stranded registration is surfaced, not hidden');
    assert.ok(reserved, 'the reservation was attempted');
    assert.equal(existsSync(join(reserved, 'worker-output.txt')), true, 'no files are discarded while git still tracks them');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    { pat: /^worktree list --porcelain$/, out: { stdout: `worktree /repo\nHEAD abc123\n\nworktree ${WORKTREE}\nHEAD ${REV}\n` } },
    { pat: /^worktree remove --force /, out: { stdout: '' } },
  ]);
  const r = await cleanupIsolatedWorkspace({ worktreePath: WORKTREE, git: runner });
  assert.equal(r.ok, true);
  assert.equal(r.removed, true);
  assert.ok(calls.some((x) => x.args[0] === 'worktree' && x.args[1] === 'remove'));
});

test('cleanupIsolatedWorkspace reports a locked worktree instead of hiding it', async () => {
  const { runner } = fakeRunner([
    { pat: /^worktree remove --force /, out: { code: 128, stderr: 'fatal: Unable to delete ... permission denied\n' } },
    { pat: /^worktree list --porcelain$/, out: { stdout: `worktree /repo\nHEAD ${REV}\n\nworktree ${WORKTREE}\nHEAD ${REV}\n\n` } },
  ]);
  const r = await cleanupIsolatedWorkspace({ worktreePath: WORKTREE, git: runner, backoffMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WORKTREE_LOCKED);
  assert.equal(r.cleanupBlocked, true);
});

test('cleanupIsolatedWorkspace retries a transient lock and recovers', async () => {
  const { runner, calls } = fakeRunner([
    { pat: /^worktree list --porcelain$/, out: { stdout: `worktree /repo\nHEAD abc123\n\nworktree ${WORKTREE}\nHEAD ${REV}\n` } },
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
    SAME_REPO,
    { pat: /^worktree remove --force /, out: { code: 128, stderr: 'fatal: unknown switch `x`\n' } },
    { pat: /^worktree list --porcelain$/, out: { stdout: `worktree /repo\nHEAD ${REV}\n\nworktree ${WORKTREE}\nHEAD ${REV}\ndetached\n\n` } },
  ]);
  const r = await cleanupIsolatedWorkspace({ worktreePath: WORKTREE, git: runner, backoffMs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WORKTREE_LOCKED);
  assert.equal(r.cleanupBlocked, true);
  assert.match(r.error, /still registered/);
  assert.ok(calls.some((x) => x.args[0] === 'worktree' && x.args[1] === 'list'), 'registration verification ran');
});

test('cleanupIsolatedWorkspace verified fallback success when registration and directory are gone', async () => {
  const prefix = join(mkdtempSync(join(tmpdir(), 'dsh-crew-fb-')), 'dsh-crew-fallback-00000000');
  try {
    mkdirSync(prefix, { recursive: true });
    writeFileSync(join(prefix, 'keep.txt'), 'x');
    const { runner } = fakeRunner([
      SAME_REPO,
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

// A name that matches the legacy grammar is exactly what a user might pick by
// accident, so the fallback must not treat the name as proof of ownership. An
// earlier revision did, and a directory belonging to an unrelated repository
// would have been force-deleted for resembling Crew's.
// Windows gives some directories an 8.3 alias (`C:\PROGRA~3`), and git records
// the long form when it resolves a path it was handed. So the same location
// arrives spelled two ways, and comparing the strings — even lower-cased —
// treats a live worktree as a leftover. A report of "unowned" is enough to put
// it in front of an operator as cleanup, so the path has to be recognised.
//
// The leaf must exist for the spelling to be resolvable at all, which is why
// this creates one: a path that does not exist cannot be canonicalised, and a
// fixture that never touches the disk would pass for the wrong reason.
test('an 8.3 alias and its long form are the same worktree', async (t) => {
  const name = `Crew_20260912_233000_alias-2`;
  const candidate = ['C:\\ProgramData', tmpdir(), 'C:\\Program Files']
    .map((root) => ({ long: canon(root), short: windowsShortName(root) }))
    .find((entry) => entry.short && canon(entry.short) === entry.long && entry.short !== entry.long);
  if (!candidate) return t.skip('this machine gives no writable directory an 8.3 alias');

  const created = join(candidate.long, name);
  try {
    mkdirSync(created, { recursive: true });
  } catch {
    return t.skip(`cannot create under the aliased directory ${candidate.long}`);
  }
  try {
    const { runner } = fakeRunner([
      { pat: /^rev-parse --show-toplevel$/, out: { stdout: '/repo\n' } },
      { pat: /^rev-parse HEAD$/, out: { stdout: `${REV}\n` } },
      { pat: /^worktree list --porcelain$/, out: { stdout: `worktree /repo\nHEAD ${REV}\n\nworktree ${created}\nHEAD ${REV}\ndetached\n\n` } },
    ]);
    // Git reports the long spelling; the caller knows the worktree by the short one.
    const allowed = [join(candidate.short, name)];
    assert.notEqual(allowed[0], created, 'the fixture really does use two spellings');
    assert.deepEqual(
      await staleWorktrees({ git: runner, allowed }),
      [],
      'an allowed worktree is not stale just because the path is spelled differently',
    );
    // It must not merely fall through to the other list either: a path that misses
    // the allowed set is reported as unowned, which is just as wrong — this is
    // Crew's own live worktree, not a leftover.
    assert.deepEqual(
      await unownedWorktrees({ git: runner, allowed }),
      [],
      'it is recognised as the allowed worktree, not reclassified as a leftover',
    );
  } finally {
    rmSync(created, { recursive: true, force: true });
  }
});

// The defect this guards: the fallback deleted the directory first and asked git
// afterwards. For a worktree git still tracks — the realistic case, where
// `worktree remove` failed on a transient lock — that destroyed the files and
// then reported the registration stranded, which is the opposite of the request.
// The provenance check has to pass here, or the test proves nothing: an earlier
// version of this fixture omitted the common-dir rule, so `sameRepository`
// returned false and the file survived for an unrelated reason.
test('a still-registered worktree keeps its files when git refuses to remove it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-reg-'));
  const dir = join(root, 'dsh-crew-wf-locked-11111111');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'work.txt'), 'still needed');
    const { runner } = fakeRunner([
      SAME_REPO,
      { pat: /^worktree remove --force /, out: { code: 128, stderr: 'fatal: unable to delete: permission denied\n' } },
      { pat: /^worktree list --porcelain$/, out: { stdout: `worktree /repo\nHEAD ${REV}\n\nworktree ${dir}\nHEAD ${REV}\ndetached\n\n` } },
    ]);
    const r = await cleanupIsolatedWorkspace({ worktreePath: dir, repoRoot: '/repo', git: runner, backoffMs: 0, reservation: true });
    assert.equal(r.ok, false);
    assert.equal(r.cleanupBlocked, true);
    assert.match(r.error, /still registered/);
    assert.equal(existsSync(join(dir, 'work.txt')), true, 'files of a still-registered worktree are never discarded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanupIsolatedWorkspace refuses an identically named worktree of another repository', async () => {
  const prefix = join(mkdtempSync(join(tmpdir(), 'dsh-crew-fb2-')), 'dsh-crew-backup-deadbeef');
  try {
    mkdirSync(prefix, { recursive: true });
    writeFileSync(join(prefix, 'precious.txt'), 'not Crew data');
    const { runner } = fakeRunner([
      OTHER_REPO,
      { pat: /^worktree remove --force /, out: { code: 128, stderr: 'fatal: not a working tree\n' } },
      { pat: /^worktree list --porcelain$/, out: { stdout: 'worktree /repo\nHEAD abc123\n\n' } },
    ]);
    const r = await cleanupIsolatedWorkspace({ worktreePath: prefix, git: runner, backoffMs: 0 });
    assert.equal(r.ok, false, 'must not claim success');
    assert.equal(r.cleanupBlocked, true);
    assert.match(r.error, /not a worktree of/);
    assert.equal(existsSync(join(prefix, 'precious.txt')), true, 'the directory survives');
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

// The reservation is this call's own empty directory: git never registered it,
// so there is no repository identity to check and nothing to lose by removing it.
test('cleanupIsolatedWorkspace releases an empty reservation it just made', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-resv-'));
  const dir = join(root, 'Crew_20260912_233000_worker');
  try {
    mkdirSync(dir);
    const { runner } = fakeRunner([
      { pat: /^worktree remove --force /, out: { code: 128, stderr: 'fatal: not a working tree\n' } },
      { pat: /^worktree list --porcelain$/, out: { stdout: 'worktree /repo\nHEAD abc123\n\n' } },
    ]);
    const r = await cleanupIsolatedWorkspace({ worktreePath: dir, repoRoot: '/repo', git: runner, backoffMs: 0, reservation: true });
    assert.equal(r.ok, true);
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanupIsolatedWorkspace refuses to fs-delete non-Crew-owned paths', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'user-ws-'));
  try {
    writeFileSync(join(prefix, 'data.txt'), 'keep');
    const { runner } = fakeRunner([
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
      out: { stdout: `worktree /repo\nHEAD ${REV}\n\nworktree ${WORKTREE}\nHEAD ${REV}\ndetached\n\nworktree ${join(tmpdir(), 'user-wt')}\nHEAD ${REV}\ndetached\n\n` },
    },
  ]);
  const stale = await staleWorktrees({ git: runner, allowed: [WORKTREE] });
  assert.ok(!stale.includes(WORKTREE), 'allowed worktree must not be stale');
  assert.equal(stale.length, 0, 'only dsh-crew-* worktrees outside allowed are stale');
});

// The defect this guards: `dsh-crew-backup-deadbeef` satisfies the legacy name
// grammar, so a basename check adopts it. Crew always creates its worktrees
// detached; a linked worktree that is on a branch is somebody else's, whatever
// it is called, and pruning it would destroy work that was never Crew's.
test('staleWorktrees does not adopt a branch worktree that merely matches the legacy name', async () => {
  const impostor = join(tmpdir(), 'dsh-crew-backup-deadbeef');
  const { runner } = fakeRunner([
    { pat: /^rev-parse --show-toplevel$/, out: { stdout: '/repo\n' } },
    { pat: /^rev-parse HEAD$/, out: { stdout: `${REV}\n` } },
    {
      pat: /^worktree list --porcelain$/,
      out: { stdout: `worktree /repo\nHEAD ${REV}\n\nworktree ${impostor}\nHEAD ${REV}\nbranch refs/heads/backup\n\n` },
    },
  ]);
  assert.equal(isCrewWorktreeName('dsh-crew-backup-deadbeef'), true, 'the name alone does match');
  assert.deepEqual(await staleWorktrees({ git: runner, allowed: [] }), [], 'but a branch worktree is not adopted');
});

test('staleWorktrees reports a legacy-named worktree instead of adopting it', async () => {
  const legacy = join(tmpdir(), 'dsh-crew-wf-abc123-1a2b3c4d');
  const { runner } = fakeRunner([
    { pat: /^rev-parse --show-toplevel$/, out: { stdout: '/repo\n' } },
    { pat: /^rev-parse HEAD$/, out: { stdout: `${REV}\n` } },
    {
      pat: /^worktree list --porcelain$/,
      out: { stdout: `worktree /repo\nHEAD ${REV}\n\nworktree ${legacy}\nHEAD ${REV}\ndetached\n\n` },
    },
  ]);
  // `detached` describes HEAD, not who created the tree, so it cannot on its own
  // license a delete. Without a record of Crew creating it, it is reported.
  assert.deepEqual(await staleWorktrees({ git: runner, allowed: [] }), []);
  assert.deepEqual(await unownedWorktrees({ git: runner, allowed: [] }), [legacy]);
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

// The property that matters: Crew must recognise every name Crew hands out.
// Asserting a handful of literals does not establish it — an earlier revision
// trimmed the sanitised purpose before truncating it, so a 31-character purpose
// ending in a separator produced a name that its own ownership check rejected,
// and the worktree it created could never be adopted again.
test('every name the reservation can produce is recognised as Crew-owned', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-nameprop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const at = new Date(2026, 8, 12, 23, 30, 0);
  const purposes = [
    'worker',
    'reviewer',
    '',
    '   ',
    '!!!',
    null,
    undefined,
    'a'.repeat(31) + '-b',
    'x-'.repeat(20),
    'a'.repeat(64),
    'role/with/slashes',
    'ümlaut',
    '123',
    'UPPER',
  ];
  for (const purpose of purposes) {
    // Same purpose and same second, so the later ones must take the collision
    // suffix — the form most likely to fall outside the grammar unnoticed.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reserved = reserveWorktreeDir({ root, purpose, at });
      assert.equal(reserved.ok, true, `reservation refused for ${JSON.stringify(purpose)}`);
      assert.equal(
        isCrewWorktreeName(reserved.name),
        true,
        `Crew cannot recognise a name it generated: ${reserved.name}`,
      );
    }
  }
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

// Retention has to recognise worktrees from before the rename as Crew's, or they
// would be adopted by nothing: not pruned, not cleaned, just accumulating in the
// temp directory forever. A user-created worktree must stay untouched.
maybe('prune removes only what Crew recorded creating', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-crew-mixed-repo-'));
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-mixed-root-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo });

    // Two Crew worktrees; the first stays active, the second is a leftover.
    const active = await createIsolatedWorkspace({ cwd: repo, purpose: 'worker', root });
    const leftover = await createIsolatedWorkspace({ cwd: repo, purpose: 'worker', root });
    assert.equal(active.ok, true, active.error ?? '');
    assert.equal(leftover.ok, true, leftover.error ?? '');
    assert.equal(active.owned, true, 'creation records its own worktree');

    // A worktree shaped like an older release, made by hand: Crew never recorded
    // creating it, so it is not Crew's to delete however it is named.
    const legacyPath = join(root, 'dsh-crew-wf-legacy-00000000');
    execFileSync('git', ['worktree', 'add', '--detach', legacyPath, 'HEAD'], { cwd: repo, stdio: 'ignore' });
    // And one the user made themselves, which is never Crew's to remove.
    const userPath = join(root, 'user-kept');
    execFileSync('git', ['worktree', 'add', '--detach', userPath, 'HEAD'], { cwd: repo, stdio: 'ignore' });

    const allowed = [active.worktreePath];
    assert.deepEqual((await staleWorktrees({ allowed })).map(canon), [canon(leftover.worktreePath)], 'only the recorded leftover is adoptable');
    assert.deepEqual((await unownedWorktrees({ allowed })).map(canon), [canon(legacyPath)], 'the hand-made one is reported, not adopted');
    // The repo's own directory starts with `dsh-crew-` here, which would match
    // the legacy prefix — but the main working tree is never a disposable
    // worktree, and treating it as one would put the cleanup path in a fight
    // with the repo itself.
    assert.equal((await staleWorktrees({ allowed })).includes(resolve(repo)), false, 'the main working tree is never stale');

    const pruned = await pruneWorktrees({ allowed });
    assert.equal(pruned.removed, 1, `exactly the recorded leftover goes: ${pruned.actions.join(' | ')}`);
    assert.equal(existsSync(leftover.worktreePath), false, 'the recorded leftover is pruned');
    assert.equal(existsSync(legacyPath), true, 'the unrecorded legacy worktree survives');
    assert.equal(existsSync(userPath), true, 'the user worktree survives');
    assert.equal(existsSync(active.worktreePath), true, 'the active worktree survives');
    assert.deepEqual(pruned.unowned.map(canon), [canon(legacyPath)]);
    await cleanupIsolatedWorkspace({ worktreePath: active.worktreePath });
    await cleanupIsolatedWorkspace({ worktreePath: userPath });
    await cleanupIsolatedWorkspace({ worktreePath: legacyPath, repoRoot: repo });
  } finally {
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
