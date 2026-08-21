// Thin DSH plugin entry wrapper for v0.3 runtime compatibility discovery.
//
// The legacy /ping endpoint stays reachability-only inside index.mjs. This
// wrapper adds a separate /runtime endpoint carrying the explicit Hub/MCP
// compatibility contract, then delegates all existing Hub behavior unchanged.
// It also owns the v0.3 adaptive-routing observer so the large legacy Hub body
// stays untouched: only jobs that explicitly opted into adaptive routing feed
// bounded process-local health for later selections.

import { apply as applyHub, inject, name, WorkerRegistry } from './index.mjs';
import { getHubRuntimeIdentity } from '../runtime-identity.mjs';
import { getProcessAdaptiveHealthStore } from '../adaptive-routing.mjs';

const RUNTIME_PATH = '/_dsh/dsh-crew/runtime';
const ADAPTIVE_OBSERVER_INSTALLED = Symbol.for('@ran-sh/dsh-crew/adaptive-observer-installed');
const ADAPTIVE_JOB_OBSERVED = Symbol.for('@ran-sh/dsh-crew/adaptive-job-observed');

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

/**
 * Record only an opt-in adaptive Hub attempt. The store accepts bounded
 * provider/model identifiers plus outcome/latency; arbitrary job errors,
 * credentials, quota and provider payloads never cross this boundary.
 */
export function recordAdaptiveJobOutcome(job, store = getProcessAdaptiveHealthStore()) {
  if (job?.selection_trace?.adaptive?.enabled !== true) return false;
  const started = Date.parse(job.startedAt ?? '');
  const ended = Date.parse(job.endedAt ?? '');
  const latencyMs = Number.isFinite(started) && Number.isFinite(ended)
    ? Math.max(0, ended - started)
    : undefined;
  return store.record(
    { provider: job.provider, model: job.model },
    {
      role: job.role,
      status: job.status,
      stopReason: job.stopReason,
      latencyMs,
    },
  );
}

/**
 * Wrap WorkerRegistry.spawn once per process. Selection itself still lives in
 * the existing Hub implementation; rankAdaptiveCandidates reads the same
 * process-local store through adaptive-routing.mjs. Replacing job.promise with
 * a chained promise preserves all legacy completion/waiter behavior and runs
 * this observer only after the Hub's own finalizer populated endedAt/status.
 */
export function installAdaptiveHealthObserver() {
  if (WorkerRegistry.prototype[ADAPTIVE_OBSERVER_INSTALLED] === true) return false;
  const originalSpawn = WorkerRegistry.prototype.spawn;
  Object.defineProperty(WorkerRegistry.prototype, ADAPTIVE_OBSERVER_INSTALLED, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  WorkerRegistry.prototype.spawn = async function observedAdaptiveSpawn(...args) {
    const job = await originalSpawn.apply(this, args);
    if (!job || job[ADAPTIVE_JOB_OBSERVED] === true || typeof job.promise?.finally !== 'function') return job;
    Object.defineProperty(job, ADAPTIVE_JOB_OBSERVED, {
      value: true,
      enumerable: false,
      configurable: false,
    });
    job.promise = job.promise.finally(() => {
      recordAdaptiveJobOutcome(job);
    });
    return job;
  };
  return true;
}

export async function apply(ctx) {
  registerRuntimeEndpoint(ctx);
  installAdaptiveHealthObserver();
  return applyHub(ctx);
}
