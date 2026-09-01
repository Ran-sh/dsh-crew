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

function parseProviderMap(source) {
  if (typeof source !== 'string') return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
  const lines = source.split(/\r?\n/u);
  const llmStart = lines.findIndex((line) => /^llm-pi-ai:\s*$/u.test(line));
  if (llmStart < 0) return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
  let blockEnd = lines.length;
  for (let index = llmStart + 1; index < lines.length; index += 1) {
    if (indentOf(lines[index]) === 0 && nonBlank(lines[index])) { blockEnd = index; break; }
  }
  const providersLine = lines.findIndex((line, index) => index > llmStart && index < blockEnd && /^ {2}providers:\s*$/u.test(line));
  if (providersLine < 0) return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
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
  if (entries.length === 0) return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
  return { ok: true, lines, llmStart, blockEnd, providersLine, entries };
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
        ...(credentialRef ? { credential_ref: credentialRef } : {}),
      };
    }),
  };
}

export function removeProviderSettings(source, { providerIds = [], expectedRevision } = {}) {
  const currentRevision = typeof source === 'string' ? sha256(source) : null;
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) return { ok: false, code: 'PROVIDER_SETTINGS_CHANGED', revision: currentRevision };
  const requested = [...new Set(providerIds.filter((id) => typeof id === 'string' && PROVIDER_ID.test(id)))];
  if (requested.length === 0 || requested.length !== providerIds.length) return { ok: false, code: 'PROVIDER_NOT_FOUND', revision: currentRevision };
  const parsed = parseProviderMap(source);
  if (!parsed.ok) return { ok: false, code: parsed.code, revision: currentRevision };
  const byId = new Map(parsed.entries.map((entry) => [entry.id, entry]));
  if (requested.some((id) => !byId.has(id))) return { ok: false, code: 'PROVIDER_NOT_FOUND', revision: currentRevision };
  const removedSet = new Set(requested);
  const remaining = parsed.entries.filter((entry) => !removedSet.has(entry.id)).map((entry) => entry.id);
  const ranges = requested.map((id) => { const entry = byId.get(id); return [entry.start, entry.end]; });
  const lines = parsed.lines.filter((_line, index) => !ranges.some(([start, end]) => index >= start && index < end));
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const text = lines.join(newline);
  return { ok: true, text, removed: requested, remaining, revision: sha256(text) };
}
