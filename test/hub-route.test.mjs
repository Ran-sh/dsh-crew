// Regression tests for the P0 Hub tier-enforcement fix: the tier that
// actually reaches the worker runtime must be the policy resolver's effective
// tier, not the raw (or missing) request field. Exercises resolveHubSpawnPayload
// — the exact same pure helper the hub jobs route uses — so "resolver output"
// and "spawn input" are the same object.
//
// Run with: node --test test/hub-route.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHubSpawnPayload } from '../src/hub/index.mjs';

const raw = (patch = {}) => ({ ...patch });
const cfg = (patch = {}) => ({
  default_tier: 'flash',
  tier_policy: 'auto',
  collaboration_mode: 'balanced',
  flash_state: 'auto',
  pro_state: 'auto',
  subagents_enabled: true,
  ...patch,
});

test('Case 1: pro-only + missing tier → hub.spawn receives tier=pro', () => {
  const r = resolveHubSpawnPayload(raw({ task: 'x' }), () => cfg({ collaboration_mode: 'pro-only' }));
  assert.equal(r.ok, true);
  assert.equal(r.payload.tier, 'pro');
});

test('Case 2: flash-only + missing tier → hub.spawn receives tier=flash', () => {
  const r = resolveHubSpawnPayload(raw({ task: 'x' }), () => cfg({ collaboration_mode: 'flash-only' }));
  assert.equal(r.ok, true);
  assert.equal(r.payload.tier, 'flash');
});

test('Case 3: pro-only + explicit tier=flash → clamped to pro (same semantics as the MCP server)', () => {
  // The MCP layer rejects TIER_DISABLED; the hub must not silently diverge, so
  // the shared resolver returns the same rejection with the same code.
  const r = resolveHubSpawnPayload(raw({ task: 'x', tier: 'flash' }), () => cfg({ collaboration_mode: 'pro-only' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TIER_DISABLED');
  assert.equal(r.payload, undefined);
});

test('Case 4: subagents_enabled=false → no spawn (rejected, payload undefined)', () => {
  const r = resolveHubSpawnPayload(raw({ task: 'x' }), () => cfg({ subagents_enabled: false }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUBAGENTS_DISABLED');
  assert.equal(r.payload, undefined);
});

test('Case 5: custom flash disabled / pro auto + no tier → actual tier is pro', () => {
  const r = resolveHubSpawnPayload(raw({ task: 'x' }), () => cfg({ collaboration_mode: 'custom', flash_state: 'disabled', pro_state: 'auto' }));
  assert.equal(r.ok, true);
  assert.equal(r.payload.tier, 'pro');
});

test('Case 6: both tiers disabled → no spawn', () => {
  const r = resolveHubSpawnPayload(raw({ task: 'x' }), () => cfg({ collaboration_mode: 'custom', flash_state: 'disabled', pro_state: 'disabled' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_WORKER_TIER');
  assert.equal(r.payload, undefined);
});

test('balanced + no tier + default_tier=flash → flash (existing default behavior preserved)', () => {
  const r = resolveHubSpawnPayload(raw({ task: 'x' }), () => cfg({ collaboration_mode: 'balanced', default_tier: 'flash' }));
  assert.equal(r.ok, true);
  assert.equal(r.payload.tier, 'flash');
});

test('other payload fields pass through untouched', () => {
  const r = resolveHubSpawnPayload(raw({ task: 't', effort: 'max', cwd: '/w', preset: 'minimal' }), () => cfg({ collaboration_mode: 'flash-only' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload, { task: 't', effort: 'max', cwd: '/w', preset: 'minimal', tier: 'flash' });
});
