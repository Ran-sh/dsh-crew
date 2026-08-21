// Client for the in-host workers-hub jobs API. When a DSH web instance with the
// dsh-crew bundle is running, jobs run inside it (sessions visible in the
// Web UI); otherwise the MCP server falls back to standalone runtimes.

import { readGlobalConfig } from './install/install.mjs';
import { evaluateHubHandshake, HUB_COMPATIBILITY_CODES } from './runtime-identity.mjs';

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

function cacheStatus(status) {
  lastProbe = { at: Date.now(), status };
  return status;
}

/**
 * Probe the Hub without conflating transport reachability with protocol
 * compatibility. Callers may force a fresh probe when presenting diagnostics.
 */
export async function hubStatus({ force = false } = {}) {
  if (!force && Date.now() - lastProbe.at < 10_000) return lastProbe.status;
  try {
    const res = await fetch(`${API}/ping`, { signal: AbortSignal.timeout(800) });
    let body;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      return cacheStatus({
        ...EMPTY_STATUS,
        reachable: true,
        code: HUB_COMPATIBILITY_CODES.HTTP_ERROR,
        http_status: res.status,
      });
    }
    return cacheStatus(evaluateHubHandshake(body));
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
