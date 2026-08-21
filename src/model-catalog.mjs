// Read-only adapter from the DSH LLM registry to a credential-free Settings
// payload. Provider/model discovery stays owned by Harness; Crew only reads
// its registered routes and advertised catalog.

export const MODEL_CATALOG_UNAVAILABLE = 'MODEL_CATALOG_UNAVAILABLE';

export const CATALOG_HEALTH_CODES = Object.freeze({
  EMPTY_CATALOG: 'EMPTY_CATALOG',
  EMPTY_PROVIDER_MODELS: 'EMPTY_PROVIDER_MODELS',
  PROVIDER_MODEL_LIST_FAILED: 'PROVIDER_MODEL_LIST_FAILED',
  HARNESS_DEFAULT_PROVIDER_MISSING: 'HARNESS_DEFAULT_PROVIDER_MISSING',
  HARNESS_DEFAULT_MODEL_UNADVERTISED: 'HARNESS_DEFAULT_MODEL_UNADVERTISED',
  CATALOG_CONSTRAINED: 'CATALOG_CONSTRAINED',
});

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

function healthHint(code, level, { provider, model, signal } = {}) {
  return {
    code,
    level,
    ...(typeof provider === 'string' && provider ? { provider } : {}),
    ...(typeof model === 'string' && model ? { model } : {}),
    ...(typeof signal === 'string' && signal ? { signal } : {}),
  };
}

/**
 * Analyze only the effective, already-sanitized Harness catalog.
 *
 * This intentionally does not know an "expected" third-party catalog. A
 * narrow advertised list is therefore informational only: it can point a user
 * toward upstream/provider configuration, but it is never proof of a bad
 * override and never changes routing eligibility.
 */
export function analyzeCatalogHealth({ providers = [], harnessDefault = null } = {}) {
  const safeProviders = Array.isArray(providers) ? providers : [];
  const hints = [];

  if (safeProviders.length === 0) {
    hints.push(healthHint(CATALOG_HEALTH_CODES.EMPTY_CATALOG, 'warning'));
  }

  for (const provider of safeProviders) {
    const providerId = typeof provider?.id === 'string' ? provider.id : null;
    const models = Array.isArray(provider?.models) ? provider.models : [];
    if (provider?.error === 'MODEL_LIST_FAILED') {
      hints.push(healthHint(CATALOG_HEALTH_CODES.PROVIDER_MODEL_LIST_FAILED, 'warning', { provider: providerId }));
      continue;
    }
    if (models.length === 0) {
      // Some providers intentionally accept exact model ids without advertising
      // them. Keep this informational rather than turning it into a failure.
      hints.push(healthHint(CATALOG_HEALTH_CODES.EMPTY_PROVIDER_MODELS, 'info', { provider: providerId }));
    }
  }

  if (harnessDefault && typeof harnessDefault.provider === 'string' && typeof harnessDefault.model === 'string') {
    const defaultProvider = safeProviders.find((provider) => provider?.id === harnessDefault.provider);
    if (!defaultProvider) {
      hints.push(healthHint(CATALOG_HEALTH_CODES.HARNESS_DEFAULT_PROVIDER_MISSING, 'warning', {
        provider: harnessDefault.provider,
        model: harnessDefault.model,
      }));
    } else if (defaultProvider.error !== 'MODEL_LIST_FAILED' && Array.isArray(defaultProvider.models) && defaultProvider.models.length > 0) {
      const advertised = defaultProvider.models.some((model) => model?.id === harnessDefault.model);
      if (!advertised) {
        hints.push(healthHint(CATALOG_HEALTH_CODES.HARNESS_DEFAULT_MODEL_UNADVERTISED, 'info', {
          provider: harnessDefault.provider,
          model: harnessDefault.model,
        }));
      }
    }
  }

  // A single provider advertising only one or two explicit models is a useful
  // signal because local/provider overrides can produce this shape. It is only
  // an INFO heuristic: legitimate providers can also have intentionally small
  // catalogs, so Crew must not claim an override or route around it.
  const healthyProviders = safeProviders.filter((provider) => provider?.error !== 'MODEL_LIST_FAILED');
  const totalAdvertised = healthyProviders.reduce(
    (sum, provider) => sum + (Array.isArray(provider?.models) ? provider.models.length : 0),
    0,
  );
  if (healthyProviders.length === 1 && totalAdvertised > 0 && totalAdvertised <= 2) {
    hints.push(healthHint(CATALOG_HEALTH_CODES.CATALOG_CONSTRAINED, 'info', {
      provider: healthyProviders[0].id,
      signal: 'single-provider-small-explicit-catalog',
    }));
  }

  const warningCount = hints.filter((hint) => hint.level === 'warning').length;
  const infoCount = hints.filter((hint) => hint.level === 'info').length;
  return {
    schema_version: 1,
    warning_count: warningCount,
    info_count: infoCount,
    attention: warningCount > 0,
    hints,
  };
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
  const harnessDefault = safeDefault(getCurrentSelection);
  return {
    providers: hydrated,
    provider_count: hydrated.length,
    model_count: hydrated.reduce((sum, provider) => sum + provider.models.length, 0),
    harness_default: harnessDefault,
    refreshed_at: now(),
    partial: failed > 0,
    health: analyzeCatalogHealth({ providers: hydrated, harnessDefault }),
  };
}
