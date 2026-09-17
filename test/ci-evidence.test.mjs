// The readiness matrix is deliberately inert, so platform rows stay NOT_RUN
// until a higher layer supplies evidence. This is that layer, and its whole job
// is to be impossible to fool: a row may only go green for a green run at the
// exact commit being validated. Every case below is a way that could go wrong.
//
// Run with: node --test test/ci-evidence.test.mjs

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadCiEvidence, clearCiEvidenceCache } from '../src/ci-evidence.mjs';

const SHA = 'a46ba6540e31f3012ad37379414c97362be88539';
const REPO = 'Ran-sh/dsh-crew';

// A stand-in for api.github.com that only answers the URLs this module builds.
function fakeApi({
  tagType = 'commit',
  tagSha = SHA,
  tagStatus = 200,
  runs = [{ id: 35101355507, name: 'CI', conclusion: 'success', event: 'push', head_repository: { full_name: REPO } }],
  jobs = [
    { name: 'deterministic', conclusion: 'success', labels: ['ubuntu-latest'] },
    { name: 'windows-paths', conclusion: 'success', labels: ['windows-latest'] },
  ],
  runsStatus = 200,
  jobsStatus = 200,
  throwOn = null,
} = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (throwOn && String(url).includes(throwOn)) throw new Error('network down');
    if (String(url).includes('/git/ref/tags/')) {
      return { status: tagStatus, json: async () => ({ object: { type: tagType, sha: tagSha } }) };
    }
    if (String(url).includes('/git/tags/')) {
      return { status: 200, json: async () => ({ object: { sha: SHA } }) };
    }
    if (String(url).includes('/actions/runs/') && String(url).includes('/jobs')) {
      return { status: jobsStatus, json: async () => ({ jobs }) };
    }
    if (String(url).includes('/actions/runs?')) {
      return { status: runsStatus, json: async () => ({ workflow_runs: runs }) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchImpl, calls };
}

beforeEach(() => clearCiEvidenceCache());

test('a green run at the tagged commit evidences both platform rows', async () => {
  const { fetchImpl } = fakeApi();
  const evidence = await loadCiEvidence({ version: '2.1.5', fetchImpl, repo: REPO });

  assert.equal(evidence.linux_deterministic.status, 'PASS');
  assert.equal(evidence.linux_deterministic.reason_code, 'CI_GREEN');
  assert.equal(evidence.linux_deterministic.evidence_source, 'github-actions');
  assert.equal(evidence.windows_regressions.status, 'PASS');

  // The commit is part of the reference: version -> tag -> commit is a mapping,
  // and the reader has to be able to audit which commit the green run covered.
  assert.match(evidence.linux_deterministic.evidence_ref, /@a46ba6540e31/);
  assert.match(evidence.linux_deterministic.evidence_ref, /run-35101355507/);
  assert.match(evidence.linux_deterministic.evidence_ref, /ubuntu-latest/);
  assert.match(evidence.windows_regressions.evidence_ref, /windows-latest/);
});

test('macos_smoke is evidenced by the macOS job, and absent when that job is missing', async () => {
  const { fetchImpl } = fakeApi({
    jobs: [
      { name: 'deterministic', conclusion: 'success', labels: ['ubuntu-latest'] },
      { name: 'macos-smoke', conclusion: 'success', labels: ['macos-latest'] },
    ],
  });
  const evidence = await loadCiEvidence({ version: '2.1.5', fetchImpl, repo: REPO });
  assert.equal(evidence.macos_smoke.status, 'PASS');
  assert.match(evidence.macos_smoke.evidence_ref, /macos-latest/);

  // A workflow without the job cannot evidence the row; it must not be inferred
  // from another platform's run.
  clearCiEvidenceCache();
  const withoutJob = fakeApi(); // default fixture has only linux + windows jobs
  const second = await loadCiEvidence({ version: '2.1.5', fetchImpl: withoutJob.fetchImpl, repo: REPO });
  assert.equal(Object.hasOwn(second, 'macos_smoke'), false);
});

test('an annotated tag is dereferenced to the commit it points at', async () => {
  const { fetchImpl, calls } = fakeApi({ tagType: 'tag', tagSha: 'tag-object-sha' });
  const evidence = await loadCiEvidence({ version: '2.1.5', fetchImpl, repo: REPO });
  assert.equal(evidence.linux_deterministic.status, 'PASS');
  assert.ok(calls.some((u) => u.includes('/git/tags/tag-object-sha')));
});

test('a failing platform job produces no row for it', async () => {
  const { fetchImpl } = fakeApi({
    jobs: [
      { name: 'deterministic', conclusion: 'success', labels: ['ubuntu-latest'] },
      { name: 'windows-paths', conclusion: 'failure', labels: ['windows-latest'] },
    ],
  });
  const evidence = await loadCiEvidence({ version: '2.1.5', fetchImpl, repo: REPO });
  assert.equal(evidence.linux_deterministic.status, 'PASS');
  assert.equal(Object.hasOwn(evidence, 'windows_regressions'), false, 'a red job must never evidence a row');
});

test('a cancelled or skipped job produces no row', async () => {
  for (const conclusion of ['cancelled', 'skipped', 'neutral', null]) {
    clearCiEvidenceCache();
    const { fetchImpl } = fakeApi({
      jobs: [
        { name: 'deterministic', conclusion, labels: ['ubuntu-latest'] },
        { name: 'windows-paths', conclusion: 'success', labels: ['windows-latest'] },
      ],
    });
    const evidence = await loadCiEvidence({ version: '2.1.5', fetchImpl, repo: REPO });
    assert.equal(Object.hasOwn(evidence, 'linux_deterministic'), false, `conclusion=${conclusion}`);
    assert.equal(evidence.windows_regressions.status, 'PASS');
  }
});

test('one platform failing does not withdraw another platform evidence', async () => {
  // The run is red overall, but the ubuntu job did pass and that is what the
  // linux row asks about. Coupling the rows to the run's aggregate conclusion
  // would let a single flaky platform blank the whole CI section.
  const { fetchImpl } = fakeApi({
    runs: [{ id: 7, name: 'CI', conclusion: 'failure', event: 'push', head_repository: { full_name: REPO } }],
    jobs: [
      { name: 'deterministic', conclusion: 'success', labels: ['ubuntu-latest'] },
      { name: 'macos-smoke', conclusion: 'failure', labels: ['macos-latest'] },
    ],
  });
  const evidence = await loadCiEvidence({ version: '2.1.5', fetchImpl, repo: REPO });
  assert.equal(evidence.linux_deterministic.status, 'PASS');
  assert.equal(Object.hasOwn(evidence, 'macos_smoke'), false);
});

test('a commit with no CI run at all evidences nothing', async () => {
  const { fetchImpl } = fakeApi({ runs: [{ id: 1, name: 'Publish', conclusion: 'success', event: 'push', head_repository: { full_name: REPO } }] });
  assert.deepEqual(await loadCiEvidence({ version: '2.1.5', fetchImpl, repo: REPO }), {});
});

// A job *name* is not a platform. Matching on the name alone let a job called
// `deterministic` that ran on a macOS runner mint `linux_deterministic: PASS`,
// with the mismatch visible only in a display string.
test('a job whose runner is not the platform its row claims evidences nothing', async () => {
  const { fetchImpl } = fakeApi({
    jobs: [
      { name: 'deterministic', conclusion: 'success', labels: ['macos-latest'] },
      { name: 'macos-smoke', conclusion: 'success', labels: ['ubuntu-latest'] },
    ],
  });
  const evidence = await loadCiEvidence({ version: '2.1.5', fetchImpl, repo: REPO });
  assert.equal(Object.hasOwn(evidence, 'linux_deterministic'), false, 'a macOS runner must not evidence the linux row');
  assert.equal(Object.hasOwn(evidence, 'macos_smoke'), false, 'nor an ubuntu runner the macOS row');
});

test('a job with no runner labels at all evidences nothing', async () => {
  const { fetchImpl } = fakeApi({ jobs: [{ name: 'deterministic', conclusion: 'success' }] });
  const evidence = await loadCiEvidence({ version: '2.1.5', fetchImpl, repo: REPO });
  assert.equal(Object.hasOwn(evidence, 'linux_deterministic'), false, 'an unlabelled job proves no platform');
});

test('a run this repository did not push is not evidence', async () => {
  // A pull request carries its own workflow file, so a PR run can define a
  // passing job of any name.
  clearCiEvidenceCache();
  const pr = fakeApi({ runs: [{ id: 9, name: 'CI', conclusion: 'success', event: 'pull_request', head_repository: { full_name: REPO } }] });
  assert.deepEqual(await loadCiEvidence({ version: '2.1.5', fetchImpl: pr.fetchImpl, repo: REPO }), {});

  clearCiEvidenceCache();
  const fork = fakeApi({ runs: [{ id: 10, name: 'CI', conclusion: 'success', event: 'push', head_repository: { full_name: 'attacker/dsh-crew' } }] });
  assert.deepEqual(await loadCiEvidence({ version: '2.1.5', fetchImpl: fork.fetchImpl, repo: REPO }), {}, 'a fork run is not this repository');
});

test('an untagged version evidences nothing: the code is not what CI validated', async () => {
  const { fetchImpl } = fakeApi({ tagStatus: 404 });
  assert.deepEqual(await loadCiEvidence({ version: '9.9.9', fetchImpl, repo: REPO }), {});
});

test('a missing or unknown version evidences nothing', async () => {
  const { fetchImpl } = fakeApi();
  assert.deepEqual(await loadCiEvidence({ fetchImpl, repo: REPO }), {});
  assert.deepEqual(await loadCiEvidence({ version: '', fetchImpl, repo: REPO }), {});
  assert.deepEqual(await loadCiEvidence({ version: '   ', fetchImpl, repo: REPO }), {});
});

test('network failure, an HTTP error, and a non-JSON body all fail closed', async () => {
  assert.deepEqual(await loadCiEvidence({ version: '2.1.5', repo: REPO, fetchImpl: async () => { throw new Error('offline'); } }), {});
  assert.deepEqual(await loadCiEvidence({ version: '2.1.5', repo: REPO, fetchImpl: fakeApi({ runsStatus: 500 }).fetchImpl }), {});
  assert.deepEqual(await loadCiEvidence({ version: '2.1.5', repo: REPO, fetchImpl: fakeApi({ jobsStatus: 403 }).fetchImpl }), {});
  assert.deepEqual(
    await loadCiEvidence({ version: '2.1.5', repo: REPO, fetchImpl: async () => ({ status: 200, json: async () => { throw new Error('bad json'); } }) }),
    {},
  );
  assert.deepEqual(await loadCiEvidence({ version: '2.1.5', repo: REPO, fetchImpl: null }), {});
});

test('a stalled endpoint is abandoned at the deadline rather than hanging the readiness route', async () => {
  const started = Date.now();
  const evidence = await loadCiEvidence({
    version: '2.1.5',
    repo: REPO,
    timeoutMs: 60,
    fetchImpl: () => new Promise(() => {}), // never resolves
  });
  assert.deepEqual(evidence, {});
  assert.ok(Date.now() - started < 2000, 'the whole chain must be bounded by one deadline');
});

test('evidence is memoized so the readiness route does not re-fetch on every read', async () => {
  const { fetchImpl, calls } = fakeApi();
  await loadCiEvidence({ version: '2.1.5', fetchImpl, repo: REPO });
  const afterFirst = calls.length;
  await loadCiEvidence({ version: '2.1.5', fetchImpl, repo: REPO });
  assert.equal(calls.length, afterFirst, 'the second read must be served from cache');
});

test('a negative result is not cached for the full window', async () => {
  // One transient failure must not freeze a row at NOT_RUN for ten minutes.
  const { fetchImpl, calls } = fakeApi({ tagStatus: 404 });
  const t0 = 1_000_000;
  await loadCiEvidence({ version: '9.9.9', fetchImpl, repo: REPO, now: () => t0 });
  const afterFirst = calls.length;
  assert.ok(afterFirst > 0, 'precondition: it did ask');

  await loadCiEvidence({ version: '9.9.9', fetchImpl, repo: REPO, now: () => t0 + 30_000 });
  assert.equal(calls.length, afterFirst, 'inside the negative TTL it stays cached');

  await loadCiEvidence({ version: '9.9.9', fetchImpl, repo: REPO, now: () => t0 + 61_000 });
  assert.ok(calls.length > afterFirst, 'past the negative TTL it must ask again');
});

test('a credential-less result is not served to a call that offers a token', async () => {
  const anon = fakeApi();
  await loadCiEvidence({ version: '2.1.5', fetchImpl: anon.fetchImpl, repo: REPO });
  const withToken = fakeApi();
  const evidence = await loadCiEvidence({ version: '2.1.5', fetchImpl: withToken.fetchImpl, repo: REPO, token: 'tok' });
  assert.equal(evidence.linux_deterministic.status, 'PASS');
  assert.ok(withToken.calls.length > 0, 'the token-bearing call must not reuse the anonymous cache entry');
});

test('a token is forwarded when offered and never required', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init?.headers?.authorization ?? null);
    return fakeApi().fetchImpl(url, init);
  };
  await loadCiEvidence({ version: '2.1.5', repo: REPO, fetchImpl, token: 'tok' });
  assert.ok(seen.every((h) => h === 'Bearer tok'));
  assert.ok(!seen.some((h) => h === null));

  clearCiEvidenceCache();
  const anonymous = [];
  const anonFetch = async (url, init) => {
    anonymous.push(init?.headers?.authorization ?? null);
    return fakeApi().fetchImpl(url, init);
  };
  const evidence = await loadCiEvidence({ version: '2.1.5', repo: REPO, fetchImpl: anonFetch });
  assert.equal(evidence.linux_deterministic.status, 'PASS', 'a public repo needs no credential');
  assert.ok(anonymous.every((h) => h === null), 'no authorization header when no token is given');
});
