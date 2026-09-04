import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CREW_UI_SURFACES,
  classifyCrewSurface,
  surfaceResponsibilities,
} from '../src/client/surface-detection.mjs';

test('official bridge evidence selects the 3080 quick-controls surface', () => {
  const surface = classifyCrewSurface({
    bridgeStatus: { ok: true, surface: 'official-bridge', ui_role: 'control-plane' },
    runtime: { ok: true, service: 'dsh-crew-hub', surface: 'native-crew-harness' },
  });
  assert.equal(surface, CREW_UI_SURFACES.OFFICIAL);
  assert.deepEqual(surfaceResponsibilities(surface), { fullControlPlane: false, quickControlPlane: true, diagnostics: true });
});

test('native Hub evidence selects the 3210 full control plane', () => {
  const surface = classifyCrewSurface({
    bridgeStatus: null,
    runtime: { ok: true, service: 'dsh-crew-hub', surface: 'native-crew-harness', ui_role: 'runtime' },
  });
  assert.equal(surface, CREW_UI_SURFACES.NATIVE);
  assert.deepEqual(surfaceResponsibilities(surface), { fullControlPlane: true, quickControlPlane: true, diagnostics: true });
});

test('missing or contradictory evidence fails closed to diagnostics-only', () => {
  for (const evidence of [
    {},
    { bridgeStatus: { ok: true, surface: 'unexpected' }, runtime: null },
    { bridgeStatus: null, runtime: { ok: true, service: 'other' } },
  ]) {
    const surface = classifyCrewSurface(evidence);
    assert.equal(surface, CREW_UI_SURFACES.UNKNOWN);
    assert.deepEqual(surfaceResponsibilities(surface), { fullControlPlane: false, quickControlPlane: false, diagnostics: true });
  }
});
