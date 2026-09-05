// UI-only overlay host. No process lifecycle, installer or profile mutations.
import { localRequestCore, originAuthorityMatches } from '../src/local-request-guard.mjs';
import { readFileSync } from 'node:fs';

const PREFIX = '/_dsh/dsh-crew';
const BACKEND = 'http://127.0.0.1:3210';
const REVISION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).dshCrewFrontendRevision ?? null;

function trusted(req) {
  return localRequestCore(req) && (req.headers.origin === undefined
    || originAuthorityMatches(req.headers.origin, req.headers.host));
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function registerFrontend(ctx, { fetchImpl = globalThis.fetch } = {}) {
  return ctx.inject(['webServer'], ({ webServer }) => {
    const disposers = [];
    disposers.push(webServer.register({ kind: 'exact', path: `${PREFIX}/bridge-status`, handler(req, res) {
      if (!trusted(req)) return send(res, 403, { ok: false, code: 'LOCAL_SAME_ORIGIN_ONLY' });
      send(res, 200, { ok: true, surface: 'official-bridge', ui_role: 'quick-controls', frontend_revision: REVISION, full_control_plane_url: `${BACKEND}/` });
    } }));
    for (const suffix of ['/quick-config', '/quick-status']) {
      disposers.push(webServer.register({ kind: 'exact', path: `${PREFIX}${suffix}`, async handler(req, res) {
        if (!trusted(req)) return send(res, 403, { ok: false, code: 'LOCAL_SAME_ORIGIN_ONLY' });
        const method = req.method ?? 'GET';
        if (method !== 'GET' && !(suffix === '/quick-config' && method === 'POST')) return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
        try {
          const identityResponse = await fetchImpl(`${BACKEND}${PREFIX}/runtime`, { signal: AbortSignal.timeout(2500) });
          const identity = await identityResponse.json();
          if (!identityResponse.ok || identity.ok !== true || identity.service !== 'dsh-crew-hub'
            || identity.profile !== 'dsh-crew' || identity.execution_plane !== 'hub-3210'
            || identity.listen_port !== 3210 || identity.protocol_version !== 1) throw new Error('incompatible backend');
          const chunks = [];
          let size = 0;
          if (method === 'POST') for await (const chunk of req) {
            size += chunk.length;
            if (size > 64 * 1024) return send(res, 413, { ok: false, code: 'BODY_TOO_LARGE' });
            chunks.push(Buffer.from(chunk));
          }
          const response = await fetchImpl(`${BACKEND}${PREFIX}${suffix}`, {
            method, headers: { 'content-type': 'application/json' },
            ...(method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
            signal: AbortSignal.timeout(5000),
          });
          send(res, response.status, await response.json());
        } catch {
          send(res, 503, { ok: false, ready: false, code: 'CREW_BACKEND_UNAVAILABLE' });
        }
      } }));
    }
    return () => { for (const dispose of disposers) dispose?.(); };
  });
}

export function apply(ctx) { registerFrontend(ctx); }
