import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_BOUNDARY,
  activationForSetting,
  runtimeActivationMetadata,
  summarizeActivationBoundaries,
} from '../src/runtime-controls.mjs';

test('runtime activation contract classifies live, session and restart boundaries', () => {
  assert.equal(activationForSetting('max_parallel').global, ACTIVATION_BOUNDARY.LIVE);
  assert.equal(activationForSetting('max_parallel').session, null);
  assert.equal(activationForSetting('collaboration_mode').global, ACTIVATION_BOUNDARY.NEXT_WORKFLOW);
  assert.equal(activationForSetting('collaboration_mode').session, ACTIVATION_BOUNDARY.NEXT_WORKFLOW);
  assert.equal(activationForSetting('default_effort').global, ACTIVATION_BOUNDARY.NEXT_SESSION);
  assert.equal(activationForSetting('default_effort').session, ACTIVATION_BOUNDARY.NEXT_WORKFLOW);
  assert.equal(activationForSetting('hub_url').global, ACTIVATION_BOUNDARY.RESTART_REQUIRED);
  assert.equal(activationForSetting('vision_enabled').global, ACTIVATION_BOUNDARY.RESTART_REQUIRED);
  assert.equal(activationForSetting('imagegen_enabled').global, ACTIVATION_BOUNDARY.RESTART_REQUIRED);
  assert.equal(activationForSetting('missing'), null);
});

test('activation metadata is copied and summary groups persisted settings deterministically', () => {
  const metadata = runtimeActivationMetadata();
  metadata.max_parallel.global = 'tampered';
  assert.equal(runtimeActivationMetadata().max_parallel.global, 'live', 'caller mutation cannot alter the shared contract');

  const summary = summarizeActivationBoundaries();
  assert.ok(summary.live.includes('max_parallel'));
  assert.ok(summary['next-workflow'].includes('flash_model_priority'));
  assert.ok(summary['next-session'].includes('default_timeout_seconds'));
  assert.deepEqual(summary['restart-required'], ['hub_url', 'imagegen_enabled', 'vision_enabled']);
  for (const values of Object.values(summary)) {
    assert.deepEqual(values, [...values].sort(), 'summary order is stable');
  }
});
