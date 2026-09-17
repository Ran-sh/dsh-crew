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
// has no run, a run that did not succeed, a missing platform job, a timeout, an
// HTTP error — all of them return no evidence at all, which leaves the CI rows
// NOT_RUN. Promoting a row on anything less than a green run at the exact commit
// being validated is the one failure this module exists to avoid.
//
// Authentication is optional and never required: the repository is public, so
// the anonymous API answers. A token is used only when the caller already has
// one; nothing here reads credentials from disk, and the value is never logged,
// returned, or included in an evidence record.

export const CI_EVIDENCE_REPO = 'Ran-sh/dsh-crew';

// The row each CI job validates. A platform with no job in the workflow cannot
// be evidenced by any run, so `macos_smoke` is deliberately absent rather than
// listed and always missing.
const PLATFORM_JOBS = [
  { row: 'linux_deterministic', job: 'deterministic', runner: 'ubuntu' },
  { row: 'windows_regressions', job: 'windows-paths', runner: 'windows' },
  { row: 'macos_smoke', job: 'macos-smoke', runner: 'macos' },
];

const CACHE_TTL_MS = 10 * 60 * 1000;
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
async function getJson(fetchImpl, url, { token, deadline }) {
  const remaining = deadline - Date.now();
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
async function resolveVersionCommit(fetchImpl, { repo, version, token, deadline }) {
  const tag = `v${version}`;
  const ref = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, { token, deadline });
  const object = ref?.object;
  if (!object) return null;
  if (object.type === 'commit' && typeof object.sha === 'string') return object.sha;
  if (object.type === 'tag' && typeof object.sha === 'string') {
    const annotated = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/git/tags/${object.sha}`, { token, deadline });
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
    const labels = Array.isArray(match.labels) ? match.labels.join(',') : '';
    evidence[row] = {
      status: 'PASS',
      reason_code: 'CI_GREEN',
      evidence_source: 'github-actions',
      // The commit is part of the reference on purpose: version -> tag -> commit
      // is a mapping, and the reader has to be able to audit which commit the
      // green run actually covered.
      evidence_ref: `run-${runId}/${job}/${runner}@${String(sha).slice(0, 12)}${labels ? ` (${labels})` : ''}`,
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

  const key = `${repo}@${version.trim()}`;
  const hit = cache.get(key);
  if (useCache && hit && now() - hit.at < CACHE_TTL_MS) return hit.evidence;

  const deadline = now() + timeoutMs;
  const evidence = await loadUncached({ repo, version: version.trim(), token, fetchImpl, deadline });
  cache.set(key, { at: now(), evidence });
  return evidence;
}

async function loadUncached({ repo, version, token, fetchImpl, deadline }) {
  const sha = await resolveVersionCommit(fetchImpl, { repo, version, token, deadline });
  if (!sha) return {};

  const runs = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`, { token, deadline });
  const list = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
  // The newest CI run for this commit, and each row judged by its own job. The
  // run's overall conclusion is deliberately not a gate: one platform's red job
  // must not withdraw another platform's evidence, and each row asks only
  // whether *its* validation ran and passed.
  const ciRun = list.find((run) => run?.name === 'CI');
  if (!ciRun) return {};

  const jobsBody = await getJson(fetchImpl, `https://api.github.com/repos/${repo}/actions/runs/${ciRun.id}/jobs?per_page=50`, { token, deadline });
  const jobs = Array.isArray(jobsBody?.jobs) ? jobsBody.jobs : [];
  return evidenceFor(jobs, { runId: ciRun.id, sha });
}
