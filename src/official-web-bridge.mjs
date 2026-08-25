import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { crewDshHome } from './install/install.mjs';
import { crewDshRuntimeModule } from './dsh-cli-runtime.mjs';

export const CREW_BRIDGE_PREFIX = '/_dsh/dsh-crew';
export const CREW_BRIDGE_TARGET = 'http://127.0.0.1:3210';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

export function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLocalHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export function resolveCrewBridgeTarget(env = process.env) {
  const raw = env?.DSH_CREW_BRIDGE_TARGET;
  if (!raw) return CREW_BRIDGE_TARGET;
  try {
    const target = new URL(raw);
    if (target.protocol !== 'http:' || !isLocalHostname(target.hostname.toLowerCase()) || target.pathname !== '/' || target.search || target.hash) return CREW_BRIDGE_TARGET;
    const port = Number(target.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return CREW_BRIDGE_TARGET;
    return target.origin;
  } catch { return CREW_BRIDGE_TARGET; }
}

export function isTrustedLocalRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  const host = typeof req?.headers?.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
  if (!host) return false;
  let authority;
  try { authority = new URL(`http://${host}`); } catch { return false; }
  if (!isLocalHostname(authority.hostname.toLowerCase())) return false;
  const fetchSite = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const origin = req?.headers?.origin;
  if (origin !== undefined) {
    if (typeof origin !== 'string') return false;
    let parsedOrigin;
    try { parsedOrigin = new URL(origin); } catch { return false; }
    if (!isLocalHostname(parsedOrigin.hostname.toLowerCase()) || parsedOrigin.host.toLowerCase() !== host) return false;
  }
  return true;
}

function safeHeaders(source) {
  const result = {};
  for (const [rawName, rawValue] of Object.entries(source ?? {})) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || rawValue === undefined) continue;
    result[name] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  return result;
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-dsh-crew-bridge': '3080-to-3210',
  });
  res.end(body);
}

async function readBoundedBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > limit) throw Object.assign(new Error('request too large'), { code: 'BODY_TOO_LARGE' });
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function defaultHealthCheck(fetchImpl = globalThis.fetch, bridgeTarget = CREW_BRIDGE_TARGET) {
  try {
    const response = await fetchImpl(`${bridgeTarget}${CREW_BRIDGE_PREFIX}/ping`, {
      signal: AbortSignal.timeout(1_500),
      headers: { accept: 'application/json' },
    });
    return response.ok;
  } catch { return false; }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createCrewSidecarSupervisor({
  home = homedir(),
  exists = existsSync,
  bridgeTarget = resolveCrewBridgeTarget(),
  healthCheck = () => defaultHealthCheck(globalThis.fetch, bridgeTarget),
  spawnImpl = spawn,
  wait = delay,
  maxAttempts = 120,
  pollInterval = 250,
} = {}) {
  let starting = null;
  let runningChild = null;
  const runtime = crewDshRuntimeModule({ home });
  const dshHome = crewDshHome({ home });
  const bridgePort = new URL(bridgeTarget).port;

  async function start() {
    if (await healthCheck()) return { ok: true, started: false };
    if (!exists(runtime)) return { ok: false, code: 'CREW_RUNTIME_NOT_INSTALLED' };
    const childAlive = runningChild && runningChild.killed !== true && runningChild.exitCode == null;
    if (!childAlive) {
      runningChild = spawnImpl(process.execPath, [
        runtime, '--profile', 'dsh-crew', '--host', '127.0.0.1', '--port', bridgePort,
      ], {
        cwd: dshHome,
        env: { ...process.env, DSH_HOME: dshHome },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      const ownedChild = runningChild;
      ownedChild.once?.('exit', () => { if (runningChild === ownedChild) runningChild = null; });
      ownedChild.unref?.();
    }
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (await healthCheck()) return { ok: true, started: true };
      await wait(pollInterval);
    }
    return { ok: false, code: 'CREW_BACKEND_START_TIMEOUT' };
  }

  return {
    ensure() {
      if (!starting) starting = start().finally(() => { starting = null; });
      return starting;
    },
  };
}

const processSupervisor = createCrewSidecarSupervisor();

export async function proxyCrewRequest(req, res, {
  fetchImpl = globalThis.fetch,
  ensureBackend = () => processSupervisor.ensure(),
  bridgeTarget = resolveCrewBridgeTarget(),
} = {}) {
  if (!isTrustedLocalRequest(req)) {
    sendJson(res, 403, { ok: false, code: 'LOCAL_SAME_ORIGIN_ONLY' });
    return;
  }
  let pathname;
  try { pathname = new URL(req.url, 'http://127.0.0.1:3080').pathname; } catch { pathname = ''; }
  if (pathname !== CREW_BRIDGE_PREFIX && !pathname.startsWith(`${CREW_BRIDGE_PREFIX}/`)) {
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
    return;
  }
  try {
    const backend = await ensureBackend();
    if (backend?.ok === false) throw new Error('backend unavailable');
    const method = String(req.method ?? 'GET').toUpperCase();
    const bodyBuffer = method === 'GET' || method === 'HEAD' ? null : await readBoundedBody(req);
    const response = await fetchImpl(`${bridgeTarget}${req.url}`, {
      method,
      headers: safeHeaders(req.headers),
      body: bodyBuffer === null ? undefined : new Blob([bodyBuffer]),
      signal: AbortSignal.timeout(120_000),
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    const headers = safeHeaders(Object.fromEntries(response.headers.entries()));
    headers['content-length'] = String(responseBody.length);
    headers['x-dsh-crew-bridge'] = '3080-to-3210';
    res.writeHead(response.status, headers);
    res.end(responseBody);
  } catch (error) {
    if (error?.code === 'BODY_TOO_LARGE') sendJson(res, 413, { ok: false, code: 'REQUEST_TOO_LARGE' });
    else sendJson(res, 503, { ok: false, code: 'CREW_BACKEND_UNAVAILABLE' });
  }
}

export function registerOfficialWebBridge(ctx, options = {}) {
  return ctx.inject(['webServer'], (webCtx) => {
    const disposeStatus = webCtx.webServer.register({
      kind: 'exact',
      path: `${CREW_BRIDGE_PREFIX}/bridge-status`,
      handler: (req, res) => {
        if (!isTrustedLocalRequest(req)) return sendJson(res, 403, { ok: false, code: 'LOCAL_SAME_ORIGIN_ONLY' });
        return sendJson(res, 200, { ok: true, mode: 'official-3080-isolated-3210' });
      },
    });
    const disposeProxy = webCtx.webServer.register({
      kind: 'prefix',
      path: CREW_BRIDGE_PREFIX,
      handler: (req, res) => proxyCrewRequest(req, res, options),
    });
    return () => { disposeProxy?.(); disposeStatus?.(); };
  });
}

export async function apply(ctx) {
  registerOfficialWebBridge(ctx);
}
