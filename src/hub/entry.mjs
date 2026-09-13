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
import { claimReleaseInUse, clearReleaseClaim } from '../release-in-use.mjs';

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
  // Declare this release in use before anything else. The Hub loads several
  // modules lazily with a cache-busting query, so deleting the release under a
  // running process would break those routes with no way to recover but a
  // restart. Retention reads these claims and leaves a live release alone.
  //
  // A claim that could not be written is worth saying out loud: retention cannot
  // see an unclaimed release, so this process is then the one that a later update
  // may delete from under itself.
  const claimFile = claimReleaseInUse();
  if (!claimFile) {
    ctx.logger?.warn?.('dsh-crew: could not record this release as in use; a later update may prune it while this Hub is running');
  }
  try {
    registerRuntimeEndpoint(ctx);
    installAdaptiveHealthObserver();
    const disposeHub = await applyHub(ctx);
    // Release the claim on disposal, and only once teardown has actually
    // finished: clearing it first would say "this release is unused" while the
    // Hub is still running. Nothing else may remove a claim file — the reader
    // deliberately never unlinks one, because it cannot tell its object from a
    // successor published at the same name — but the process that owns a claim
    // may remove its own, and it removes *this* claim rather than any other this
    // process happens to hold.
    return async () => {
      try { if (typeof disposeHub === 'function') await disposeHub(); }
      // Only a claim this mount actually holds. A null handle means the claim was
      // never acquired, and clearing something anyway could remove a sibling
      // mount's protection.
      finally { if (claimFile) { try { clearReleaseClaim({ file: claimFile }); } catch { /* best effort */ } } }
    };
  } catch (error) {
    // No disposer will ever be returned for a failed mount, so the claim has to
    // be released here or the release stays pinned by a process that never
    // provided anything.
    if (claimFile) { try { clearReleaseClaim({ file: claimFile }); } catch { /* best effort */ } }
    throw error;
  }
}
