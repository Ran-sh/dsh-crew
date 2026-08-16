// Client for the in-host workers-hub jobs API. When a DSH web instance with the
// dsh-crew bundle is running, jobs run inside it (sessions visible in the
// Web UI); otherwise the MCP server falls back to standalone runtimes.

import { readGlobalConfig } from './install/install.mjs';

const BASE = (process.env.DSH_CREW_HUB ?? readGlobalConfig().hub_url).replace(/\/$/, '');
const API = `${BASE}/_dsh/dsh-crew`;

let lastProbe = { at: 0, ok: false };

export async function hubAvailable() {
  if (Date.now() - lastProbe.at < 10_000) return lastProbe.ok;
  try {
    const res = await fetch(`${API}/ping`, { signal: AbortSignal.timeout(800) });
    const body = await res.json();
    lastProbe = { at: Date.now(), ok: res.ok && body?.service === 'dsh-crew-hub' };
  } catch {
    lastProbe = { at: Date.now(), ok: false };
  }
  return lastProbe.ok;
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
