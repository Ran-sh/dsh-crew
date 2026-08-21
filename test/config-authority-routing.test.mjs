import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeGlobalConfig } from '../src/install/install.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-config-routing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'config.json');
}

test('changing flash-only to balanced does not carry disabled pro mirror into canonical review state', (t) => {
  const file = fixture(t);
  const initial = writeGlobalConfig({}, { configFile: file });
  assert.equal(initial.collaboration_mode, 'flash-only');
  assert.equal(initial.pro_state, 'disabled');

  const balanced = writeGlobalConfig({ collaboration_mode: 'balanced' }, { configFile: file });
  assert.equal(balanced.collaboration_mode, 'balanced');
  assert.equal(balanced.worker.state, 'auto');
  assert.equal(balanced.review.state, 'manual');
  assert.equal(balanced.flash_state, 'auto');
  assert.equal(balanced.pro_state, 'auto');
});

test('custom tier-state edits do not overwrite a canonical model strategy', (t) => {
  const file = fixture(t);
  writeGlobalConfig({}, { configFile: file });
  const canonical = writeGlobalConfig({
    worker: { model_policy: { strategy: 'quality' } },
  }, { configFile: file });
  assert.equal(canonical.worker.model_policy.strategy, 'quality');

  const custom = writeGlobalConfig({ collaboration_mode: 'custom' }, { configFile: file });
  const afterState = writeGlobalConfig({ flash_state: 'manual', pro_state: 'auto' }, { configFile: file });
  assert.equal(custom.collaboration_mode, 'custom');
  assert.equal(afterState.worker.state, 'manual');
  assert.equal(afterState.review.state, 'manual');
  assert.equal(afterState.worker.model_policy.strategy, 'balanced', 'switching the preset to custom owns strategy once');

  const canonicalAgain = writeGlobalConfig({
    worker: { model_policy: { strategy: 'quality' } },
  }, { configFile: file });
  assert.equal(canonicalAgain.worker.model_policy.strategy, 'quality');
  const stateOnly = writeGlobalConfig({ flash_state: 'auto' }, { configFile: file });
  assert.equal(stateOnly.worker.model_policy.strategy, 'quality', 'tier-state command must not reset strategy');
});
