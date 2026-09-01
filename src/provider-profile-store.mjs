// Safe, structure-aware mutations for the Crew profile's provider patch.
//
// This module deliberately does not parse or return credential values. It only
// recognizes the known llm-pi-ai -> config -> providers mapping and performs
// bounded, revision-checked text edits while preserving unrelated patch items.

import { createHash } from 'node:crypto';
import { classifyCredentialReference } from './credential-reference.mjs';

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function indentOf(line) {
  return (line.match(/^\s*/) ?? [''])[0].length;
}

function nonBlank(line) {
  return line.trim() !== '' && !line.trimStart().startsWith('#');
}

function parseProviderMap(source) {
  if (typeof source !== 'string') return { ok: false, code: 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED' };
  const lines = source.split(/\r?\n/);
  const llmStart = lines.findIndex((line) => /^-\s+id:\s*llm-pi-ai\s*$/.test(line));
  if (llmStart < 0) return { ok: false, code: 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED' };

  let blockEnd = lines.length;
  for (let index = llmStart + 1; index < lines.length; index += 1) {
    // Only a true top-level sequence item can end the managed llm-pi-ai item;
    // nested list entries are part of a provider value and must be validated.
    if (indentOf(lines[index]) === 0 && /^-\s+/.test(lines[index])) {
      blockEnd = index;
      break;
    }
  }

  const providersLine = lines.findIndex((line, index) => index > llmStart && index < blockEnd && /^\s+providers:\s*(?:\{\s*\})?\s*$/.test(line));
  if (providersLine < 0) return { ok: false, code: 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED' };
  const providersIndent = indentOf(lines[providersLine]);
  const providerIndent = providersIndent + 2;
  const entries = [];

  for (let index = providersLine + 1; index < blockEnd; index += 1) {
    const line = lines[index];
    if (!nonBlank(line)) continue;
    const indent = indentOf(line);
    if (indent <= providersIndent) return { ok: false, code: 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED' };
    if (indent !== providerIndent) {
      if (/^\s*-\s+/.test(line)) return { ok: false, code: 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED' };
      continue;
    }
    const match = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/);
    if (!match) return { ok: false, code: 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED' };
    const id = match[1];
    let end = index + 1;
    while (end < blockEnd) {
      const next = lines[end];
      if (nonBlank(next)) {
        const nextIndent = indentOf(next);
        if (nextIndent < providerIndent) return { ok: false, code: 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED' };
        if (nextIndent === providerIndent) break;
        // Provider values may contain nested YAML sequences (for example the
        // `models:` list emitted by the live Harness profile). A sequence at
        // the same indentation as a provider field is malformed, however;
        // valid child items must be indented below that field. Keep the
        // parser structure-aware without attempting to deserialize values.
        if (/^\s*-\s+/.test(next) && nextIndent < providerIndent + 4) {
          return { ok: false, code: 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED' };
        }
      }
      end += 1;
    }
    entries.push({ id, start: index, end });
    index = end - 1;
  }
  return { ok: true, lines, llmStart, blockEnd, providersLine, providerIndent, entries };
}

/** Return only bounded provider ids and a content revision; never values. */
export function inspectProviderProfile(source) {
  const revision = typeof source === 'string' ? sha256(source) : null;
  const parsed = parseProviderMap(source);
  if (!parsed.ok) return { ok: false, code: parsed.code, revision };
  return {
    ok: true,
    schema: 'cordis-patch-llm-pi-ai-v1',
    providerIds: parsed.entries.map((entry) => entry.id),
    revision,
  };
}

function scalarField(lines, entry, field) {
  const pattern = new RegExp(`^\\s+${field}:\\s*(.*?)\\s*$`);
  for (const line of lines.slice(entry.start, entry.end)) {
    const match = line.match(pattern);
    if (!match) continue;
    const value = match[1].trim();
    if (!value) return null;
    return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2');
  }
  return null;
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

/** Return profile provider provenance and credential reference names only. */
export function readProviderDeclarations(source, { file = 'profile.yml' } = {}) {
  const parsed = parseProviderMap(source);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  const declarations = parsed.entries.map((entry) => {
    const displayName = scalarField(parsed.lines, entry, 'displayName');
    const rawCredentialRef = scalarField(parsed.lines, entry, 'apiKeyEnv');
    const credential = classifyCredentialReference(rawCredentialRef, { kind: 'env' });
    return {
      id: entry.id,
      display_name: displayName ?? entry.id,
      origin: 'profile-managed',
      ownership: 'crew-managed-profile',
      file,
      declaration_authority: { kind: 'crew-profile', locator: `llm-pi-ai.config.providers.${entry.id}` },
      ...(credential.value ? { credential_ref: credential.value } : {}),
      ...(credential.redacted ? { credential_status: 'present-redacted' } : {}),
    };
  });
  return { ok: true, declarations };
}

function unquoteScalar(value) {
  return typeof value === 'string'
    ? value.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2')
    : null;
}

function providerModels(lines, entry) {
  const modelsLine = lines.findIndex((line, index) => index >= entry.start && index < entry.end && /^\s+models:\s*$/u.test(line));
  if (modelsLine < 0) return [];
  const modelsIndent = (lines[modelsLine].match(/^\s*/u) ?? [''])[0].length;
  const models = [];
  for (let index = modelsLine + 1; index < entry.end; index += 1) {
    const line = lines[index];
    if (!nonBlank(line)) continue;
    const indent = indentOf(line);
    if (indent <= modelsIndent) break;
    const match = line.match(/^\s*-\s+id:\s*(.*?)\s*$/u);
    if (!match) continue;
    const id = unquoteScalar(match[1]);
    if (!id || id.length > 256 || /[\r\n]/u.test(id)) continue;
    let name = null;
    for (let child = index + 1; child < entry.end; child += 1) {
      const childLine = lines[child];
      if (!nonBlank(childLine)) continue;
      const childIndent = indentOf(childLine);
      if (childIndent <= modelsIndent || /^\s*-\s+id:\s*/u.test(childLine)) break;
      const nameMatch = childLine.match(/^\s+name:\s*(.*?)\s*$/u);
      if (nameMatch) { name = unquoteScalar(nameMatch[1]); break; }
    }
    models.push({ id, ...(name && name.length <= 256 && !/[\r\n]/u.test(name) ? { name } : {}) });
  }
  return models.slice(0, 256);
}

/**
 * Return the bounded, non-secret fields needed to materialize one profile
 * provider in Harness settings. This is read-only and intentionally separate
 * from readProviderDeclarations so existing provenance consumers stay stable.
 */
export function readProviderMaterialization(source, { providerId, file = 'profile.yml' } = {}) {
  const parsed = parseProviderMap(source);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  const entry = parsed.entries.find((candidate) => candidate.id === providerId);
  if (!entry) return { ok: false, code: 'PROVIDER_NOT_FOUND' };
  const credentialRef = scalarField(parsed.lines, entry, 'apiKeyEnv');
  const credential = classifyCredentialReference(credentialRef, { kind: 'env' });
  if (credential.redacted) return { ok: false, code: 'PROVIDER_CREDENTIAL_REFERENCE_UNSAFE' };
  const readBounded = (field, max = 2048) => {
    const value = scalarField(parsed.lines, entry, field);
    return value && value.length <= max && !/[\r\n]/u.test(value) ? value : null;
  };
  const baseUrl = readBounded('baseURL');
  if (baseUrl) {
    try {
      const parsedUrl = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || /[?#]/u.test(baseUrl) || !parsedUrl.hostname) {
        return { ok: false, code: 'PROVIDER_BASE_URL_UNSAFE' };
      }
    } catch { return { ok: false, code: 'PROVIDER_BASE_URL_UNSAFE' }; }
  }
  const provider = {
    id: entry.id,
    display_name: readBounded('displayName', 256) ?? entry.id,
    ...(credential.value ? { credential_ref: credential.value } : {}),
    ...(readBounded('api', 128) ? { api: readBounded('api', 128) } : {}),
    ...(baseUrl ? { base_url: baseUrl } : {}),
    models: providerModels(parsed.lines, entry),
    source_file: file,
  };
  return { ok: true, provider };
}

function yamlScalar(value, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]/u.test(value)) return null;
  return JSON.stringify(value.trim());
}

/** Re-add one safe provider projection during an explicit migration rollback. */
export function addProviderDeclaration(source, { provider, expectedRevision } = {}) {
  const currentRevision = typeof source === 'string' ? sha256(source) : null;
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) return { ok: false, code: 'PROVIDER_PROFILE_CHANGED', revision: currentRevision };
  if (!provider || typeof provider !== 'object' || Array.isArray(provider) || !PROVIDER_ID.test(provider.id ?? '')) return { ok: false, code: 'PROVIDER_MATERIALIZATION_INVALID', revision: currentRevision };
  const parsed = parseProviderMap(source);
  if (!parsed.ok) return { ok: false, code: parsed.code, revision: currentRevision };
  if (parsed.entries.some((entry) => entry.id === provider.id)) return { ok: false, code: 'PROVIDER_PROFILE_PROVIDER_EXISTS', revision: currentRevision };
  const displayName = yamlScalar(provider.display_name ?? provider.id, 256);
  if (!displayName) return { ok: false, code: 'PROVIDER_MATERIALIZATION_INVALID', revision: currentRevision };
  const providerIndent = indentOf(parsed.lines[parsed.providersLine]) + 2;
  const fieldIndent = providerIndent + 2;
  const lines = [`${' '.repeat(providerIndent)}${provider.id}:`, `${' '.repeat(fieldIndent)}displayName: ${displayName}`];
  const api = yamlScalar(provider.api, 128);
  const baseUrl = yamlScalar(provider.base_url, 2048);
  const credential = provider.credential_ref ? classifyCredentialReference(provider.credential_ref, { kind: 'env' }).value : null;
  if (provider.credential_ref && !credential) return { ok: false, code: 'PROVIDER_CREDENTIAL_REFERENCE_UNSAFE', revision: currentRevision };
  if (api) lines.push(`${' '.repeat(fieldIndent)}api: ${api}`);
  if (baseUrl) lines.push(`${' '.repeat(fieldIndent)}baseURL: ${baseUrl}`);
  if (credential) lines.push(`${' '.repeat(fieldIndent)}apiKeyEnv: ${credential}`);
  const models = Array.isArray(provider.models) ? provider.models.filter((model) => model && typeof model.id === 'string' && model.id.trim() && model.id.length <= 256).slice(0, 256) : [];
  if (models.length > 0) {
    lines.push(`${' '.repeat(fieldIndent)}models:`);
    for (const model of models) {
      const id = yamlScalar(model.id, 256);
      if (!id) continue;
      lines.push(`${' '.repeat(fieldIndent + 2)}- id: ${id}`);
      const name = yamlScalar(model.name, 256);
      if (name) lines.push(`${' '.repeat(fieldIndent + 4)}name: ${name}`);
    }
  }
  const nextLines = [...parsed.lines];
  if (/^\s+providers:\s*\{\s*\}\s*$/u.test(nextLines[parsed.providersLine])) {
    nextLines[parsed.providersLine] = `${' '.repeat(indentOf(nextLines[parsed.providersLine]))}providers:`;
  }
  nextLines.splice(parsed.blockEnd, 0, ...lines);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const text = nextLines.join(newline);
  return { ok: true, text, added: provider.id, revision: sha256(text) };
}

/**
 * Remove provider declarations from a known profile patch after an optional
 * content-revision check. The returned text is safe to write atomically by the
 * lifecycle layer; this pure helper never touches the filesystem.
 */
export function removeProviderDeclarations(source, { providerIds = [], expectedRevision } = {}) {
  const currentRevision = typeof source === 'string' ? sha256(source) : null;
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    return { ok: false, code: 'PROVIDER_PROFILE_CHANGED', revision: currentRevision };
  }
  const requested = [...new Set(providerIds.filter((id) => typeof id === 'string' && PROVIDER_ID.test(id)))];
  if (requested.length === 0 || requested.length !== providerIds.length) {
    return { ok: false, code: 'PROVIDER_NOT_FOUND', revision: currentRevision };
  }
  const parsed = parseProviderMap(source);
  if (!parsed.ok) return { ok: false, code: parsed.code, revision: currentRevision };
  const byId = new Map(parsed.entries.map((entry) => [entry.id, entry]));
  if (requested.some((id) => !byId.has(id))) {
    return { ok: false, code: 'PROVIDER_NOT_FOUND', revision: currentRevision };
  }

  const removedSet = new Set(requested);
  const remaining = parsed.entries.filter((entry) => !removedSet.has(entry.id)).map((entry) => entry.id);
  const removeRanges = requested.map((id) => { const entry = byId.get(id); return [entry.start, entry.end]; });
  const shouldRemove = (index) => removeRanges.some(([start, end]) => index >= start && index < end);
  const lines = parsed.lines.filter((_line, index) => !shouldRemove(index));
  if (remaining.length === 0) {
    const providersIndex = parsed.providersLine - removeRanges.filter(([start]) => start < parsed.providersLine).length;
    const providersIndent = indentOf(parsed.lines[parsed.providersLine]);
    lines[providersIndex] = `${' '.repeat(providersIndent)}providers: {}`;
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const text = lines.join(newline);
  return {
    ok: true,
    text,
    removed: requested,
    remaining,
    revision: sha256(text),
  };
}
