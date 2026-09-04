// Client for the in-host workers-hub jobs API. When a DSH web instance with the
// dsh-crew bundle is running, jobs run inside it (sessions visible in the
// Web UI); otherwise the MCP server falls back to standalone runtimes.

import { readGlobalConfig } from './install/install.mjs';
import { evaluateHubHandshake, HUB_COMPATIBILITY_CODES } from './runtime-identity.mjs';
import { buildReadinessMatrix } from './readiness-matrix.mjs';
import { isBoundedMachineCode } from './structured-error-code.mjs';

const BASE = (process.env.DSH_CREW_HUB ?? readGlobalConfig().hub_url).replace(/\/$/, '');
const API = `${BASE}/_dsh/dsh-crew`;

export const HUB_REQUEST_FAILED = 'HUB_REQUEST_FAILED';

const EMPTY_STATUS = Object.freeze({
  reachable: false,
  compatible: false,
  service: null,
  runtime_version: null,
  protocol_version: null,
  capabilities: [],
  missing_capabilities: [],
  code: HUB_COMPATIBILITY_CODES.UNREACHABLE,
});

let lastProbe = { at: 0, base: null, status: EMPTY_STATUS };

function withReadiness(status) {
  return {
    ...status,
    readiness_matrix: buildReadinessMatrix({ hubCompatibility: status }),
  };
}

function cacheStatus(status, base) {
  const observed = withReadiness(status);
  lastProbe = { at: Date.now(), base, status: observed };
  return observed;
}

async function fetchJson(path, base = BASE) {
  const api = `${String(base).replace(/\/$/, '')}/_dsh/dsh-crew`;
  const res = await fetch(`${api}${path}`, { signal: AbortSignal.timeout(800) });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { res, body };
}

/**
 * Probe reachability and compatibility as separate contracts.
 *
 * /ping is intentionally legacy-compatible and proves only that a dsh-crew Hub
 * is alive. /runtime is the v0.3 compatibility handshake. A legacy Hub that
 * lacks /runtime is therefore reachable-but-incompatible instead of looking
 * offline or being silently treated as current.
 */
export async function hubStatus({ force = false, base = BASE } = {}) {
  const normalizedBase = String(base).replace(/\/$/, '');
  if (!force && lastProbe.base === normalizedBase && Date.now() - lastProbe.at < 10_000) return lastProbe.status;
  try {
    const ping = await fetchJson('/ping', normalizedBase);
    if (!ping.res.ok) {
      return cacheStatus({
        ...EMPTY_STATUS,
        reachable: true,
        code: HUB_COMPATIBILITY_CODES.HTTP_ERROR,
        http_status: ping.res.status,
        endpoint: 'ping',
      }, normalizedBase);
    }
    if (ping.body?.service !== 'dsh-crew-hub') {
      return cacheStatus(evaluateHubHandshake(ping.body), normalizedBase);
    }

    const runtime = await fetchJson('/runtime', normalizedBase);
    if (runtime.res.status === 404) {
      return cacheStatus({
        ...EMPTY_STATUS,
        reachable: true,
        service: 'dsh-crew-hub',
        code: HUB_COMPATIBILITY_CODES.PROTOCOL_MISSING,
        endpoint: 'runtime',
      }, normalizedBase);
    }
    if (!runtime.res.ok) {
      return cacheStatus({
        ...EMPTY_STATUS,
        reachable: true,
        service: 'dsh-crew-hub',
        code: HUB_COMPATIBILITY_CODES.HTTP_ERROR,
        http_status: runtime.res.status,
        endpoint: 'runtime',
      }, normalizedBase);
    }
    return cacheStatus(evaluateHubHandshake(runtime.body, { strictProduction: true }), normalizedBase);
  } catch {
    return cacheStatus(EMPTY_STATUS, normalizedBase);
  }
}

export async function hubAvailable() {
  return (await hubStatus()).compatible;
}

function structuredCode(body) {
  if (isBoundedMachineCode(body?.code)) return body.code;
  if (isBoundedMachineCode(body?.policyCode)) return body.policyCode;
  return null;
}

/** Build a bounded Hub request error without copying arbitrary response fields. */
export function hubRequestError(body, status) {
  const err = new Error(body?.error ?? `hub request failed (${status})`);
  err.code = structuredCode(body) ?? HUB_REQUEST_FAILED;
  return err;
}

// Transport deadlines: every Hub call is bounded so a wedged local HTTP
// exchange can never outlive the workflow timeout contract. Long polls get
// their requested wait plus grace; spawn gets a wider bound because worktree
// creation can clone sizeable repositories. The env override exists for
// deterministic deadline tests; production defaults stay at 10s.
const ENV_TIMEOUT_MS = Number(process.env.DSH_CREW_HUB_TIMEOUT_MS);
const DEFAULT_TIMEOUT_MS = Number.isInteger(ENV_TIMEOUT_MS) && ENV_TIMEOUT_MS > 0 ? ENV_TIMEOUT_MS : 10_000;
const SPAWN_TIMEOUT_MS = Math.max(DEFAULT_TIMEOUT_MS, 60_000);
const LONG_POLL_GRACE_MS = 5_000;

async function call(path, init, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw hubRequestError({ error: `hub request timed out after ${timeoutMs}ms` }, 0);
    }
    throw err;
  }
  const body = await res.json();
  if (!res.ok || body.ok === false) throw hubRequestError(body, res.status);
  return body;
}

export const hub = {
  spawn: (spec) => call('/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  }, { timeoutMs: SPAWN_TIMEOUT_MS }).then((b) => b.job),
  list: () => call('/jobs').then((b) => b.jobs),
  get: (id, waitSeconds = 0) => call(`/jobs/${id}?wait=${waitSeconds}`, undefined, {
    timeoutMs: waitSeconds > 0 ? (waitSeconds * 1000) + LONG_POLL_GRACE_MS : DEFAULT_TIMEOUT_MS,
  }).then((b) => b.job),
  cancel: (id) => call(`/jobs/${id}/cancel`, { method: 'POST' }).then((b) => b.job),
};
