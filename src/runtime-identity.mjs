// Shared runtime identity and Hub compatibility contract.
//
// Package/release semver and the wire protocol are intentionally separate:
// - RUNTIME_VERSION identifies the source/runtime generation for diagnostics.
// - HUB_PROTOCOL_VERSION changes only when Hub <-> MCP wire semantics become
//   incompatible.
//
// Keep this module pure and dependency-free so Hub, MCP and tests all use the
// exact same compatibility rules.

export const RUNTIME_VERSION = '0.5.0';
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
export function evaluateHubHandshake(body, { requiredCapabilities = REQUIRED_HUB_CAPABILITIES } = {}) {
  const capabilities = normalizedCapabilities(body?.capabilities);
  const base = {
    reachable: true,
    compatible: false,
    service: typeof body?.service === 'string' ? body.service : null,
    runtime_version: typeof body?.runtime_version === 'string' ? body.runtime_version : null,
    protocol_version: Number.isInteger(body?.protocol_version) ? body.protocol_version : null,
    capabilities,
    missing_capabilities: [],
    code: null,
  };

  if (body?.service !== 'dsh-crew-hub') {
    return { ...base, code: HUB_COMPATIBILITY_CODES.SERVICE_MISMATCH };
  }

  if (!Number.isInteger(body?.protocol_version)) {
    return { ...base, code: HUB_COMPATIBILITY_CODES.PROTOCOL_MISSING };
  }

  if (body.protocol_version !== HUB_PROTOCOL_VERSION) {
    return { ...base, code: HUB_COMPATIBILITY_CODES.PROTOCOL_MISMATCH };
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
