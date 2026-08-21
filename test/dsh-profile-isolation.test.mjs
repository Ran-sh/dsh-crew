// P0 isolation regression: dsh-crew installer and real-environment test paths
// must stay inside a Crew-owned DSH home + dedicated `dsh-crew` profile and
// must never default to the user's official ~/.dsh / `web` profile or read
// official credential/settings stores. Legacy 3080 configs are only ever the
// value MIGRATED AWAY FROM, never a live Crew target.
//
// Run with: node --test test/dsh-profile-isolation.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  crewDshHome,
  crewProfileDir,
  CREW_PROFILE_NAME,
  CREW_DEFAULT_HUB_URL,
  CREW_LEGACY_HUB_URL,
  readGlobalConfig,
} from '../src/install/install.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Executable installer/test paths (not documentation prose).
const EXECUTABLE = [
  'scripts/setup.mjs',
  'scripts/smoke-real.mjs',
  'scripts/live-crew-smoke.mjs',
  'scripts/live-policy-matrix.mjs',
  'src/install/install.mjs',
];

test('isolation constants own a dedicated Crew home/profile/hub', () => {
  assert.equal(CREW_PROFILE_NAME, 'dsh-crew');
  assert.equal(CREW_DEFAULT_HUB_URL, 'http://127.0.0.1:3210');
  assert.equal(CREW_LEGACY_HUB_URL, 'http://127.0.0.1:3080', '3080 is only the legacy value migrated away from');
  const home = crewDshHome();
  assert.ok(!/\.dsh$/.test(home), `Crew DSH_HOME must not be ~/.dsh: ${home}`);
  assert.ok(/dsh-crew[\\/]harness$/.test(home), `Crew DSH_HOME must live under ~/.config/dsh-crew/harness: ${home}`);
  const prof = crewProfileDir();
  assert.ok(!/profiles[\\/]web/.test(prof), `Crew profile must not be the official web profile: ${prof}`);
  assert.ok(/profiles[\\/]dsh-crew$/.test(prof), `Crew profile must be profiles/dsh-crew: ${prof}`);
});

test('executable install/test paths do not reintroduce the official web profile or ~/.dsh reads', () => {
  for (const rel of EXECUTABLE) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(!/--profile web\b/.test(src), `${rel} must not invoke --profile web`);
    assert.ok(!/profiles[\\/]web/.test(src), `${rel} must not reference profiles/web`);
    assert.ok(!/\.dsh[\\/]\.credentials\.yaml/.test(src), `${rel} must not read ~/.dsh/.credentials.yaml`);
    assert.ok(!/\.dsh[\\/]settings\.yaml/.test(src), `${rel} must not read ~/.dsh/settings.yaml`);
    assert.ok(!/\.credentials\.yaml/.test(src), `${rel} must not read any official credentials file`);
    assert.ok(!/readDshStore|homedir\(\).*\.dsh/.test(src), `${rel} must not contain a ~/.dsh store reader`);
    const hasLegacyHub = /127\.0\.0\.1:3080/.test(src);
    if (hasLegacyHub) {
      assert.equal(rel, 'src/install/install.mjs', `only install.mjs may mention the legacy 3080 hub (as the migration FROM value)`);
      assert.ok(src.includes("CREW_LEGACY_HUB_URL = 'http://127.0.0.1:3080'"), '3080 literal must be only the legacy migration constant');
      assert.ok(src.includes('CREW_DEFAULT_HUB_URL'), 'install.mjs must also define the dedicated Crew hub default');
    }
  }
});

test('fresh and legacy-3080 configs resolve to the dedicated Crew hub URL', () => {
  // No temp file: freshConfig must default to the dedicated hub.
  const fresh = readGlobalConfig({ configFile: join(join(tmpdir(), '__dsh_crew_nonexistent_config__.json')) });
  assert.equal(fresh.hub_url, CREW_DEFAULT_HUB_URL, 'fresh Crew config must default to the dedicated hub');

  // A legacy stored config that points at the former shared-profile 3080 must
  // be safely migrated on the read path to the dedicated Crew hub, preserving
  // unrelated fields.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-isolation-'));
  try {
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({ config_schema_version: 0, hub_url: 'http://127.0.0.1:3080', collaboration_mode: 'balanced', default_effort: 'max' }));
    const migrated = readGlobalConfig({ configFile: cfg });
    assert.equal(migrated.hub_url, CREW_DEFAULT_HUB_URL, 'legacy 3080 must migrate to the dedicated Crew hub');
    assert.equal(migrated.collaboration_mode, 'balanced', 'unrelated config fields must be preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
