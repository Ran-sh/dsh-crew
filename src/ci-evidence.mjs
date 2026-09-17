// Platform-validation evidence for the readiness matrix, loaded from the
// project's own CI runs.
//
// `readiness-matrix.mjs` is deliberately inert — it never reads files, GitHub or
// the network — and `docs/readiness-matrix.md` says loading and authenticating an
// evidence source is the responsibility of the higher layer that calls the
// builder. This is that layer, and it is the only thing here that touches the
// network.
//
// It fails closed in every direction. A version with no tag, a tag whose commit
// has no run, a run this repository did not push, a missing platform job, a job
// that did not pass, a job whose runner is not the platform its row claims, a
// timeout, an HTTP error — all of them return no evidence at all, which leaves
// the CI rows NOT_RUN. Promoting a row on anything less than a green run at the
// exact commit being validated is the one failure this module exists to avoid.
//
// The mapping's limit, stated plainly: evidence is resolved *from the version
// number*, so it describes the commit the matching tag points at. `dsh-crew
// update --candidate <dir>` can install a tree that was never published while
// reporting the same version — its local edits are not tagged, so this module
// would present the tag's commit as the validated one. `evidence_ref` carries
// that commit so a reader can see which commit the green run covered, but it
// cannot see the running tree, and nothing here may claim otherwise. Widening
// this would need the running tree's revision, which the payload does not
// currently record.
//
// Authentication is optional and never required: the repository is public, so
// the anonymous API answers. A token is used only when the caller already has
// one; nothing here reads credentials from disk, and the value is never logged,
// returned, or included in an evidence record.

export const CI_EVIDENCE_REPO = 'Ran-sh/dsh-crew';

// The row each CI job validates. A platform with no job in the workflow cannot
// be evidenced by any run, so `macos_smoke` is deliberately absent rather than
// listed and always missing.
// `runner` is a gate, not a label. Matching on the job name alone would let a
// job called `deterministic` that ran on a macOS runner evidence the *linux*
// row, which is exactly the "looks validated, isn't" the matrix exists to
// refuse; the job's own labels have to name the platform the row claims.
const PLATFORM_JOBS = [
  { row: 'linux_deterministic', job: 'deterministic', runner: 'ubuntu' },
  { row: 'windows_regressions', job: 'windows-paths', runner: 'windows' },
  { row: 'macos_smoke', job: 'macos-smoke', runner: 'macos' },
];

const CACHE_TTL_MS = 10 * 60 * 1000;
// Negative results expire sooner. Caching "nothing proven" for the full window
// would let one transient network hiccup freeze a row at NOT_RUN for ten
// minutes, and the cost of asking again is bounded by the deadline.
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

/** Test seam: drop memoized evidence between cases. */
export function clearCiEvidenceCache() {
  cache.clear();
}

function apiHeaders(token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-crew-readiness',
  };
  if (typeof token === 'string' && token.trim() !== '') headers.authorization = `Bearer ${token.trim()}`;
  return headers;
}

