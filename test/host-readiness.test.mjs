import test from 'node:test';
import assert from 'node:assert/strict';

import { READINESS_STATES, projectHostReadiness } from '../src/client/host-readiness.mjs';

function completeStatus() {
  return {
    codex: {
      installed: true,
      ready: true,
      components: { mcp: true, worker_role: true, reviewer_role: true, target_alignment: true },
    },
    claude: {
      installed: true,
      ready: true,
      components: { enabled: true, marketplace: true, snapshot: true, permissions: true },
    },
    zcode: {
      installed: true,
      ready: true,
      components: { mcp: true, policy: true, worker_agent: true, reviewer_agent: true, config_prompt: true, status_prompt: true, ownership: true },
    },
  };
}

test('complete structured evidence projects every 3080 integration as READY', () => {
  const rows = projectHostReadiness({
    installStatus: completeStatus(),
    runtime: { ok: true, service: 'dsh-crew-hub', runtime_version: '0.5.0', surface: 'native-crew-harness' },
    surface: 'official-bridge',
  });
  assert.deepEqual(rows.map((row) => [row.id, row.state]), [
    ['codex_mcp', READINESS_STATES.READY],
    ['ds_worker', READINESS_STATES.READY],
    ['ds_reviewer', READINESS_STATES.READY],
    ['claude_plugin', READINESS_STATES.READY],
    ['zcode_mcp', READINESS_STATES.READY],
    ['crew_harness', READINESS_STATES.READY],
    ['official_bridge', READINESS_STATES.READY],
  ]);
});

test('partial components are DEGRADED and missing evidence is never READY', () => {
  const partial = completeStatus();
  partial.codex.ready = false;
  partial.codex.components.reviewer_role = false;
  partial.claude.ready = false;
  partial.claude.components.snapshot = false;
  const partialRows = projectHostReadiness({ installStatus: partial, runtime: null, surface: 'unknown' });
  assert.equal(partialRows.find((row) => row.id === 'ds_reviewer').state, READINESS_STATES.DEGRADED);
  assert.equal(partialRows.find((row) => row.id === 'claude_plugin').state, READINESS_STATES.DEGRADED);
  assert.equal(partialRows.find((row) => row.id === 'crew_harness').state, READINESS_STATES.UNAVAILABLE);
  assert.equal(partialRows.find((row) => row.id === 'official_bridge').state, READINESS_STATES.UNKNOWN);

  const unknownRows = projectHostReadiness({
    installStatus: { codex: { installed: true }, claude: { installed: true } },
    runtime: undefined,
    surface: 'official-bridge',
  });
  assert.ok(unknownRows.filter((row) => ['codex_mcp', 'ds_worker', 'ds_reviewer', 'claude_plugin', 'zcode_mcp', 'crew_harness'].includes(row.id))
    .every((row) => row.state === READINESS_STATES.UNKNOWN));
});

test('explicit not-installed evidence projects UNAVAILABLE', () => {
  const rows = projectHostReadiness({
    installStatus: { codex: { installed: false }, claude: { installed: false }, zcode: { installed: false } },
    runtime: null,
    surface: 'native-crew-harness',
  });
  assert.ok(rows.filter((row) => ['codex_mcp', 'ds_worker', 'ds_reviewer', 'claude_plugin', 'zcode_mcp'].includes(row.id)).every((row) => row.state === READINESS_STATES.UNAVAILABLE));
});

test('Crew Harness readiness consumes the shared runtime snapshot when available', () => {
  const rows = projectHostReadiness({
    installStatus: completeStatus(),
    runtime: { ok: true, service: 'dsh-crew-hub', runtime_version: '0.5.7', surface: 'native-crew-harness' },
    surface: 'official-bridge',
    readinessSnapshot: {
      runtime: { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1' },
      readiness_matrix: { rows: [{ id: 'hub_compatibility', status: 'FAIL', reason_code: 'HUB_UNREACHABLE' }] },
    },
  });
  assert.equal(rows.find((row) => row.id === 'crew_harness').state, READINESS_STATES.UNAVAILABLE);
});
