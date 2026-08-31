// TDD RED checkpoint — v0.6 runtime provenance invariant.
//
// These tests encode the v0.6 contract for Hub runtime identity provenance and
// must FAIL against the current (pre-v0.6) implementation. The production code
// does not yet expose the execution_plane / profile / listen_port / runtime_id
// fields, nor does it enforce the production execution-plane guard. This is an
// intentional RED: do NOT edit src/ here to make these pass. The GREEN phase is
// owned by the production team.
//
// Scope: test-only file. No production/source/config/credential edits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getHubRuntimeIdentity,
  evaluateHubHandshake,
} from '../src/runtime-identity.mjs';

const PRODUCTION_EXECUTION_PLANE = 'hub-3210';
const PRODUCTION_PROFILE = 'dsh-crew';
const PRODUCTION_LISTEN_PORT = 3210;

// Field names that would indicate credential leakage if present in the public
// runtime identity. The identity must be safe to broadcast on the wire.
const CREDENTIAL_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /authorization/i,
  /bearer/i,
  /credential/i,
  /session[_-]?key/i,
];

function collectKeys(value, path = '', acc = []) {
  if (value === null || typeof value !== 'object') return acc;
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectKeys(item, `${path}[${i}]`, acc));
    return acc;
  }
  for (const [key, child] of Object.entries(value)) {
    acc.push({ key, path: path ? `${path}.${key}` : key });
    collectKeys(child, path ? `${path}.${key}` : key, acc);
  }
  return acc;
}

test('v0.6 Hub identity exposes the production execution-plane provenance', () => {
  const identity = getHubRuntimeIdentity();
  assert.equal(
    identity.execution_plane,
    PRODUCTION_EXECUTION_PLANE,
    'getHubRuntimeIdentity() must expose execution_plane=hub-3210',
  );
  assert.equal(
    identity.profile,
    PRODUCTION_PROFILE,
    'getHubRuntimeIdentity() must expose profile=dsh-crew',
  );
  assert.equal(
    identity.listen_port,
    PRODUCTION_LISTEN_PORT,
    'getHubRuntimeIdentity() must expose listen_port=3210',
  );
});

test('v0.6 Hub identity exposes a stable runtime identity field', () => {
  const first = getHubRuntimeIdentity();
  const second = getHubRuntimeIdentity();
  assert.equal(
    typeof first.runtime_id,
    'string',
    'getHubRuntimeIdentity() must expose a stable runtime identity field (runtime_id)',
  );
  assert.ok(first.runtime_id.length > 0, 'runtime_id must be non-empty');
  assert.equal(
    first.runtime_id,
    second.runtime_id,
    'runtime_id must be stable/deterministic across calls',
  );
});

test('v0.6 Hub identity does not expose credentials', () => {
  const identity = getHubRuntimeIdentity();
  const leaked = collectKeys(identity)
    .map((entry) => entry.key)
    .filter((key) => CREDENTIAL_KEY_PATTERNS.some((pattern) => pattern.test(key)));
  assert.deepEqual(
    leaked,
    [],
    `Hub identity must not expose credential-like fields (found: ${leaked.join(', ') || 'none'})`,
  );
});

test('non-3210 execution plane is not treated as the production execution plane', () => {
  const nonProduction = {
    ok: true,
    ...getHubRuntimeIdentity(),
    execution_plane: 'hub-9999',
    listen_port: 9999,
  };
  const result = evaluateHubHandshake(nonProduction);
  assert.equal(
    result.compatible,
    false,
    'an explicit non-3210 identity must not be treated as the production execution plane',
  );
});
