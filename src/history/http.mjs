import { localRequestCore, originAuthorityMatches } from '../local-request-guard.mjs';
import { safeHistoryError } from './service.mjs';

export function registerHistoryHttp(webServer, service) {
  return webServer.register({ kind: 'prefix', path: '/_dsh/dsh-crew/history/', async handler(req, res) {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (!localRequestCore(req) || (req.headers.origin !== undefined && !originAuthorityMatches(req.headers.origin, req.headers.host))) return send(403, { ok: false, code: 'HISTORY_LOCAL_ORIGIN_REQUIRED' });
    const action = new URL(req.url, 'http://127.0.0.1').pathname.split('/').pop();
    try {
      if (req.method === 'GET') {
        if (action === 'status') return send(200, { ok: true, status: service.status() });
        if (action === 'archives') return send(200, { ok: true, archives: service.archives() });
        return send(405, { ok: false, code: 'HISTORY_METHOD_NOT_ALLOWED' });
      }
      if (req.method !== 'POST') return send(405, { ok: false, code: 'HISTORY_METHOD_NOT_ALLOWED' });
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) return send(413, { ok: false, code: 'HISTORY_BODY_TOO_LARGE' }); chunks.push(Buffer.from(chunk)); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return send(400, { ok: false, code: 'HISTORY_INVALID_JSON' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { ok: false, code: 'HISTORY_INVALID_JSON' });
      if (action === 'preview') return send(200, { ok: true, preview: await service.preview(body) });
      if (action === 'execute') return send(202, { ok: true, status: await service.execute(body) });
      if (action === 'restore') return send(202, { ok: true, status: await service.restore(body) });
      if (action === 'recover') return send(202, { ok: true, status: await service.recover(body) });
      if (action === 'fenced-check') return send(200, { ok: await service.fencedCheck() });
      return send(404, { ok: false, code: 'HISTORY_NOT_FOUND' });
    } catch (error) {
      const code = safeHistoryError(error);
      return send(/INVALID|CONFIRMATION/.test(code) ? 400 : /UNSUPPORTED|UNAVAILABLE/.test(code) ? 503 : 409, { ok: false, code });
    }
  } });
}
