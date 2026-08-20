// Read-only adapter from the DSH LLM registry to a credential-free Settings
// payload. Provider/model discovery stays owned by Harness; Crew only reads
// its registered routes and advertised catalog.

export const MODEL_CATALOG_UNAVAILABLE = 'MODEL_CATALOG_UNAVAILABLE';

function catalogError() {
  return Object.assign(new Error('Unable to read Harness model catalog.'), { code: MODEL_CATALOG_UNAVAILABLE });
}

function normalizeProvider(raw) {
  if (!raw || typeof raw.id !== 'string' || raw.id.trim() === '') return null;
  const id = raw.id.trim();
  return { id, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id };
}

function normalizeModels(raw, provider) {
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

export async function readHarnessModelCatalog({ llm, getCurrentSelection, now = () => new Date().toISOString() } = {}) {
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
    try {
      return { ...provider, models: normalizeModels(await llm.listModels(provider.id), provider.id) };
    } catch {
      failed += 1;
      return { ...provider, models: [], error: 'MODEL_LIST_FAILED' };
    }
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
