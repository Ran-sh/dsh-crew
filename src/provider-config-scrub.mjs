// Pure policy-reference scrub used by provider deletion transactions.
// It removes only provider/model references, never credentials or unrelated
// settings, and keeps explicit `priorityConfigured` semantics intact.

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function cloneConfig(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function ensureProviderIds(providerIds) {
  if (!Array.isArray(providerIds)) throw new TypeError('provider ids must be an array');
  const result = [];
  const seen = new Set();
  for (const id of providerIds) {
    if (!validId(id)) throw new TypeError('provider id must be a bounded identifier');
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  if (result.length === 0) throw new TypeError('provider ids must not be empty');
  return result;
}

function scrubList(list, blocked, removed) {
  if (!Array.isArray(list)) return list;
  return list.filter((entry) => {
    const provider = entry && typeof entry === 'object' ? entry.provider : null;
    if (!blocked.has(provider)) return true;
    if (!removed.includes(provider)) removed.push(provider);
    return false;
  });
}

function scrubPolicy(policy, blocked, removed) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return;
  for (const key of ['priority', 'escalation_priority']) {
    if (Array.isArray(policy[key])) policy[key] = scrubList(policy[key], blocked, removed);
  }
}

function scrubDefault(config, key, blocked, removed) {
  const value = config[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (!blocked.has(value.provider)) return;
  if (!removed.includes(value.provider)) removed.push(value.provider);
  config[key] = null;
}

/** Remove references to provider ids from all known canonical/legacy policy mirrors. */
export function scrubProviderReferences(config, providerIds) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('config must be an object');
  const ids = ensureProviderIds(providerIds);
  const blocked = new Set(ids);
  const next = cloneConfig(config);
  const removed = [];

  for (const key of ['flash_model_priority', 'pro_model_priority']) {
    if (Array.isArray(next[key])) next[key] = scrubList(next[key], blocked, removed);
  }
  scrubPolicy(next.worker?.model_policy, blocked, removed);
  scrubPolicy(next.review?.model_policy, blocked, removed);
  for (const key of ['harness_default', 'agent_default_model', 'agentDefaultModel']) scrubDefault(next, key, blocked, removed);

  return { config: next, removed };
}
