// Bounded provider/model callability evidence.
//
// Catalog presence is not proof of a callable route. This store keeps only
// sanitized state and timestamps; raw provider errors never leave the caller.

export const PROVIDER_HEALTH_STATES = Object.freeze([
  'callable', 'credential-missing', 'quota-exhausted', 'rate-limited',
  'timeout', 'internal-error', 'disabled', 'not-configured', 'tombstoned', 'unprobed',
]);

const REASON_CODES = Object.freeze({
  callable: 'PROVIDER_CALLABLE',
  'credential-missing': 'CREDENTIAL_MISSING',
  'quota-exhausted': 'QUOTA_EXHAUSTED',
  'rate-limited': 'RATE_LIMITED',
  timeout: 'PROBE_TIMEOUT',
  'internal-error': 'PROVIDER_INTERNAL_ERROR',
  disabled: 'PROVIDER_DISABLED',
  'not-configured': 'PROVIDER_NOT_CONFIGURED',
  tombstoned: 'PROVIDER_TOMBSTONED',
});

const DEFAULT_TTLS = Object.freeze({
  callable: 5 * 60 * 1000,
  'credential-missing': 30 * 1000,
  'quota-exhausted': 15 * 60 * 1000,
  'rate-limited': 60 * 1000,
  timeout: 60 * 1000,
  'internal-error': 60 * 1000,
  disabled: 5 * 60 * 1000,
  'not-configured': 30 * 1000,
  tombstoned: 5 * 60 * 1000,
});

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function providerKey(provider, model) {
  const p = text(provider);
  const m = text(model);
  return p && m ? `${p}\u0000${m}` : null;
}

function errorText(error) {
  if (!error || typeof error !== 'object') return '';
  return [error.code, error.name, error.message, error.status].filter((value) => value !== undefined && value !== null).join(' ').toLowerCase();
}

/** Map an upstream error to one bounded, secret-free callability state. */
export function classifyProviderError(error = {}) {
  const textValue = errorText(error);
  const code = text(error?.code)?.toUpperCase() ?? '';
  if (code === 'MISSING_CREDENTIAL' || code === 'CREDENTIAL_MISSING' || /no (api )?key|credential.*missing|missing.*credential/.test(textValue)) {
    return { state: 'credential-missing', reason_code: REASON_CODES['credential-missing'] };
  }
  if (code === 'QUOTA_EXCEEDED' || /monthly|account/.test(textValue) && /quota|exhaust|limit/.test(textValue)) {
    return { state: 'quota-exhausted', reason_code: REASON_CODES['quota-exhausted'] };
  }
  if (Number(error?.status) === 429 || code === 'RATE_LIMITED' || /rate.?limit|too many requests/.test(textValue)) {
    return { state: 'rate-limited', reason_code: REASON_CODES['rate-limited'] };
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || code === 'TIMEOUT' || /timed? out|timeout|aborted/.test(textValue)) {
    return { state: 'timeout', reason_code: REASON_CODES.timeout };
  }
  return { state: 'internal-error', reason_code: REASON_CODES['internal-error'] };
}

function boundedTimestamp(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function view(entry, now) {
  if (!entry) return { state: 'unprobed', reason_code: null, observed_at: null, expires_at: null, fresh: false };
  const fresh = now < entry.expires_at;
  if (!fresh) return { state: 'unprobed', reason_code: null, observed_at: entry.observed_at, expires_at: entry.expires_at, fresh: false };
  return { ...entry, fresh: true };
}

export function createProviderHealthStore({ clock = () => Date.now(), ttls = {}, maxEntries = 256 } = {}) {
  const records = new Map();
  const limits = { ...DEFAULT_TTLS };
  for (const state of PROVIDER_HEALTH_STATES) {
    if (Number.isFinite(ttls[state]) && ttls[state] >= 0) limits[state] = Math.min(ttls[state], 24 * 60 * 60 * 1000);
  }
  const boundedMax = Number.isInteger(maxEntries) && maxEntries > 0 ? Math.min(maxEntries, 2048) : 256;

  const get = (provider, model) => {
    const key = providerKey(provider, model);
    if (!key) return { provider: text(provider), model: text(model), state: 'unprobed', reason_code: null, observed_at: null, expires_at: null, fresh: false };
    const entry = records.get(key);
    const current = view(entry, clock());
    if (entry && !current.fresh) records.delete(key);
    return { provider: text(provider), model: text(model), ...current };
  };

  const record = (provider, model, result = {}) => {
    const key = providerKey(provider, model);
    if (!key) return null;
    const now = clock();
    const observed = boundedTimestamp(result.observed_at, now);
    const previous = records.get(key);
    if (previous && previous.observed_at > observed) return get(provider, model);
    let classified;
    if (result.ok === true) classified = { state: 'callable', reason_code: REASON_CODES.callable };
    else if (PROVIDER_HEALTH_STATES.includes(result.state) && result.state !== 'unprobed') classified = { state: result.state, reason_code: REASON_CODES[result.state] ?? null };
    else classified = classifyProviderError(result.error ?? result);
    const expires = observed + limits[classified.state];
    records.set(key, {
      provider: text(provider), model: text(model), ...classified,
      observed_at: observed, expires_at: expires,
    });
    while (records.size > boundedMax) {
      const oldest = [...records.entries()].sort((a, b) => a[1].observed_at - b[1].observed_at)[0]?.[0];
      if (!oldest) break;
      records.delete(oldest);
    }
    return get(provider, model);
  };

  const list = () => [...records.values()].map((entry) => view(entry, clock())).filter((entry) => entry.fresh).slice(0, boundedMax);

  return { get, record, list, ttls: { ...limits }, maxEntries: boundedMax };
}
