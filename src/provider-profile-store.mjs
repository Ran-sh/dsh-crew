// Safe, structure-aware mutations for the Crew profile's provider patch.
//
// This module deliberately does not parse or return credential values. It only
// recognizes the known llm-pi-ai -> config -> providers mapping and performs
// bounded, revision-checked text edits while preserving unrelated patch items.

import { createHash } from 'node:crypto';

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

  const providersLine = lines.findIndex((line, index) => index > llmStart && index < blockEnd && /^\s+providers:\s*$/.test(line));
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
        if (/^\s*-\s+/.test(next)) return { ok: false, code: 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED' };
      }
      end += 1;
    }
    entries.push({ id, start: index, end });
    index = end - 1;
  }
  if (entries.length === 0) return { ok: false, code: 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED' };
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
    return value.replace(/^(?:"([\\s\\S]*)"|'([\\s\\S]*)')$/, '$1$2');
  }
  return null;
}

/** Return profile provider provenance and credential reference names only. */
export function readProviderDeclarations(source, { file = 'profile.yml' } = {}) {
  const parsed = parseProviderMap(source);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  const declarations = parsed.entries.map((entry) => {
    const displayName = scalarField(parsed.lines, entry, 'displayName');
    const credentialRef = scalarField(parsed.lines, entry, 'apiKeyEnv');
    return {
      id: entry.id,
      display_name: displayName ?? entry.id,
      origin: 'profile-managed',
      ownership: 'crew-managed-profile',
      file,
      ...(credentialRef ? { credential_ref: credentialRef } : {}),
    };
  });
  return { ok: true, declarations };
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
  const removeRanges = [];
  if (remaining.length === 0) {
    // Avoid leaving an empty `llm-pi-ai.config.providers` mapping that could
    // fail the next profile parse. Remove the complete managed sequence item.
    removeRanges.push([parsed.llmStart, parsed.blockEnd]);
  } else {
    for (const id of requested) {
      const entry = byId.get(id);
      removeRanges.push([entry.start, entry.end]);
    }
  }
  const shouldRemove = (index) => removeRanges.some(([start, end]) => index >= start && index < end);
  const lines = parsed.lines.filter((_line, index) => !shouldRemove(index));
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
