// Structure-aware access to the Crew-owned Harness settings.yaml provider map.
// Only the known llm-pi-ai.providers mapping is mutable; arbitrary YAML and
// credential values are never deserialized or returned.

import { createHash } from 'node:crypto';

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function indentOf(line) { return (line.match(/^\s*/u) ?? [''])[0].length; }
function nonBlank(line) { return line.trim() !== '' && !line.trimStart().startsWith('#'); }
function scalarField(lines, entry, field) {
  const pattern = new RegExp(`^\\s+${field}:\\s*(.*?)\\s*$`);
  for (const line of lines.slice(entry.start, entry.end)) {
    const match = line.match(pattern);
    if (!match) continue;
    const value = match[1].trim();
    if (!value) return null;
    return value.replace(/^(?:"([\\s\\S]*)"|'([\\s\\S]*)')$/u, '$1$2');
  }
  return null;
}

function parseDefaultModel(source) {
  if (typeof source !== 'string') return { ok: false, code: 'PROVIDER_SETTINGS_DEFAULT_UNSUPPORTED' };
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^agent-default-model:\s*$/u.test(line));
  if (start < 0) return { ok: false, code: 'PROVIDER_SETTINGS_DEFAULT_UNSUPPORTED' };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (indentOf(lines[index]) === 0 && nonBlank(lines[index])) { end = index; break; }
  }
  const providerLine = lines.findIndex((line, index) => index > start && index < end && /^ {2}provider:\s*\S.*$/u.test(line));
  const modelLine = lines.findIndex((line, index) => index > start && index < end && /^ {2}model:\s*\S.*$/u.test(line));
  const provider = providerLine >= 0 ? lines[providerLine].replace(/^ {2}provider:\s*/u, '').trim() : null;
  const model = modelLine >= 0 ? lines[modelLine].replace(/^ {2}model:\s*/u, '').trim() : null;
  if (!provider || !model) return { ok: false, code: 'PROVIDER_SETTINGS_DEFAULT_UNSUPPORTED' };
  return { ok: true, lines, start, end, providerLine, modelLine, provider, model };
}

