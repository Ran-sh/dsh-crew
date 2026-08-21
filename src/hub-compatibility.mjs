// Pure execution-mode decision for the Hub compatibility contract.
// Transport probing lives in hub-client.mjs; this module only decides whether
// a session may use Hub, intentionally fall back, or must fail closed.

import { HUB_COMPATIBILITY_CODES } from './runtime-identity.mjs';

export function hubCompatibilityMessage(status = {}) {
  const code = status.code ?? 'HUB_INCOMPATIBLE';
  if (!status.reachable) return `DSH workers hub is not reachable (${code}).`;
  const detail = status.missing_capabilities?.length
    ? `; missing capabilities: ${status.missing_capabilities.join(', ')}`
    : '';
  return `DSH workers hub is reachable but incompatible (${code}${detail}). Update/restart the Hub plugin before using Hub execution.`;
}

export function resolveHubExecutionMode(requestedMode = 'auto', status = {}) {
  if (requestedMode === 'standalone') {
    return { ok: true, mode: 'standalone', reason: 'explicit-standalone' };
  }

  if (status.compatible === true) {
    return { ok: true, mode: 'hub', reason: 'compatible-hub' };
  }

  if (status.reachable === true) {
    return {
      ok: false,
      code: status.code ?? 'HUB_INCOMPATIBLE',
      error: hubCompatibilityMessage(status),
      hub: status,
    };
  }

  if (requestedMode === 'hub') {
    return {
      ok: false,
      code: status.code ?? HUB_COMPATIBILITY_CODES.UNREACHABLE,
      error: 'Session mode is "hub" but the DSH workers hub is not reachable.',
      hub: status,
    };
  }

  return {
    ok: true,
    mode: 'standalone',
    reason: 'hub-unreachable-fallback',
    hub: status,
  };
}
