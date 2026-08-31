import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHubExecutionMode } from '../src/hub-compatibility.mjs';
import { HUB_COMPATIBILITY_CODES } from '../src/runtime-identity.mjs';

const compatible = { reachable: true, compatible: true, code: null };
const unreachable = { reachable: false, compatible: false, code: HUB_COMPATIBILITY_CODES.UNREACHABLE };
const legacy = { reachable: true, compatible: false, code: HUB_COMPATIBILITY_CODES.PROTOCOL_MISSING, missing_capabilities: [] };

test('auto uses a compatible Hub', () => {
  assert.deepEqual(resolveHubExecutionMode('auto', compatible), {
    ok: true,
    mode: 'hub',
    reason: 'compatible-hub',
  });
});

test('auto intentionally falls back only when Hub is unreachable', () => {
  const decision = resolveHubExecutionMode('auto', unreachable);
  assert.equal(decision.ok, true);
  assert.equal(decision.mode, 'standalone');
  assert.equal(decision.reason, 'hub-unreachable-fallback');
});

test('auto fails closed when Hub is reachable but incompatible', () => {
  const decision = resolveHubExecutionMode('auto', legacy);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, HUB_COMPATIBILITY_CODES.PROTOCOL_MISSING);
  assert.match(decision.error, /reachable but incompatible/i);
  assert.match(decision.error, /update\/restart/i);
});

test('explicit hub mode reports unreachable with a stable code', () => {
  const decision = resolveHubExecutionMode('hub', unreachable);
  assert.equal(decision.ok, false);
  assert.equal(decision.code, HUB_COMPATIBILITY_CODES.UNREACHABLE);
  assert.match(decision.error, /not reachable/i);
});

test('explicit standalone ignores Hub compatibility state', () => {
  assert.deepEqual(resolveHubExecutionMode('standalone', legacy), {
    ok: true,
    mode: 'standalone',
    reason: 'explicit-standalone',
  });
});

test('production 3210 transport fails closed instead of falling back to standalone', () => {
  const decision = resolveHubExecutionMode('auto', unreachable, { productionOnly: true });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, HUB_COMPATIBILITY_CODES.UNREACHABLE);
  assert.match(decision.error, /3210|not reachable/i);
});

test('production 3210 transport rejects explicit standalone mode', () => {
  const decision = resolveHubExecutionMode('standalone', compatible, { productionOnly: true });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'STANDALONE_EXECUTION_DISABLED');
});
