// Shared runtime identity and Hub compatibility contract.
//
// Package/release semver and the wire protocol are intentionally separate:
// - RUNTIME_VERSION identifies the source/runtime generation for diagnostics.
// - HUB_PROTOCOL_VERSION changes only when Hub <-> MCP wire semantics become
//   incompatible.
//
// Keep this module dependency-light so Hub, MCP and tests all use the exact
// same compatibility rules.

import { randomUUID } from 'node:crypto';

// Production Crew execution is intentionally bound to the isolated 3210 Hub.
// These fields are public provenance only; no credential or session secret is
// included in the identity contract.
export const PRODUCTION_EXECUTION_PLANE = 'hub-3210';
export const PRODUCTION_PROFILE = 'dsh-crew';
export const PRODUCTION_LISTEN_PORT = 3210;
const RUNTIME_ID = randomUUID();

export const RUNTIME_VERSION = '1.0.0';
export const HUB_PROTOCOL_VERSION = 1;

export const HUB_CAPABILITIES = Object.freeze([
  'jobs',
  'jobs-wait',
  'jobs-cancel',
  'roles',
  'attempt-index',
  'model-policy',
  'model-catalog',
  'presets',
  'config',
  'canonical-events',
  'evidence',
  'profiles',
  'workspace-context',
  'extension-contract',
  'provider-inventory',
  'provider-lifecycle-v1',
  'provider-health-v1',
  'provider-probe-stream-v1',
  'credential-reference-inventory-v1',
  'credential-purge-v1',
  'runtime-provenance-v1',
]);

// Capabilities the current MCP workflow depends on for full Hub execution.
// Additional capabilities may be advertised without breaking compatibility.
export const REQUIRED_HUB_CAPABILITIES = Object.freeze([
  'jobs',
  'jobs-wait',
  'jobs-cancel',
  'roles',
  'attempt-index',
  'model-policy',
]);

export const HUB_COMPATIBILITY_CODES = Object.freeze({
  UNREACHABLE: 'HUB_UNREACHABLE',
  HTTP_ERROR: 'HUB_HTTP_ERROR',
  SERVICE_MISMATCH: 'HUB_SERVICE_MISMATCH',
  PROTOCOL_MISSING: 'HUB_PROTOCOL_MISSING',
  PROTOCOL_MISMATCH: 'HUB_PROTOCOL_MISMATCH',
  CAPABILITY_MISSING: 'HUB_CAPABILITY_MISSING',
  PROVENANCE_MISSING: 'HUB_PROVENANCE_MISSING',
  EXECUTION_PLANE_MISMATCH: 'HUB_EXECUTION_PLANE_MISMATCH',
  LISTEN_PORT_MISMATCH: 'HUB_LISTEN_PORT_MISMATCH',
});

function normalizedCapabilities(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))];
}

export function getHubRuntimeIdentity() {
  return {
    service: 'dsh-crew-hub',
    surface: 'native-crew-harness',
    ui_role: 'runtime',
    runtime_version: RUNTIME_VERSION,
    protocol_version: HUB_PROTOCOL_VERSION,
    execution_plane: PRODUCTION_EXECUTION_PLANE,
    profile: PRODUCTION_PROFILE,
    listen_port: PRODUCTION_LISTEN_PORT,
    runtime_id: RUNTIME_ID,
    capabilities: [...HUB_CAPABILITIES],
  };
}

/**
 * Evaluate an already-received Hub ping body.
 *
 * This function does no I/O. `reachable` means an HTTP response was received;
 * `compatible` means the response is from dsh-crew and satisfies the current
 * protocol + required capability contract.
 */
export function evaluateHubHandshake(body, { requiredCapabilities = REQUIRED_HUB_CAPABILITIES, strictProduction = false } = {}) {
  const capabilities = normalizedCapabilities(body?.capabilities);
  const base = {
    reachable: true,
    compatible: false,
    service: typeof body?.service === 'string' ? body.service : null,
    runtime_version: typeof body?.runtime_version === 'string' ? body.runtime_version : null,
    protocol_version: Number.isInteger(body?.protocol_version) ? body.protocol_version : null,
    execution_plane: typeof body?.execution_plane === 'string' ? body.execution_plane : null,
    profile: typeof body?.profile === 'string' ? body.profile : null,
    listen_port: Number.isInteger(body?.listen_port) ? body.listen_port : null,
    runtime_id: typeof body?.runtime_id === 'string' ? body.runtime_id : null,
    capabilities,
    missing_capabilities: [],
    code: null,
  };

  if (body?.service !== 'dsh-crew-hub') {
    return { ...base, code: HUB_COMPATIBILITY_CODES.SERVICE_MISMATCH };
  }

  // An explicit execution identity that is not the isolated 3210 Crew plane
  // must never be accepted as the production Hub. Missing legacy fields remain
  // compatible with the older protocol contract and are handled below.
  if (body?.execution_plane !== undefined && body.execution_plane !== PRODUCTION_EXECUTION_PLANE) {
    return { ...base, code: HUB_COMPATIBILITY_CODES.EXECUTION_PLANE_MISMATCH };
  }
  if (body?.listen_port !== undefined && body.listen_port !== PRODUCTION_LISTEN_PORT) {
    return { ...base, code: HUB_COMPATIBILITY_CODES.LISTEN_PORT_MISMATCH };
  }

  if (!Number.isInteger(body?.protocol_version)) {
    return { ...base, code: HUB_COMPATIBILITY_CODES.PROTOCOL_MISSING };
  }

  if (body.protocol_version !== HUB_PROTOCOL_VERSION) {
    return { ...base, code: HUB_COMPATIBILITY_CODES.PROTOCOL_MISMATCH };
  }

  if (strictProduction && !(body?.execution_plane === PRODUCTION_EXECUTION_PLANE
    && body?.profile === PRODUCTION_PROFILE
    && Number.isInteger(body?.listen_port) && body.listen_port === PRODUCTION_LISTEN_PORT
    && typeof body?.runtime_id === 'string' && body.runtime_id.trim().length > 0)) {
    return { ...base, code: HUB_COMPATIBILITY_CODES.PROVENANCE_MISSING };
  }

  const required = normalizedCapabilities(requiredCapabilities);
  const advertised = new Set(capabilities);
  const missing = required.filter((capability) => !advertised.has(capability));
  if (missing.length > 0) {
    return {
      ...base,
      missing_capabilities: missing,
      code: HUB_COMPATIBILITY_CODES.CAPABILITY_MISSING,
    };
  }

  return {
    ...base,
    compatible: true,
    code: null,
  };
}
