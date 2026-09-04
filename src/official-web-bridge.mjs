import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { crewDshHome } from './install/install.mjs';
import { crewDshRuntimeModule } from './dsh-cli-runtime.mjs';
import { isLocalHostname, isLoopbackAddress, localRequestCore, originAuthorityMatches } from './local-request-guard.mjs';

export { isLoopbackAddress };

export const CREW_BRIDGE_PREFIX = '/_dsh/dsh-crew';
export const CREW_BRIDGE_TARGET = 'http://127.0.0.1:3210';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

export function resolveCrewBridgeTarget() {
  // Production bridge routing is an invariant, not an environment setting.
  // Tests can inject dependencies directly into createCrewSidecarSupervisor.
  return CREW_BRIDGE_TARGET;
}

export function isTrustedLocalRequest(req) {
  if (!localRequestCore(req)) return false;
  const host = typeof req?.headers?.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
  if (!host) return false;
  const origin = req?.headers?.origin;
  if (origin === undefined) return true;
  return originAuthorityMatches(origin, host);
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

export async function defaultRuntimeIdentity(fetchImpl = globalThis.fetch, bridgeTarget = CREW_BRIDGE_TARGET) {
  try {
    const response = await fetchImpl(`${bridgeTarget}${CREW_BRIDGE_PREFIX}/runtime`, {
      signal: AbortSignal.timeout(1_500),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (!(body?.ok === true
      && body.execution_plane === 'hub-3210'
      && body.profile === 'dsh-crew'
      && Number(body.listen_port) === 3210
      && typeof body.runtime_id === 'string'
      && body.runtime_id.trim().length > 0)) return null;
    return { execution_plane: body.execution_plane, profile: body.profile, listen_port: Number(body.listen_port), runtime_id: body.runtime_id.trim() };
  } catch { return null; }
}

export async function defaultHealthCheck(fetchImpl = globalThis.fetch, bridgeTarget = CREW_BRIDGE_TARGET) {
  return (await defaultRuntimeIdentity(fetchImpl, bridgeTarget)) !== null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createCrewSidecarSupervisor({
  home = homedir(),
  exists = existsSync,
  bridgeTarget = resolveCrewBridgeTarget(),
  healthCheck = () => defaultHealthCheck(globalThis.fetch, bridgeTarget),
  spawnImpl = spawn,
  killImpl = (pid) => process.kill(pid),
  runtimeIdentity = () => defaultRuntimeIdentity(globalThis.fetch, bridgeTarget),
  wait = delay,
  maxAttempts = 120,
  pollInterval = 250,
  ownershipFile = join(crewDshHome({ home }), 'supervisor-ownership.json'),
} = {}) {
  if (bridgeTarget !== CREW_BRIDGE_TARGET) throw new Error('Crew supervisor is fixed to the isolated 3210 Crew Hub');
  let starting = null;
  let restarting = null;
  let runningChild = null;
  const runtime = crewDshRuntimeModule({ home });
  const dshHome = crewDshHome({ home });
  const bridgePort = new URL(bridgeTarget).port;

  function readOwnership() {
    try {
      const record = JSON.parse(readFileSync(ownershipFile, 'utf8'));
      if (record?.schema_version !== 1
        || !Number.isInteger(record.pid) || record.pid < 1
        || record.profile !== 'dsh-crew'
        || record.execution_plane !== 'hub-3210'
        || Number(record.port) !== Number(bridgePort)) return null;
      return record;
    } catch { return null; }
  }

  function clearOwnership(expectedPid) {
    try {
      const current = readOwnership();
      if (expectedPid !== undefined && current?.pid !== expectedPid) return;
      rmSync(ownershipFile, { force: true });
    } catch {}
  }

  function persistOwnership(pid, identity = null, { state = 'owned' } = {}) {
    if (!Number.isInteger(pid) || pid < 1) return false;
    if (state === 'owned' && !(typeof identity?.runtime_id === 'string' && identity.runtime_id.length > 0)) return false;
    try {
      mkdirSync(dshHome, { recursive: true });
      const temp = `${ownershipFile}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temp, JSON.stringify({
        schema_version: 1,
        state,
        pid,
        profile: 'dsh-crew',
        execution_plane: 'hub-3210',
        port: Number(bridgePort),
        runtime_id: typeof identity?.runtime_id === 'string' ? identity.runtime_id : null,
      }) + '\n');
      renameSync(temp, ownershipFile);
      return true;
    } catch { return false; }
  }

  function adoptedChild(pid) {
    return {
      pid,
      killed: false,
      exitCode: null,
      kill() {
        try {
          killImpl(pid);
          this.killed = true;
          this.exitCode = 0;
          clearOwnership(pid);
          return true;
        } catch { return false; }
      },
      unref() {},
    };
  }

  async function adoptPersistedChild() {
    if (runningChild && runningChild.killed !== true && runningChild.exitCode == null) return true;
    const record = readOwnership();
    if (!record || !(await healthCheck())) {
      if (record) clearOwnership(record.pid);
      return false;
    }
    // Kill authority requires a persisted non-empty runtime_id AND an exact
    // match with the live identity. A record without runtime_id (crash
    // between spawn and identity persistence, or PID reuse afterwards)
    // can never authorize a kill.
    if (typeof record.runtime_id !== 'string' || record.runtime_id.length === 0) {
      clearOwnership(record.pid);
      return false;
    }
    const identity = await runtimeIdentity();
    if (!identity || identity.runtime_id !== record.runtime_id) {
      clearOwnership(record.pid);
      return false;
    }
    runningChild = adoptedChild(record.pid);
    return true;
  }

  async function start() {
    const childAlive = runningChild && runningChild.killed !== true && runningChild.exitCode == null;
    if (await healthCheck()) {
      if (childAlive) return { ok: true, started: false, owned: true };
      if (await adoptPersistedChild()) return { ok: true, started: false, adopted: true, owned: true };
      return { ok: false, code: 'PORT_OWNERSHIP_CONFLICT' };
    }
    if (!exists(runtime)) return { ok: false, code: 'CREW_RUNTIME_NOT_INSTALLED' };
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
      if (Number.isInteger(ownedChild?.pid) && !persistOwnership(ownedChild.pid, null, { state: 'starting' })) {
        try { ownedChild.kill?.(); } catch {}
        runningChild = null;
        return { ok: false, code: 'SUPERVISOR_OWNERSHIP_PERSIST_FAILED' };
      }
      ownedChild.once?.('exit', () => { if (runningChild === ownedChild) runningChild = null; });
      ownedChild.unref?.();
    }
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (await healthCheck()) {
        if (Number.isInteger(runningChild?.pid)) {
          const identity = await runtimeIdentity();
          if (!identity) {
            try { runningChild?.kill?.(); } catch {}
            runningChild = null;
            return { ok: false, code: 'SUPERVISOR_RUNTIME_IDENTITY_UNAVAILABLE' };
          }
          if (!persistOwnership(runningChild.pid, identity)) {
            try { runningChild.kill?.(); } catch {}
            runningChild = null;
            return { ok: false, code: 'SUPERVISOR_OWNERSHIP_PERSIST_FAILED' };
          }
        }
        return { ok: true, started: true, owned: true };
      }
      await wait(pollInterval);
    }
    return { ok: false, code: 'CREW_BACKEND_START_TIMEOUT' };
  }

  async function restartOwnedBackend() {
    let owned = runningChild;
    let childAlive = owned && owned.killed !== true && owned.exitCode == null;
    if (!childAlive && await healthCheck()) {
      if (await adoptPersistedChild()) {
        owned = runningChild;
        childAlive = true;
      } else {
        return { ok: false, code: 'PORT_OWNERSHIP_CONFLICT' };
      }
    }
    if (!childAlive) {
      const started = await start();
      return started.ok ? { ...started, restarted: started.started === true } : started;
    }
    if (typeof owned.kill !== 'function' || owned.kill() !== true) {
      return { ok: false, code: 'CREW_BACKEND_RESTART_UNAVAILABLE' };
    }
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!await healthCheck()) break;
      await wait(pollInterval);
    }
    if (await healthCheck()) return { ok: false, code: 'CREW_BACKEND_STOP_TIMEOUT' };
    const started = await start();
    return started.ok ? { ...started, restarted: true } : started;
  }

  // Stop-only primitive for cohort migration: kills the owned 3210 child
  // (PID-identity verified) and waits until health disappears. Never
  // restarts: the caller swaps the runtime tree first, then calls
  // startOwnedBackend. Returns the stopped PID for audit.
  async function stopOwnedBackend() {
    let owned = runningChild;
    let childAlive = owned && owned.killed !== true && owned.exitCode == null;
    if (!childAlive && await healthCheck()) {
      if (await adoptPersistedChild()) {
        owned = runningChild;
        childAlive = true;
      } else {
        return { ok: false, code: 'PORT_OWNERSHIP_CONFLICT' };
      }
    }
    if (!childAlive) return { ok: true, stopped: false, pid: null };
    const pid = owned.pid;
    if (typeof owned.kill !== 'function' || owned.kill() !== true) {
      return { ok: false, code: 'CREW_BACKEND_STOP_UNAVAILABLE' };
    }
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!await healthCheck()) return { ok: true, stopped: true, pid };
      await wait(pollInterval);
    }
    return { ok: false, code: 'CREW_BACKEND_STOP_TIMEOUT' };
  }

  // Start-only primitive for cohort migration: boots the Crew-owned 3210
  // from the CURRENT live runtime tree and waits for health + identity.
  // Never stops anything first: the caller stops before swapping.
  async function startOwnedBackend() {
    const started = await start();
    return started.ok ? { ...started, started: true } : started;
  }

  return {
    execution_plane: 'hub-3210',
    profile: 'dsh-crew',
    listen_port: Number(bridgePort),
    ensure() {
      if (!starting) starting = start().finally(() => { starting = null; });
      return starting;
    },
    restartOwnedBackend() {
      if (!restarting) restarting = restartOwnedBackend().finally(() => { restarting = null; });
      return restarting;
    },
    stopOwnedBackend,
    startOwnedBackend,
  };
}

// NOTE: createCrewSidecarSupervisor (above) remains exported for unit
// tests, but NO production path may spawn/kill the 3210 through it. The
// Windows launcher supervisor (start-dsh-crew.ps1 watch mode) is the only
// process authority; npx lifecycle reaches it through the durable
// maintenance-request protocol (maintenance-stop/maintenance-start).

// The 3080 quick surface must NEVER spawn or own the 3210 process: recovery
// authority belongs exclusively to the Windows launcher supervisor. The
// default backend gate therefore only PROBES 3210 health and fails closed.
async function probeCrewBackend(fetchImpl = globalThis.fetch, bridgeTarget = resolveCrewBridgeTarget()) {
  try {
    const response = await fetchImpl(`${bridgeTarget}${CREW_BRIDGE_PREFIX}/runtime`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return { ok: false, code: 'CREW_BACKEND_UNREACHABLE' };
    const body = await response.json();
    return body?.ok === true ? { ok: true } : { ok: false, code: 'CREW_BACKEND_UNREADY' };
  } catch (error) {
    return { ok: false, code: 'CREW_BACKEND_UNREACHABLE', error: String(error?.message ?? error) };
  }
}

export async function proxyCrewRequest(req, res, {
  fetchImpl = globalThis.fetch,
  ensureBackend = () => probeCrewBackend(fetchImpl, resolveCrewBridgeTarget()),
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
    const requestHeaders = safeHeaders(req.headers);
    for (const name of Object.keys(requestHeaders)) {
      if (name.startsWith('x-dsh-crew-')) delete requestHeaders[name];
    }
    requestHeaders['x-dsh-crew-bridge'] = '3080-to-3210';
    requestHeaders['x-dsh-crew-execution-plane'] = 'hub-3210';
    requestHeaders['x-dsh-crew-ingress'] = 'official-3080';
    const response = await fetchImpl(`${bridgeTarget}${req.url}`, {
      method,
      headers: requestHeaders,
      body: bodyBuffer === null ? undefined : new Blob([bodyBuffer]),
      signal: AbortSignal.timeout(120_000),
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    const headers = safeHeaders(Object.fromEntries(response.headers.entries()));
    for (const name of Object.keys(headers)) {
      if (name.startsWith('x-dsh-crew-')) delete headers[name];
    }
    headers['content-length'] = String(responseBody.length);
    headers['x-dsh-crew-bridge'] = '3080-to-3210';
    headers['x-dsh-crew-ingress'] = 'official-3080';
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
        return sendJson(res, 200, {
          ok: true,
          mode: 'official-3080-quick-controls',
          surface: 'official-bridge',
          ui_role: 'quick-controls',
          execution_plane: 'hub-3210',
          listen_port: 3210,
          full_control_plane_url: 'http://127.0.0.1:3210/',
        });
      },
    });
    // The legacy supervisor endpoint moved to the durable 3210 restart-
    // request channel executed by the Windows launcher. Report 410 Gone so
    // stale callers learn the new contract instead of failing opaquely.
    const disposeRestart = webCtx.webServer.register({
      kind: 'exact',
      path: `${CREW_BRIDGE_PREFIX}/supervisor/restart`,
      handler: (req, res) => {
        if (!isTrustedLocalRequest(req)) return sendJson(res, 403, { ok: false, code: 'LOCAL_SAME_ORIGIN_ONLY' });
        return sendJson(res, 410, { ok: false, code: 'SUPERVISOR_ENDPOINT_MOVED', control_plane: 'http://127.0.0.1:3210/' });
      },
    });
    // Least-privilege allowlist: the 3080 quick-controls surface may reach
    // ONLY the narrow quick endpoints on 3210. Full Crew API (providers,
    // credentials, install, workspaces, migration, rollback, quarantine)
    // is no longer proxied here — the native 3210 page is the full control
    // plane.
    const QUICK_ALLOWLIST = new Set([
      '/quick-config',
      '/quick-status',
      '/runtime/restart-request',
      '/runtime/restart-status',
    ]);
    const disposers = [];
    for (const path of QUICK_ALLOWLIST) {
      disposers.push(webCtx.webServer.register({
        kind: 'exact',
        path: `${CREW_BRIDGE_PREFIX}${path}`,
        handler: (req, res) => proxyCrewRequest(req, res, options),
      }));
    }
    return () => { for (const dispose of disposers) dispose?.(); disposeRestart?.(); disposeStatus?.(); };
  });
}

export async function apply(ctx) {
  registerOfficialWebBridge(ctx);
}