function parseProviderMap(source) {
  if (typeof source !== 'string') return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
  const lines = source.split(/\r?\n/u);
  const llmStart = lines.findIndex((line) => /^llm-pi-ai:\s*$/u.test(line));
  if (llmStart < 0) return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
  let blockEnd = lines.length;
  for (let index = llmStart + 1; index < lines.length; index += 1) {
    if (indentOf(lines[index]) === 0 && nonBlank(lines[index])) { blockEnd = index; break; }
  }
  const providersLine = lines.findIndex((line, index) => index > llmStart && index < blockEnd && /^ {2}providers:\s*(?:\{\s*\})?\s*$/u.test(line));
  if (providersLine < 0) return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
  let providersBlockEnd = blockEnd;
  for (let index = providersLine + 1; index < blockEnd; index += 1) {
    if (nonBlank(lines[index]) && indentOf(lines[index]) <= 2) { providersBlockEnd = index; break; }
  }
  const providerIndent = 4;
  const entries = [];
  for (let index = providersLine + 1; index < blockEnd; index += 1) {
    const line = lines[index];
    if (!nonBlank(line)) continue;
    const indent = indentOf(line);
    if (indent < providerIndent) {
      if (indent > 2) return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
      break;
    }
    if (indent !== providerIndent) continue;
    const match = line.match(/^ {4}([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/u);
    if (!match) return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
    let end = index + 1;
    while (end < blockEnd) {
      const next = lines[end];
      if (nonBlank(next) && indentOf(next) <= providerIndent) break;
      end += 1;
    }
    entries.push({ id: match[1], start: index, end });
    index = end - 1;
  }
  return { ok: true, lines, llmStart, blockEnd, providersLine, providersBlockEnd, entries };
}

const SENSITIVE_CREDENTIAL_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential|private[_-]?key|client[_-]?secret|cookie|bearer|webhook)/iu;
const REFERENCE_FIELD_SUFFIX = /(?:env|ref|name|handle|id|file|path)$/iu;

function isInlineCredentialLine(line) {
  const inlineKeys = [...line.matchAll(/["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*:/gu)].map((match) => match[1]);
  if (inlineKeys.some((field) => SENSITIVE_CREDENTIAL_FIELD.test(field) && !REFERENCE_FIELD_SUFFIX.test(field.replace(/[_.-]/gu, '')))) return true;
  const match = line.match(/^\s*["']?([A-Za-z][A-Za-z0-9_.-]*)["']?\s*:\s*(.*?)\s*$/u);
  if (!match) return false;
  const [, field, value] = match;
  if (!value || /^(?:null|~|\{\}|\[\])$/u.test(value)) return false;
  const normalized = field.replace(/[_.-]/gu, '');
  if (SENSITIVE_CREDENTIAL_FIELD.test(field) && !REFERENCE_FIELD_SUFFIX.test(normalized)) return true;
  return /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization|credential|private[_-]?key|client[_-]?secret|cookie|bearer|webhook)\s*["']?\s*:/iu.test(value);
}

export function hasInlineProviderCredentials(source, { providerIds = [] } = {}) {
  const parsed = parseProviderMap(source);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  const requested = providerIds.length > 0 ? new Set(providerIds) : null;
  const providers = parsed.entries.filter((entry) => !requested || requested.has(entry.id));
  return { ok: true, inline: providers.some((entry) => parsed.lines.slice(entry.start, entry.end).some(isInlineCredentialLine)) };
}

export function inspectProviderSettings(source) {
  const revision = typeof source === 'string' ? sha256(source) : null;
  const parsed = parseProviderMap(source);
  if (!parsed.ok) return { ok: false, code: parsed.code, revision };
  return { ok: true, schema: 'harness-settings-llm-pi-ai-v1', providerIds: parsed.entries.map((entry) => entry.id), revision };
}

export function readProviderSettingsDeclarations(source, { file = 'harness/settings.yaml' } = {}) {
  const parsed = parseProviderMap(source);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  return {
    ok: true,
    declarations: parsed.entries.map((entry) => {
      const credentialRef = scalarField(parsed.lines, entry, 'apiKeyEnv');
      return {
        id: entry.id,
        display_name: scalarField(parsed.lines, entry, 'displayName') ?? entry.id,
        origin: 'profile-managed',
        ownership: 'crew-managed-profile',
        file,
        declaration_authority: { kind: 'harness-settings', locator: `llm-pi-ai.providers.${entry.id}` },
        ...(credentialRef ? { credential_ref: { kind: 'env', name_or_handle: credentialRef, ownership: 'unknown' } } : {}),
      };
    }),
  };
}

export function readHarnessDefault(source) {
  const parsed = parseDefaultModel(source);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  return { ok: true, provider: parsed.provider, model: parsed.model, locator: 'agent-default-model' };
}

export function replaceHarnessDefault(source, { provider, model, expectedRevision } = {}) {
  const currentRevision = typeof source === 'string' ? sha256(source) : null;
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) return { ok: false, code: 'PROVIDER_SETTINGS_CHANGED', revision: currentRevision };
  if (typeof provider !== 'string' || !PROVIDER_ID.test(provider) || typeof model !== 'string' || !model.trim()) return { ok: false, code: 'PROVIDER_DEFAULT_REPLACEMENT_REQUIRED', revision: currentRevision };
  const parsed = parseDefaultModel(source);
  if (!parsed.ok) return { ok: false, code: parsed.code, revision: currentRevision };
  const lines = [...parsed.lines];
  lines[parsed.providerLine] = `  provider: ${provider.trim()}`;
  lines[parsed.modelLine] = `  model: ${model.trim()}`;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const text = lines.join(newline);
  return { ok: true, text, previous: { provider: parsed.provider, model: parsed.model }, revision: sha256(text) };
}

/**
 * Apply all Harness settings mutations needed by one provider-delete plan in
 * memory, then return one revision-bound text result for a single atomic write.
 * This prevents replacing agent-default-model and removing its provider from
 * racing each other on the same settings revision.
 */
export function mutateProviderSettings(source, {
  providerId = null,
  removeProvider = false,
  replacementDefault = null,
  replacementModel = null,
  expectedRevision,
} = {}) {
  const currentRevision = typeof source === 'string' ? sha256(source) : null;
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) return { ok: false, code: 'PROVIDER_SETTINGS_CHANGED', revision: currentRevision };
  const parsed = removeProvider ? parseProviderMap(source) : { ok: true, lines: typeof source === 'string' ? source.split(/\r?\n/u) : [] };
  if (!parsed.ok) return { ok: false, code: parsed.code, revision: currentRevision };
  let providerEntry = null;
  if (removeProvider) {
    if (typeof providerId !== 'string' || !PROVIDER_ID.test(providerId)) return { ok: false, code: 'PROVIDER_NOT_FOUND', revision: currentRevision };
    providerEntry = parsed.entries.find((entry) => entry.id === providerId) ?? null;
    if (!providerEntry) return { ok: false, code: 'PROVIDER_NOT_FOUND', revision: currentRevision };
  }
  let defaultParsed = null;
  if (replacementDefault !== null || replacementModel !== null) {
    if (typeof replacementDefault !== 'string' || !PROVIDER_ID.test(replacementDefault) || typeof replacementModel !== 'string' || !replacementModel.trim()) return { ok: false, code: 'PROVIDER_DEFAULT_REPLACEMENT_REQUIRED', revision: currentRevision };
    defaultParsed = parseDefaultModel(source);
    if (!defaultParsed.ok) return { ok: false, code: defaultParsed.code, revision: currentRevision };
    if (providerId && defaultParsed.provider !== providerId) return { ok: false, code: 'PROVIDER_DEFAULT_AUTHORITY_CHANGED', revision: currentRevision };
  }
  const ranges = providerEntry ? [[providerEntry.start, providerEntry.end]] : [];
  const finalProvider = providerEntry && parsed.entries.length === 1;
  const nextLines = parsed.lines.map((line, index) => {
    if (ranges.some(([start, end]) => index >= start && index < end)) return null;
    if (finalProvider && index === parsed.providersLine) return '  providers: {}';
    if (defaultParsed?.providerLine === index) return `  provider: ${replacementDefault.trim()}`;
    if (defaultParsed?.modelLine === index) return `  model: ${replacementModel.trim()}`;
    return line;
  }).filter((line) => line !== null);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const text = nextLines.join(newline);
  return {
    ok: true,
    text,
    ...(providerEntry ? { removed: [providerId], remaining: parsed.entries.filter((entry) => entry.id !== providerId).map((entry) => entry.id) } : { removed: [], remaining: parsed.entries?.map((entry) => entry.id) ?? [] }),
    ...(defaultParsed ? { previous_default: { provider: defaultParsed.provider, model: defaultParsed.model } } : {}),
    revision: sha256(text),
  };
}

export function removeProviderSettings(source, { providerIds = [], expectedRevision } = {}) {
  const currentRevision = typeof source === 'string' ? sha256(source) : null;
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) return { ok: false, code: 'PROVIDER_SETTINGS_CHANGED', revision: currentRevision };
  const requested = [...new Set(providerIds.filter((id) => typeof id === 'string' && PROVIDER_ID.test(id)))];
  if (requested.length === 0 || requested.length !== providerIds.length) return { ok: false, code: 'PROVIDER_NOT_FOUND', revision: currentRevision };
  let next = source;
  const results = [];
  for (const id of requested) {
    const result = mutateProviderSettings(next, { providerId: id, removeProvider: true });
    if (!result.ok) return { ...result, revision: currentRevision };
    next = result.text;
    results.push(result);
  }
  return { ok: true, text: next, removed: requested, remaining: results.at(-1)?.remaining ?? [], revision: sha256(next) };
}
