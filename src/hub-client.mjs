// Client for the in-host workers-hub jobs API. When a DSH web instance with the
// dsh-crew bundle is running, jobs run inside it (sessions visible in the
// Web UI); otherwise the MCP server falls back to standalone runtimes.

import { readGlobalConfig } from './install/install.mjs';
import { evaluateHubHandshake, HUB_COMPATIBILITY_CODES } from './runtime-identity.mjs';
import { buildReadinessMatrix } from './readiness-matrix.mjs';

const BASE = (process.env.DSH_CREW_HUB ?? readGlobalConfig().hub_url).replace(/\/$/, '');
const API = `${BASE}/_dsh/dsh-crew`;

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

let lastProbe = { at: 0, status: EMPTY_STATUS };

function withReadiness(status) {
  return {
    ...status,
    readiness_matrix: buildReadinessMatrix({ hubCompatibility: status }),
  };
}

function cacheStatus(status) {
  const observed = withReadiness(status);
  lastProbe = { at: Date.now(), status: observed };
  return observed;
}

async function fetchJson(path) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(800) });
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
export async function hubStatus({ force = false } = {}) {
  if (!force && Date.now() - lastProbe.at < 10_000) return lastProbe.status;
  try {
    const ping = await fetchJson('/ping');
    if (!ping.res.ok) {
      return cacheStatus({
        ...EMPTY_STATUS,
        reachable: true,
        code: HUB_COMPATIBILITY_CODES.HTTP_ERROR,
        http_status: ping.res.status,
        endpoint: 'ping',
      });
    }
    if (ping.body?.service !== 'dsh-crew-hub') {
      return cacheStatus(evaluateHubHandshake(ping.body));
    }

    const runtime = await fetchJson('/runtime');
    if (runtime.res.status === 404) {
      return cacheStatus({
        ...EMPTY_STATUS,
        reachable: true,
        service: 'dsh-crew-hub',
        code: HUB_COMPATIBILITY_CODES.PROTOCOL_MISSING,
        endpoint: 'runtime',
      });
    }
    if (!runtime.res.ok) {
      return cacheStatus({
        ...EMPTY_STATUS,
        reachable: true,
        service: 'dsh-crew-hub',
        code: HUB_COMPATIBILITY_CODES.HTTP_ERROR,
        http_status: runtime.res.status,
        endpoint: 'runtime',
      });
    }
    return cacheStatus(evaluateHubHandshake(runtime.body));
  } catch {
    return cacheStatus(EMPTY_STATUS);
  }
}

export async function hubAvailable() {
  return (await hubStatus()).compatible;
}

async function call(path, init) {
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `hub request failed (${res.status})`);
  return body;
}

export const hub = {
  spawn: (spec) => call('/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  }).then((b) => b.job),
  list: () => call('/jobs').then((b) => b.jobs),
  get: (id, waitSeconds = 0) => call(`/jobs/${id}?wait=${waitSeconds}`).then((b) => b.job),
  cancel: (id) => call(`/jobs/${id}/cancel`, { method: 'POST' }).then((b) => b.job),
};
