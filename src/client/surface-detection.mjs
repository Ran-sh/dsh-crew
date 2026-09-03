export const CREW_UI_SURFACES = Object.freeze({
  OFFICIAL: 'official-bridge',
  NATIVE: 'native-crew-harness',
  UNKNOWN: 'unknown',
});

/**
 * Classify the current same-origin UI from explicit backend contracts. The
 * official bridge signal wins because its proxied runtime response correctly
 * describes the 3210 backend, not the browser-facing 3080 surface.
 */
export function classifyCrewSurface({ bridgeStatus, runtime } = {}) {
  if (bridgeStatus?.ok === true
    && (bridgeStatus.surface === CREW_UI_SURFACES.OFFICIAL
      || bridgeStatus.mode === 'official-3080-isolated-3210')) {
    return CREW_UI_SURFACES.OFFICIAL;
  }
  if (runtime?.ok === true
    && runtime.service === 'dsh-crew-hub'
    && (runtime.surface === CREW_UI_SURFACES.NATIVE || runtime.surface === undefined)) {
    return CREW_UI_SURFACES.NATIVE;
  }
  return CREW_UI_SURFACES.UNKNOWN;
}

/**
 * Surface capability model. The NATIVE 3210 Crew harness is the single full
 * control plane; the OFFICIAL 3080 surface is a narrow quick-controls panel
 * (total switch, flash/pro model priority, vision/imagegen toggles) plus a
 * deep link back to 3210. Unknown surfaces get diagnostics only — never write
 * authority. This replaces the old binary full-vs-minimal assumption.
 */
export function surfaceResponsibilities(surface) {
  switch (surface) {
    case CREW_UI_SURFACES.NATIVE:
      return { fullControlPlane: true, quickControlPlane: true, diagnostics: true };
    case CREW_UI_SURFACES.OFFICIAL:
      return { fullControlPlane: false, quickControlPlane: true, diagnostics: true };
    default:
      return { fullControlPlane: false, quickControlPlane: false, diagnostics: true };
  }
}

