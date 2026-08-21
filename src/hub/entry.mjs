// Thin DSH plugin entry wrapper for v0.3 runtime compatibility discovery.
//
// The legacy /ping endpoint stays reachability-only inside index.mjs. This
// wrapper adds a separate /runtime endpoint carrying the explicit Hub/MCP
// compatibility contract, then delegates all existing Hub behavior unchanged.

import { apply as applyHub, inject, name } from './index.mjs';
import { getHubRuntimeIdentity } from '../runtime-identity.mjs';

const RUNTIME_PATH = '/_dsh/dsh-crew/runtime';

export { inject, name };

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
  });
  res.end(body);
}

export function registerRuntimeEndpoint(ctx) {
  return ctx.inject(['webServer'], (webCtx) => webCtx.webServer.register({
    kind: 'exact',
    path: RUNTIME_PATH,
    handler: (_req, res) => sendJson(res, 200, { ok: true, ...getHubRuntimeIdentity() }),
  }));
}

export async function apply(ctx) {
  registerRuntimeEndpoint(ctx);
  return applyHub(ctx);
}