// One deadline covers the whole chain, not one per request: this runs on the
// readiness route, and three sequential 5s timeouts would be a 15s stall on a
// cold cache.
//
// The deadline is enforced twice on purpose. The abort signal is the polite
// half — it lets a well-behaved transport drop the socket — but the readiness
// route must not depend on the transport cooperating, so the request is also
// raced against the clock. A fetch that ignores its signal then returns nothing
// at the deadline instead of holding the route open.
async function getJson(fetchImpl, url, { token, deadline, now }) {
  const remaining = deadline - now();
  if (remaining <= 0) return null;
  const controller = new AbortController();
  let timer;
  try {
    const attempt = fetchImpl(url, { headers: apiHeaders(token), signal: controller.signal })
      .then((response) => (response?.status === 200 ? response.json() : null))
      .catch(() => null);
    const expiry = new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, remaining);
    });
    return await Promise.race([attempt, expiry]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The commit a released version was cut from.
 *
 * `v<version>` may be a lightweight tag (the ref names the commit) or annotated
 * (the ref names a tag object that names the commit), so both are tried. A
 * version with no tag resolves to null and no evidence is produced: the running
 * code is then not the code CI validated, and saying so is the honest answer.
 */
async function resolveVersionCommit(fetchImpl, { repo, version, token, deadline, now }) {
  const tag = `v${version}`;
  const ref = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, { token, deadline, now });
  const object = ref?.object;
  if (!object) return null;
  if (object.type === 'commit' && typeof object.sha === 'string') return object.sha;
  if (object.type === 'tag' && typeof object.sha === 'string') {
    const annotated = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/git/tags/${object.sha}`, { token, deadline, now });
    const sha = annotated?.object?.sha;
    return typeof sha === 'string' ? sha : null;
  }
  return null;
}

function evidenceFor(jobs, { runId, sha }) {
  const evidence = {};
  for (const { row, job, runner } of PLATFORM_JOBS) {
    const match = jobs.find((entry) => entry?.name === job);
    if (!match) continue;
    if (String(match.conclusion ?? '').toLowerCase() !== 'success') continue;
    // The job's labels must name the platform the row claims. A name is not a
    // platform, and a runner label that does not match is treated as no
    // evidence at all rather than as evidence for the wrong row.
    const labels = Array.isArray(match.labels) ? match.labels : [];
    if (!labels.some((label) => String(label).toLowerCase().includes(runner))) continue;
    evidence[row] = {
      status: 'PASS',
      reason_code: 'CI_GREEN',
      evidence_source: 'github-actions',
      // The commit is part of the reference on purpose: version -> tag -> commit
      // is a mapping, and the reader has to be able to audit which commit the
      // green run actually covered.
      evidence_ref: `run-${runId}/${job}/${runner}@${String(sha).slice(0, 12)}${labels.length ? ` (${labels.join(',')})` : ''}`,
    };
  }
  return evidence;
}

/**
 * Load CI evidence for a released version. Returns `{}` when nothing can be
 * proven, so the caller can merge the result unconditionally.
 */
export async function loadCiEvidence({
  repo = CI_EVIDENCE_REPO,
  version,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  now = Date.now,
  useCache = true,
} = {}) {
  if (typeof version !== 'string' || version.trim() === '') return {};
  if (typeof fetchImpl !== 'function') return {};

  // The credential is part of the key: an anonymous result produced under a
  // rate limit must not be served to a call that offered a token.
  const key = `${repo}@${version.trim()}@${typeof token === 'string' && token.trim() !== '' ? 'auth' : 'anon'}`;
  const hit = cache.get(key);
  if (useCache && hit) {
    const ttl = Object.keys(hit.evidence).length > 0 ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (now() - hit.at < ttl) return hit.evidence;
  }

  const deadline = now() + timeoutMs;
  const evidence = await loadUncached({ repo, version: version.trim(), token, fetchImpl, deadline, now });
  cache.set(key, { at: now(), evidence });
  return evidence;
}

async function loadUncached({ repo, version, token, fetchImpl, deadline, now }) {
  const sha = await resolveVersionCommit(fetchImpl, { repo, version, token, deadline, now });
  if (!sha) return {};

  const runs = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`, { token, deadline, now });
  const list = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
  // The newest CI run for this commit, and each row judged by its own job.
  //
  // The run's overall conclusion is deliberately not a gate: one platform's red
  // job must not withdraw another platform's evidence, and each row asks only
  // whether *its* validation ran and passed. The run's *identity* is a gate
  // though. A workflow is matched by name, and a name is not an identity — a
  // pull request can carry a workflow file of its own, so a run this repository
  // did not push, or one belonging to a fork, is not accepted as evidence.
  const ciRun = list.find((run) => run?.name === 'CI'
    && String(run?.event ?? '').toLowerCase() === 'push'
    && run?.head_repository?.full_name === repo);
  if (!ciRun) return {};

  const jobsBody = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/actions/runs/${ciRun.id}/jobs?per_page=50`, { token, deadline, now });
  const jobs = Array.isArray(jobsBody?.jobs) ? jobsBody.jobs : [];
  return evidenceFor(jobs, { runId: ciRun.id, sha });
}
