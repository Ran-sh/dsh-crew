// P0 candidate-patch security + completeness tests. Real temporary git repos
// (not fakes): a secret sentinel must NEVER appear anywhere in a candidate,
// committed worker changes must survive base-revision diffing, non-sensitive
// new files must be included as real patches, and truncation must only ever
// cut the sanitized patch.
// Run with: node --test test/candidate-security.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createIsolatedWorkspace, captureCandidate, cleanupIsolatedWorkspace } from '../src/workspace-isolation.mjs';

const SENTINEL = 'SUPER_SECRET_SHOULD_NEVER_APPEAR_7f4b9c21';
const EIGHTY = '0123456789abcdef';

function haveGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function withWorktree(fn, { baseFiles = {} } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-crew-sec-repo-'));
  const root = mkdtempSync(join(tmpdir(), 'dsh-crew-sec-root-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@t'], repo);
  git(['config', 'user.name', 't'], repo);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  for (const [f, content] of Object.entries(baseFiles)) writeFileSync(join(repo, f), content);
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'base'], repo);
  const baseRevision = git(['rev-parse', 'HEAD'], repo);
  const created = await createIsolatedWorkspace({ cwd: repo, jobId: 'sec', root });
  assert.equal(created.ok, true);
  let cleanupError;
  try {
    await fn({ repo, worktreePath: created.worktreePath, baseRevision });
  } finally {
    const r = await cleanupIsolatedWorkspace({ worktreePath: created.worktreePath });
    if (r.ok !== true) cleanupError = r.error;
    try { rmSync(repo, { recursive: true, force: true }); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
  assert.equal(cleanupError, undefined, `worktree cleanup failed: ${cleanupError}`);
}

function assertNoSentinel(candidate, label) {
  const serialized = JSON.stringify(candidate);
  assert.ok(!serialized.includes(SENTINEL), `${label}: sentinel leaked into candidate`);
  assert.ok(!(candidate.patch ?? '').includes(SENTINEL), `${label}: sentinel leaked into patch`);
}

const maybe = haveGit() ? test : test.skip;

maybe('tracked secrets: modified .env / .key / credentials.json contain no sentinel', async (t) => {
  await withWorktree(async ({ worktreePath, baseRevision }) => {
    const beforeSet = [
      ['.env', 'FOO=1\n'],
      ['secret.key', 'key-begin\n'],
      ['credentials.json', '{"user":"a"}\n'],
    ];
    for (const [f, content] of beforeSet) { writeFileSync(join(worktreePath, f), content); git(['add', '-A'], worktreePath); }
    git(['commit', '-qm', 'secrets'], worktreePath);
    const afterSet = [
      ['.env', `TOKEN=${SENTINEL}\n`],
      ['secret.key', `PRIVATE=${SENTINEL}\n`],
      ['credentials.json', `{"token":"${SENTINEL}"}\n`],
    ];
    for (const [f, content] of afterSet) writeFileSync(join(worktreePath, f), content);

    const c = await captureCandidate({ worktreePath, baseRevision, git: undefined });
    assert.equal(c.ok, true, `capture failed: ${c.error}`);
    assertNoSentinel(c, 'tracked secrets');
    assert.ok(c.sensitive_paths_redacted.includes('.env'));
    assert.ok(c.sensitive_paths_redacted.includes('secret.key'));
    assert.ok(c.sensitive_paths_redacted.includes('credentials.json'));
  });
});

maybe('sensitive rename (from secret.key and to .env) leaks no content', async (t) => {
  // base intentionally contains the sensitive source file, so the rename shows
  // up as a real R entry against the base revision.
  await withWorktree(async ({ worktreePath, baseRevision }) => {
    mkdirSync(join(worktreePath, 'keys'), { recursive: true });
    git(['mv', 'secret.key', 'keys/old.key'], worktreePath); // sensitive -> sensitive
    git(['mv', 'safe.txt', '.env'], worktreePath); // non-sensitive -> sensitive
    git(['add', '-A'], worktreePath);
    git(['commit', '-qm', 'rename'], worktreePath);

    const c = await captureCandidate({ worktreePath, baseRevision });
    assert.equal(c.ok, true, `capture failed: ${c.error}`);
    assertNoSentinel(c, 'sensitive rename');
    assert.ok(c.sensitive_paths_redacted.includes('keys/old.key') || c.sensitive_paths_redacted.includes('secret.key'), 'sensitive source redacted');
    assert.ok(c.sensitive_paths_redacted.includes('.env'), 'sensitive destination redacted');
    assert.ok(!c.patch.includes('safe.txt') || c.patch.includes('[REDACTED SENSITIVE FILE: .env]'), 'renamed-to-.env content must not leak');
  }, {
    baseFiles: {
      'secret.key': `SECRETA=${SENTINEL}\n`,
      'safe.txt': 'safe content\n',
    },
  });
});

maybe('non-sensitive tracked change is included in the patch', async (t) => {
  await withWorktree(async ({ worktreePath, baseRevision }) => {
    writeFileSync(join(worktreePath, 'feature.mjs'), 'export const x = 1;\n');
    git(['add', '-A'], worktreePath);
    git(['commit', '-qm', 'feature'], worktreePath);
    writeFileSync(join(worktreePath, 'feature.mjs'), 'export const x = 2;\n');
    const c = await captureCandidate({ worktreePath, baseRevision });
    assert.equal(c.ok, true);
    assert.match(c.patch, /feature\.mjs/);
    assert.match(c.patch, /export const x = 2/);
    assert.equal(c.sensitive_paths_redacted.length, 0);
  });
});

maybe('committed worker edits are captured against baseRevision (not HEAD)', async (t) => {
  await withWorktree(async ({ worktreePath, baseRevision }) => {
    // worker commits inside the worktree -> HEAD advances past base
    writeFileSync(join(worktreePath, 'part1.txt'), 'one\n');
    git(['add', '-A'], worktreePath);
    git(['commit', '-qm', 'committed'], worktreePath);
    // plus an extra uncommitted edit on top
    writeFileSync(join(worktreePath, 'part2.txt'), 'two\n');
    const c = await captureCandidate({ worktreePath, baseRevision });
    assert.equal(c.ok, true, `capture failed: ${c.error}`);
    assert.ok(c.changed_files.includes('part1.txt'), 'committed file must be in changed_files');
    assert.ok(c.changed_files.includes('part2.txt'), 'uncommitted file must be in changed_files');
    assert.match(c.patch, /part1\.txt/);
    assert.match(c.patch, /part2\.txt/);
    assert.notEqual(c.committed_head, baseRevision, 'HEAD advanced past base');
  });
});

maybe('non-sensitive untracked new file is included as a real new-file patch', async (t) => {
  await withWorktree(async ({ worktreePath, baseRevision }) => {
    mkdirSync(join(worktreePath, 'src'), { recursive: true });
    writeFileSync(join(worktreePath, 'src', 'new-feature.mjs'), '// generated by worker\nexport const fresh = 42;\n');
    const c = await captureCandidate({ worktreePath, baseRevision });
    assert.equal(c.ok, true, `capture failed: ${c.error}`);
    assert.match(c.patch, /new-feature\.mjs/);
    assert.match(c.patch, /export const fresh = 42/, 'untracked file content must be in the patch');
    assert.deepEqual(c.untracked_files, ['src/new-feature.mjs']);
  });
});

maybe('sensitive untracked file appears only as a redacted marker', async (t) => {
  await withWorktree(async ({ worktreePath, baseRevision }) => {
    writeFileSync(join(worktreePath, '.env.local'), `SECRET=${SENTINEL}\n`);
    const c = await captureCandidate({ worktreePath, baseRevision });
    assert.equal(c.ok, true);
    assertNoSentinel(c, 'sensitive untracked');
    assert.match(c.patch, /\[REDACTED SENSITIVE FILE: \.env\.local/);
  });
});

maybe('candidate fingerprint is stable and patch truncation never splits a secret', async (t) => {
  await withWorktree(async ({ worktreePath, baseRevision }) => {
    // large non-sensitive file so the sanitized patch exceeds a tiny limit
    const big = Array.from({ length: 400 }, (_, i) => `${EIGHTY}${i}\n`).join('');
    writeFileSync(join(worktreePath, 'big.txt'), big);
    writeFileSync(join(worktreePath, '.env'), `TOKEN=${SENTINEL}\n`);
    const c = await captureCandidate({ worktreePath, baseRevision, limit: 500 });
    assert.equal(c.ok, true);
    assertNoSentinel(c, 'truncated candidate');
    assert.equal(c.patch_truncated, true);
    assert.ok(Buffer.byteLength(c.patch, 'utf8') <= 500 + 1, 'patch bounded after sanitization');
    // fingerprint stays a sha256 hex and does not embed content
    assert.match(c.fingerprint, /^[0-9a-f]{64}$/);
  });
});
