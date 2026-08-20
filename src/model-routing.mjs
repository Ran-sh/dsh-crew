// Pure Harness-backed worker model selection. A worker tier describes a role,
// not a fixed model: explicit provider/model priorities win, fresh configs may
// use a tier-specific preferred model id, and Harness Default is the final
// fallback. Catalog membership is advisory; provider registration is the
// routing boundary.

export const DEFAULT_TIER_MODEL_PREFERENCES = Object.freeze({
  flash: 'deepseek-v4-flash',
  pro: 'deepseek-v4-pro',
});

export const MODEL_FALLBACKS = ['harness-default'];
export const NO_WORKER_MODEL_AVAILABLE = 'NO_WORKER_MODEL_AVAILABLE';

export function normalizeModelRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  return provider && model ? { provider, model } : null;
}

export function modelRefKey(raw) {
  const ref = normalizeModelRef(raw);
  return ref ? `${ref.provider}\0${ref.model}` : '';
}

export function normalizeModelPriority(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const value of raw) {
    const ref = normalizeModelRef(value);
    if (!ref) continue;
    const key = modelRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function providerMap(catalog) {
  const map = new Map();
  for (const raw of catalog?.providers ?? []) {
    if (!raw || typeof raw.id !== 'string' || raw.id === '') continue;
    map.set(raw.id, raw);
  }
  return map;
}

function defaultResult(harnessDefault, providers) {
  const ref = normalizeModelRef(harnessDefault);
  if (!ref || !providers.has(ref.provider)) return null;
  return {
    ok: true,
    ...ref,
    source: 'harness-default',
    ...(typeof harnessDefault.reasoningEffort === 'string' && harnessDefault.reasoningEffort
      ? { reasoningEffort: harnessDefault.reasoningEffort }
      : {}),
  };
}
export function resolveWorkerModel({
  tier,
  priority,
  priorityConfigured = false,
  catalog,
  harnessDefault,
  fallback = 'harness-default',
  preferredModelId = DEFAULT_TIER_MODEL_PREFERENCES[tier],
} = {}) {
  const providers = providerMap(catalog);
  const normalizedPriority = normalizeModelPriority(priority);

  for (let index = 0; index < normalizedPriority.length; index++) {
    const ref = normalizedPriority[index];
    const provider = providers.get(ref.provider);
    if (!provider) continue;
    const advertised = (provider.models ?? []).some((model) => model?.id === ref.model);
    return {
      ok: true,
      ...ref,
      source: 'priority',
      matchedPriorityIndex: index,
      ...(advertised ? {} : { advertised: false }),
    };
  }

  // A manually managed list, including an intentionally empty list, replaces
  // the fresh-config recommendation rather than silently re-inserting it.
  if (!priorityConfigured && normalizedPriority.length === 0 && typeof preferredModelId === 'string') {
    const matches = [];
    for (const provider of providers.values()) {
      if ((provider.models ?? []).some((model) => model?.id === preferredModelId)) {
        matches.push({ provider: provider.id, model: preferredModelId });
      }
    }
    if (matches.length === 1) return { ok: true, ...matches[0], source: 'preferred-default' };
    if (matches.length > 1) {
      const preferredProvider = normalizeModelRef(harnessDefault)?.provider;
      const match = matches.find((candidate) => candidate.provider === preferredProvider);
      if (match) return { ok: true, ...match, source: 'preferred-default' };
    }
  }

  if (fallback === 'harness-default') {
    const resolvedDefault = defaultResult(harnessDefault, providers);
    if (resolvedDefault) return resolvedDefault;
  }
  return {
    ok: false,
    code: NO_WORKER_MODEL_AVAILABLE,
    message: `No Harness model is available for the ${tier ?? 'requested'} worker.`,
  };
}

