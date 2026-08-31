import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_VERSION,
  HUB_PROTOCOL_VERSION,
  HUB_CAPABILITIES,
  REQUIRED_HUB_CAPABILITIES,
  HUB_COMPATIBILITY_CODES,
  getHubRuntimeIdentity,
  evaluateHubHandshake,
} from '../src/runtime-identity.mjs';

test('Hub identity advertises one shared runtime/protocol contract', () => {
  const identity = getHubRuntimeIdentity();
  assert.equal(identity.service, 'dsh-crew-hub');
  assert.equal(identity.surface, 'native-crew-harness');
  assert.equal(identity.ui_role, 'runtime');
  assert.equal(identity.runtime_version, RUNTIME_VERSION);
  assert.equal(identity.protocol_version, HUB_PROTOCOL_VERSION);
  assert.deepEqual(identity.capabilities, [...HUB_CAPABILITIES]);
  for (const required of REQUIRED_HUB_CAPABILITIES) assert.ok(identity.capabilities.includes(required));
});

test('current Hub identity is compatible', () => {
  const result = evaluateHubHandshake({ ok: true, ...getHubRuntimeIdentity() });
  assert.equal(result.reachable, true);
  assert.equal(result.compatible, true);
  assert.equal(result.code, null);
  assert.deepEqual(result.missing_capabilities, []);
});

test('legacy reachability-only ping is detected as stale instead of compatible', () => {
  const result = evaluateHubHandshake({ ok: true, service: 'dsh-crew-hub' });
  assert.equal(result.reachable, true);
  assert.equal(result.compatible, false);
  assert.equal(result.code, HUB_COMPATIBILITY_CODES.PROTOCOL_MISSING);
});

test('strict production handshake rejects provenance-less runtime identities', () => {
  const result = evaluateHubHandshake({
    ok: true,
    service: 'dsh-crew-hub',
    runtime_version: RUNTIME_VERSION,
    protocol_version: HUB_PROTOCOL_VERSION,
    capabilities: HUB_CAPABILITIES,
  }, { strictProduction: true });
  assert.equal(result.compatible, false);
  assert.equal(result.code, HUB_COMPATIBILITY_CODES.PROVENANCE_MISSING);
});

test('wrong service is not treated as a dsh-crew Hub', () => {
  const result = evaluateHubHandshake({ ok: true, service: 'other', protocol_version: HUB_PROTOCOL_VERSION, capabilities: HUB_CAPABILITIES });
  assert.equal(result.compatible, false);
  assert.equal(result.code, HUB_COMPATIBILITY_CODES.SERVICE_MISMATCH);
});

test('protocol mismatch is deterministic', () => {
  const result = evaluateHubHandshake({
    service: 'dsh-crew-hub',
    runtime_version: 'future',
    protocol_version: HUB_PROTOCOL_VERSION + 1,
    capabilities: HUB_CAPABILITIES,
  });
  assert.equal(result.compatible, false);
  assert.equal(result.code, HUB_COMPATIBILITY_CODES.PROTOCOL_MISMATCH);
  assert.equal(result.protocol_version, HUB_PROTOCOL_VERSION + 1);
});

test('missing required capabilities are reported explicitly', () => {
  const capabilities = HUB_CAPABILITIES.filter((capability) => capability !== 'roles' && capability !== 'jobs-cancel');
  const result = evaluateHubHandshake({
    service: 'dsh-crew-hub',
    runtime_version: RUNTIME_VERSION,
    protocol_version: HUB_PROTOCOL_VERSION,
    capabilities,
  });
  assert.equal(result.compatible, false);
  assert.equal(result.code, HUB_COMPATIBILITY_CODES.CAPABILITY_MISSING);
  assert.deepEqual(result.missing_capabilities, ['jobs-cancel', 'roles']);
});

test('extra future capabilities do not break the current contract', () => {
  const result = evaluateHubHandshake({
    ...getHubRuntimeIdentity(),
    capabilities: [...HUB_CAPABILITIES, 'future-safe-extra'],
  });
  assert.equal(result.compatible, true);
  assert.ok(result.capabilities.includes('future-safe-extra'));
});

test('capability normalization drops junk and duplicates without leaking arbitrary values', () => {
  const result = evaluateHubHandshake({
    ...getHubRuntimeIdentity(),
    capabilities: [...HUB_CAPABILITIES, 'jobs', '', null, 123],
  });
  assert.equal(result.compatible, true);
  assert.equal(result.capabilities.filter((value) => value === 'jobs').length, 1);
  assert.ok(result.capabilities.every((value) => typeof value === 'string' && value.length > 0));
});
