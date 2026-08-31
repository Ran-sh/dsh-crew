// Reconcile Crew-owned provider declarations with persisted lifecycle intent.
// Tombstones are lifecycle state, not a shadow catalog: they only prevent a
// previously deleted managed route from being re-seeded during install/update.

import {
  inspectProviderProfile,
  removeProviderDeclarations,
} from './provider-profile-store.mjs';

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function reconcileProviderDesiredState(source, { tombstones = {}, expectedRevision } = {}) {
  const requested = Object.entries(tombstones ?? {})
    .filter(([id, state]) => state === 'absent' && PROVIDER_ID.test(id))
    .map(([id]) => id);
  if (requested.length === 0) return { ok: true, changed: false, removed: [], text: source };

  const inspected = inspectProviderProfile(source);
  if (!inspected.ok) return { ok: false, code: inspected.code, revision: inspected.revision };
  const declared = new Set(inspected.providerIds);
  const toRemove = requested.filter((id) => declared.has(id));
  if (toRemove.length === 0) return { ok: true, changed: false, removed: [], text: source, revision: inspected.revision };

  const result = removeProviderDeclarations(source, {
    providerIds: toRemove,
    expectedRevision: expectedRevision ?? inspected.revision,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    changed: true,
    removed: result.removed,
    remaining: result.remaining,
    text: result.text,
    revision: result.revision,
  };
}
