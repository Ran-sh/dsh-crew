import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGlobalConfig, writeGlobalConfig } from '../src/install/install.mjs';

test('Settings config reads expose activation metadata but never persist it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-activation-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, 'config.json');

  const fresh = readGlobalConfig({ configFile });
  assert.equal(fresh.config_activation.max_parallel.global, 'live');
  assert.equal(fresh.config_activation.default_effort.global, 'next-session');
  assert.equal(fresh.config_activation.hub_url.global, 'restart-required');
  assert.equal(fresh.config_activation.vision_enabled.global, 'restart-required');

  const saved = writeGlobalConfig({ max_parallel: 5 }, { configFile });
  assert.equal(saved.config_activation.max_parallel.global, 'live');
  const stored = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(stored.config_activation, undefined, 'activation metadata is read-only and must not enter persisted config authority');
});
