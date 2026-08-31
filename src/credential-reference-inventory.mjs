// Secret-free credential reference inventory. This module only handles
// provider reference names/handles and ownership metadata; it never resolves
// or reads credential values.

const OWNERSHIP = new Map([
  ['crew', 'crew-owned'],
  ['crew-owned', 'crew-owned'],
  ['user', 'user-owned'],
  ['user-owned', 'user-owned'],
  ['harness', 'harness-owned'],
  ['harness-owned', 'harness-owned'],
  ['external', 'external'],
  ['external-env', 'external'],
]);

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = text(value.kind);
  const name = text(value.name_or_handle);
  const ownership = OWNERSHIP.get(text(value.ownership)?.toLowerCase() ?? '');
  if (!kind || !name || !ownership) return null;
  return { kind, name_or_handle: name, ownership };
}

function capability(ownership, orphan) {
  if (ownership !== 'crew-owned') return 'report-only';
  return orphan ? 'eligible' : 'eligible-after-last-consumer';
}

export function buildCredentialReferenceInventory({ providers = [], additional_refs: additionalRefs = [] } = {}) {
  const entries = new Map();
  const add = (ref, consumer) => {
    const normalized = normalizeReference(ref);
    if (!normalized) return;
    const referenceId = `${normalized.kind}:${normalized.name_or_handle}`;
    const current = entries.get(referenceId) ?? {
      reference_id: referenceId,
      kind: normalized.kind,
      name_or_handle: normalized.name_or_handle,
      ownership: normalized.ownership,
      consumers: new Set(),
    };
    // Conflicting ownership is deliberately conservative: never upgrade a
    // reference into a purge-eligible class based on one declaration.
    if (current.ownership !== normalized.ownership) current.ownership = 'unknown';
    if (typeof consumer === 'string' && consumer.trim()) current.consumers.add(consumer.trim());
    entries.set(referenceId, current);
  };

  for (const provider of Array.isArray(providers) ? providers : []) {
    const providerId = text(provider?.id);
    if (!providerId) continue;
    for (const ref of Array.isArray(provider?.credential_refs) ? provider.credential_refs : []) add(ref, providerId);
  }
  for (const ref of Array.isArray(additionalRefs) ? additionalRefs : []) add(ref, null);

  const records = [...entries.values()].map((entry) => {
    const consumers = [...entry.consumers].sort();
    const orphan = consumers.length === 0;
    return {
      reference_id: entry.reference_id,
      kind: entry.kind,
      name_or_handle: entry.name_or_handle,
      ownership: entry.ownership,
      consumers,
      consumer_count: consumers.length,
      orphan,
      purge_capability: entry.ownership === 'unknown' ? 'report-only' : capability(entry.ownership, orphan),
    };
  }).sort((a, b) => a.reference_id.localeCompare(b.reference_id));
  return { ok: true, schema_version: 1, records };
}
