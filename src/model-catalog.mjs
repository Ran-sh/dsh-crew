// Read-only adapter from the DSH LLM registry to a credential-free Settings
// payload. Harness remains the provider registry/routing boundary. For a
// registered provider whose Harness model list is known to be incomplete, Crew
// may supplement model ids from that provider's own public, credential-free
// catalog. No provider credential is ever sent by this adapter.

export const MODEL_CATALOG_UNAVAILABLE = 'MODEL_CATALOG_UNAVAILABLE';

const PUBLIC_PROVIDER_CATALOGS = Object.freeze({
  'opencode-go': 'https://opencode.ai/zen/go/v1/models',
});
const PUBLIC_CATALOG_CACHE = new Map();
const PUBLIC_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const PUBLIC_CATALOG_TIMEOUT_MS = 1500;

function catalogError() {
  return Object.assign(new Error('Unable to read Harness model catalog.'), { code: MODEL_CATALOG_UNAVAILABLE });
}

function normalizeProvider(raw) {
  if (!raw || typeof raw.id !== 'string' || raw.id.trim() === '') return null;
  const id = raw.id.trim();
  return { id, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id };
}

function normalizeModels(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    if (!item || typeof item.id !== 'string' || item.id.trim() === '') continue;
    const id = item.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
      ...(typeof item.description === 'string' && item.description.trim() ? { description: item.description.trim() } : {}),
      ...(Array.isArray(item.inputModalities) ? { inputModalities: item.inputModalities.filter((v) => v === 'text' || v === 'image') } : {}),
    });
  }
  return result;
}

function mergeModels(primary, supplemental) {
  const result = [...primary];
  const seen = new Set(primary.map((model) => model.id));
  for (const model of supplemental) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    result.push({ ...model, source: 'provider-public-catalog' });
  }
  return result;
}

function needsPublicSupplement(providerId, models) {
  if (!(providerId in PUBLIC_PROVIDER_CATALOGS)) return false;
  if (providerId !== 'opencode-go') return true;
  const ids = models.map((model) => model.id.toLowerCase());
  // OpenCode Go publicly advertises both families. If Harness already exposes
  // them, stay entirely Harness-backed and avoid the external lookup.
  return !ids.some((id) => id.startsWith('mimo-')) || !ids.some((id) => id.startsWith('qwen'));
}

async function readPublicProviderModels(providerId, {
  fetchImpl = globalThis.fetch,
  nowMs = () => Date.now(),
  cacheTtlMs = PUBLIC_CATALOG_CACHE_TTL_MS,
  timeoutMs = PUBLIC_CATALOG_TIMEOUT_MS,
} = {}) {
  const url = PUBLIC_PROVIDER_CATALOGS[providerId];
  if (!url || typeof fetchImpl !== 'function') return [];
  const now = nowMs();
  const cached = PUBLIC_CATALOG_CACHE.get(providerId);
  if (cacheTtlMs > 0 && cached && cached.expiresAt > now) return cached.models;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  timer?.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response?.ok || typeof response.json !== 'function') return [];
    const payload = await response.json();
    const models = normalizeModels(payload?.data);
    if (models.length > 0 && cacheTtlMs > 0) {
      PUBLIC_CATALOG_CACHE.set(providerId, { models, expiresAt: now + cacheTtlMs });
    }
    return models;
  } catch {
    // Supplemental discovery is strictly best-effort. Harness data remains the
    // source of truth if the provider endpoint is offline, blocked or changes.
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeDefault(getCurrentSelection) {
  try {
    const raw = typeof getCurrentSelection === 'function' ? getCurrentSelection() : undefined;
    if (!raw || typeof raw.provider !== 'string' || typeof raw.model !== 'string') return null;
    return {
      provider: raw.provider,
      model: raw.model,
      ...(typeof raw.reasoningEffort === 'string' ? { reasoningEffort: raw.reasoningEffort } : {}),
    };
  } catch {
    return null;
  }
}

export async function readHarnessModelCatalog({
  llm,
  getCurrentSelection,
  now = () => new Date().toISOString(),
  fetchImpl = globalThis.fetch,
  publicCatalogNowMs = () => Date.now(),
  publicCatalogCacheTtlMs = PUBLIC_CATALOG_CACHE_TTL_MS,
  publicCatalogTimeoutMs = PUBLIC_CATALOG_TIMEOUT_MS,
} = {}) {
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') throw catalogError();
  let rawProviders;
  try {
    rawProviders = llm.listProviders();
  } catch {
    throw catalogError();
  }
  if (!Array.isArray(rawProviders)) throw catalogError();
  const providers = rawProviders.map(normalizeProvider).filter(Boolean);
  let failed = 0;
  const hydrated = await Promise.all(providers.map(async (provider) => {
    let harnessModels = [];
    let harnessFailed = false;
    try {
      harnessModels = normalizeModels(await llm.listModels(provider.id));
    } catch {
      failed += 1;
      harnessFailed = true;
    }

    let models = harnessModels;
    if (needsPublicSupplement(provider.id, harnessModels)) {
      const supplemental = await readPublicProviderModels(provider.id, {
        fetchImpl,
        nowMs: publicCatalogNowMs,
        cacheTtlMs: publicCatalogCacheTtlMs,
        timeoutMs: publicCatalogTimeoutMs,
      });
      models = mergeModels(harnessModels, supplemental);
    }

    return {
      ...provider,
      models,
      ...(harnessFailed ? { error: 'MODEL_LIST_FAILED' } : {}),
    };
  }));
  return {
    providers: hydrated,
    provider_count: hydrated.length,
    model_count: hydrated.reduce((sum, provider) => sum + provider.models.length, 0),
    harness_default: safeDefault(getCurrentSelection),
    refreshed_at: now(),
    partial: failed > 0,
  };
}
