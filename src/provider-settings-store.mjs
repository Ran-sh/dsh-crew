// Structure-aware access to the Crew-owned Harness settings.yaml provider map.
// Only the known llm-pi-ai.providers mapping is mutable; arbitrary YAML and
// credential values are never deserialized or returned.

import { createHash } from 'node:crypto';
import { classifyCredentialReference } from './credential-reference.mjs';
import { readProviderMaterialization } from './provider-profile-store.mjs';

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function sha256(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function indentOf(line) { return (line.match(/^\s*/u) ?? [''])[0].length; }
function nonBlank(line) { return line.trim() !== '' && !line.trimStart().startsWith('#'); }
function nextContentLine(lines, start, end = lines.length) {
  for (let index = start; index < end; index += 1) if (nonBlank(lines[index])) return index;
  return -1;
}
function unquoteScalar(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return null;
  if (input.startsWith('"') && input.endsWith('"')) {
    try { return JSON.parse(input); } catch { return null; }
  }
  if (input.startsWith("'") && input.endsWith("'")) return input.slice(1, -1).replace(/''/gu, "'");
  return input;
}
function scalarField(lines, entry, field) {
  const indent = Number.isInteger(entry?.fieldIndent) ? entry.fieldIndent : null;
  const pattern = new RegExp(`^${indent === null ? '\\s+' : ` {${indent}}`}${field}:\\s*(.*?)\\s*$`);
  for (const line of lines.slice(entry.start, entry.end)) {
    const match = line.match(pattern);
    if (!match) continue;
    const value = (entry?.style === 'flow' ? match[1].replace(/,\s*$/u, '') : match[1]).trim();
    if (!value) return null;
    return unquoteScalar(value);
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
  const flowOpenLine = nextContentLine(lines, providersLine + 1, blockEnd);
  if (flowOpenLine >= 0 && /^ {4}\{\s*$/u.test(lines[flowOpenLine])) {
    let flowCloseLine = -1;
    const entries = [];
    let index = flowOpenLine + 1;
    while (index < blockEnd) {
      index = nextContentLine(lines, index, blockEnd);
      if (index < 0) break;
      if (/^ {4}\}\s*$/u.test(lines[index])) { flowCloseLine = index; break; }
      const match = lines[index].match(/^ {6}([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/u);
      if (!match) return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
      const objectOpen = nextContentLine(lines, index + 1, blockEnd);
      if (objectOpen < 0 || !/^ {8}\{\s*$/u.test(lines[objectOpen])) return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
      let objectClose = -1;
      for (let cursor = objectOpen + 1; cursor < blockEnd; cursor += 1) {
        if (/^ {8}\},?\s*$/u.test(lines[cursor])) { objectClose = cursor; break; }
      }
      if (objectClose < 0) return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
      entries.push({ id: match[1], start: index, end: objectClose + 1, style: 'flow', fieldIndent: 10, objectOpen, objectClose });
      index = objectClose + 1;
    }
    if (flowCloseLine < 0) return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
    for (let entryIndex = 0; entryIndex < entries.length - 1; entryIndex += 1) {
      if (!/^ {8}\},\s*$/u.test(lines[entries[entryIndex].objectClose])) return { ok: false, code: 'PROVIDER_SETTINGS_SCHEMA_UNSUPPORTED' };
    }
    return {
      ok: true, style: 'flow', lines, llmStart, blockEnd, providersLine,
      providersBlockEnd: flowCloseLine + 1, flowOpenLine, flowCloseLine, entries,
    };
  }
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
    entries.push({ id: match[1], start: index, end, style: 'block', fieldIndent: 6 });
    index = end - 1;
  }
  return { ok: true, style: 'block', lines, llmStart, blockEnd, providersLine, providersBlockEnd, entries };
}

function splitFlowItems(source) {
  const items = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (quote === '"' && escaped) { escaped = false; continue; }
      if (quote === '"' && char === '\\') { escaped = true; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') braces += 1;
    else if (char === '}') braces -= 1;
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets -= 1;
    else if (char === ',' && braces === 0 && brackets === 0) {
      items.push(source.slice(start, index).trim());
      start = index + 1;
    }
    if (braces < 0 || brackets < 0) return null;
  }
  if (quote || braces !== 0 || brackets !== 0) return null;
  const tail = source.slice(start).trim();
  if (tail) items.push(tail);
  return items;
}

function parseFlowObject(source) {
  const input = source.trim().replace(/,\s*$/u, '');
  if (!input.startsWith('{') || !input.endsWith('}')) return null;
  const items = splitFlowItems(input.slice(1, -1));
  if (!items) return null;
  const fields = new Map();
  for (const item of items) {
    let splitAt = -1;
    let quote = null;
    let escaped = false;
    for (let index = 0; index < item.length; index += 1) {
      const char = item[index];
      if (quote) {
        if (quote === '"' && escaped) { escaped = false; continue; }
        if (quote === '"' && char === '\\') { escaped = true; continue; }
        if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ':') { splitAt = index; break; }
    }
    if (splitAt < 1) return null;
    const key = item.slice(0, splitAt).trim();
    const value = item.slice(splitAt + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(key) || !value || fields.has(key)) return null;
    fields.set(key, value);
  }
  return fields;
}

function parseFlowModel(source) {
  const fields = parseFlowObject(source);
  if (!fields) return null;
  const allowed = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoningEfforts', 'compat']);
  if ([...fields.keys()].some((key) => !allowed.has(key))) return null;
  const id = unquoteScalar(fields.get('id'));
  if (!id || id.length > 256 || /[\r\n]/u.test(id)) return null;
  const model = { id };
  if (fields.has('name')) {
    const name = unquoteScalar(fields.get('name'));
    if (!name || name.length > 256 || /[\r\n]/u.test(name)) return null;
    model.name = name;
  }
  for (const [sourceKey, targetKey] of [['contextWindow', 'context_window'], ['maxTokens', 'max_tokens']]) {
    if (!fields.has(sourceKey)) continue;
    const value = Number(unquoteScalar(fields.get(sourceKey)));
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    model[targetKey] = value;
  }
  if (fields.has('input')) {
    const input = fields.get('input').trim();
    if (!input.startsWith('[') || !input.endsWith(']')) return null;
    const modalities = splitFlowItems(input.slice(1, -1));
    if (!modalities) return null;
    const normalized = modalities.map(unquoteScalar);
    if (normalized.some((value) => !['text', 'image'].includes(value))) return null;
    model.input = [...new Set(normalized)];
  }
  if (fields.has('reasoningEfforts')) {
    const efforts = parseFlowObject(fields.get('reasoningEfforts'));
    if (!efforts) return null;
    const normalized = {};
    for (const [key, raw] of efforts) {
      const value = unquoteScalar(raw);
      if (raw === 'null' || raw === '~') normalized[key] = null;
      else if (!value || value.length > 256 || /[\r\n]/u.test(value)) return null;
      else normalized[key] = value;
    }
    model.reasoning_efforts = normalized;
  }
  if (fields.has('compat')) {
    if (fields.get('compat').trim() !== '{}') return null;
    model.compat = {};
  }
  return model;
}

function readFlowMaterialization(parsed, entry, file) {
  const directFields = new Set();
  for (const line of parsed.lines.slice(entry.objectOpen + 1, entry.objectClose)) {
    if (!nonBlank(line) || indentOf(line) !== entry.fieldIndent) continue;
    const match = line.match(/^\s+([A-Za-z][A-Za-z0-9_-]*):/u);
    if (!match || directFields.has(match[1])) return { ok: false, code: 'PROVIDER_MATERIALIZATION_UNSUPPORTED_FIELDS' };
    directFields.add(match[1]);
  }
  const allowed = new Set(['displayName', 'apiKeyEnv', 'api', 'baseURL', 'models']);
  if ([...directFields].some((field) => !allowed.has(field))) return { ok: false, code: 'PROVIDER_MATERIALIZATION_UNSUPPORTED_FIELDS' };
  const rawDisplayName = scalarField(parsed.lines, entry, 'displayName');
  const displayName = rawDisplayName && rawDisplayName.length <= 256 && !/[\r\n]/u.test(rawDisplayName) ? rawDisplayName : entry.id;
  const rawCredentialRef = scalarField(parsed.lines, entry, 'apiKeyEnv');
  const credential = classifyCredentialReference(rawCredentialRef, { kind: 'env' });
  if (credential.redacted) return { ok: false, code: 'PROVIDER_CREDENTIAL_REFERENCE_UNSAFE' };
  const api = scalarField(parsed.lines, entry, 'api');
  if (api && (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(api) || /^(?:sk|pk|rk|token|secret)[_-]/iu.test(api))) return { ok: false, code: 'PROVIDER_API_SCHEMA_UNSUPPORTED' };
  const rawBaseUrl = scalarField(parsed.lines, entry, 'baseURL');
  const baseUrl = rawBaseUrl && rawBaseUrl.length <= 2048 && !/[\r\n]/u.test(rawBaseUrl) ? rawBaseUrl : null;
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.hostname) return { ok: false, code: 'PROVIDER_BASE_URL_UNSAFE' };
    } catch { return { ok: false, code: 'PROVIDER_BASE_URL_UNSAFE' }; }
  }
  const models = [];
  if (directFields.has('models')) {
    const modelsLine = parsed.lines.findIndex((line, index) => index > entry.objectOpen && index < entry.objectClose && /^ {10}models:\s*$/u.test(line));
    const listOpen = nextContentLine(parsed.lines, modelsLine + 1, entry.objectClose);
    if (modelsLine < 0 || listOpen < 0 || !/^ {12}\[\s*$/u.test(parsed.lines[listOpen])) return { ok: false, code: 'PROVIDER_MODEL_SCHEMA_UNSUPPORTED' };
    let listClose = -1;
    for (let index = listOpen + 1; index < entry.objectClose; index += 1) {
      if (/^ {12}\]\s*,?\s*$/u.test(parsed.lines[index])) { listClose = index; break; }
      if (!nonBlank(parsed.lines[index])) continue;
      if (indentOf(parsed.lines[index]) !== 14) return { ok: false, code: 'PROVIDER_MODEL_SCHEMA_UNSUPPORTED' };
      const model = parseFlowModel(parsed.lines[index]);
      if (!model || models.some((candidate) => candidate.id === model.id)) return { ok: false, code: 'PROVIDER_MODEL_SCHEMA_UNSUPPORTED' };
      models.push(model);
    }
    if (listClose < 0) return { ok: false, code: 'PROVIDER_MODEL_SCHEMA_UNSUPPORTED' };
  }
  return {
    ok: true,
    provider: {
      id: entry.id, display_name: displayName,
      ...(credential.value ? { credential_ref: credential.value } : {}),
      ...(api ? { api } : {}), ...(baseUrl ? { base_url: baseUrl } : {}),
      models: models.slice(0, 256), source_file: file,
    },
  };
}

const SENSITIVE_CREDENTIAL_FIELD = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|(?:^|[_-])token(?:$|[_-])|secret|password|authorization|credential|private[_-]?key|client[_-]?secret|cookie|bearer|webhook)/iu;
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
      const rawCredentialRef = scalarField(parsed.lines, entry, 'apiKeyEnv');
      const credential = classifyCredentialReference(rawCredentialRef, { kind: 'env' });
      return {
        id: entry.id,
        display_name: scalarField(parsed.lines, entry, 'displayName') ?? entry.id,
        // settings.yaml is the Harness user layer. Crew profile/base
        // declarations are reported separately by provider-profile-store.
        origin: 'dynamic',
        ownership: 'dynamic-user',
        file,
        declaration_authority: { kind: 'harness-settings', locator: `llm-pi-ai.providers.${entry.id}` },
        ...(credential.value ? { credential_ref: { kind: 'env', name_or_handle: credential.value, ownership: 'unknown' } } : {}),
        ...(credential.redacted ? { credential_status: 'present-redacted' } : {}),
      };
    }),
  };
}

/** Return the same bounded provider projection as the profile parser, adapted
 * to the Harness settings indentation. This is used only for rollback CAS and
 * never exposes credential values. */
export function readProviderSettingsMaterialization(source, { providerId, file = 'harness/settings.yaml' } = {}) {
  const parsed = parseProviderMap(source);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  const entry = parsed.entries.find((candidate) => candidate.id === providerId);
  if (!entry) return { ok: false, code: 'PROVIDER_NOT_FOUND' };
  if (parsed.style === 'flow') return readFlowMaterialization(parsed, entry, file);
  const block = parsed.lines.slice(entry.start, entry.end).map((line) => `  ${line}`);
  const synthetic = ['- id: llm-pi-ai', '  config:', '    providers:', ...block, ''].join('\n');
  const result = readProviderMaterialization(synthetic, { providerId, file });
  return result.ok ? { ...result, provider: { ...result.provider, source_file: file } } : result;
}

export function readHarnessDefault(source) {
  const parsed = parseDefaultModel(source);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  return { ok: true, provider: parsed.provider, model: parsed.model, locator: 'agent-default-model' };
}

function yamlScalar(value, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]/u.test(value)) return null;
  return JSON.stringify(value.trim());
}

function flowModelLine(model) {
  const fields = [`id: ${yamlScalar(model.id, 256)}`];
  const name = yamlScalar(model.name, 256);
  if (name) fields.push(`name: ${name}`);
  if (Number.isSafeInteger(model.context_window) && model.context_window > 0) fields.push(`contextWindow: ${model.context_window}`);
  if (Number.isSafeInteger(model.max_tokens) && model.max_tokens > 0) fields.push(`maxTokens: ${model.max_tokens}`);
  if (Array.isArray(model.input) && model.input.every((value) => value === 'text' || value === 'image')) fields.push(`input: [${[...new Set(model.input)].join(', ')}]`);
  if (model.reasoning_efforts && typeof model.reasoning_efforts === 'object' && !Array.isArray(model.reasoning_efforts)) {
    const efforts = [];
    for (const [key, value] of Object.entries(model.reasoning_efforts)) {
      if (/^[A-Za-z][A-Za-z0-9_-]*$/u.test(key) && (value === null || yamlScalar(value, 256))) efforts.push(`${key}: ${value === null ? 'null' : yamlScalar(value, 256)}`);
    }
    if (efforts.length > 0) fields.push(`reasoningEfforts: { ${efforts.join(', ')} }`);
  }
  if (model.compat && typeof model.compat === 'object' && !Array.isArray(model.compat) && Object.keys(model.compat).length === 0) fields.push('compat: {}');
  return `{ ${fields.join(', ')} }`;
}

function flowProviderLines(provider) {
  const displayName = yamlScalar(provider.display_name ?? provider.id, 256);
  if (!displayName) return null;
  const credential = provider.credential_ref ? classifyCredentialReference(provider.credential_ref, { kind: 'env' }).value : null;
  if (provider.credential_ref && !credential) return null;
  const api = yamlScalar(provider.api, 128);
  const baseUrl = yamlScalar(provider.base_url, 2048);
  const models = Array.isArray(provider.models)
    ? provider.models.filter((model) => model && typeof model.id === 'string' && yamlScalar(model.id, 256)).slice(0, 256)
    : [];
  const fields = [`          displayName: ${displayName}`];
  if (api) fields.push(`          api: ${api}`);
  if (baseUrl) fields.push(`          baseURL: ${baseUrl}`);
  if (credential) fields.push(`          apiKeyEnv: ${yamlScalar(credential, 256)}`);
  if (models.length === 0) {
    return [`      ${provider.id}:`, '        {', ...fields.map((line, index) => `${line}${index < fields.length - 1 ? ',' : ''}`), '        }'];
  }
  const lines = [`      ${provider.id}:`, '        {', ...fields.map((line) => `${line},`), '          models:', '            ['];
  for (let index = 0; index < models.length; index += 1) lines.push(`              ${flowModelLine(models[index])}${index < models.length - 1 ? ',' : ''}`);
  lines.push('            ]', '        }');
  return lines;
}

/**
 * Add one already-sanitized provider projection to the Harness user layer.
 * The operation is pure and revision-bound; callers perform the atomic write.
 */
export function addProviderSettings(source, { provider, expectedRevision } = {}) {
  const currentRevision = typeof source === 'string' ? sha256(source) : null;
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) return { ok: false, code: 'PROVIDER_SETTINGS_CHANGED', revision: currentRevision };
  if (!provider || typeof provider !== 'object' || Array.isArray(provider) || typeof provider.id !== 'string' || !PROVIDER_ID.test(provider.id)) {
    return { ok: false, code: 'PROVIDER_MATERIALIZATION_INVALID', revision: currentRevision };
  }
  const parsed = parseProviderMap(source);
  if (!parsed.ok) return { ok: false, code: parsed.code, revision: currentRevision };
  if (parsed.entries.some((entry) => entry.id === provider.id)) return { ok: false, code: 'PROVIDER_SETTINGS_PROVIDER_EXISTS', revision: currentRevision };
  if (parsed.style === 'flow') {
    const providerLines = flowProviderLines(provider);
    if (!providerLines) return { ok: false, code: 'PROVIDER_MATERIALIZATION_INVALID', revision: currentRevision };
    const nextLines = [...parsed.lines];
    const previous = parsed.entries.at(-1);
    if (previous && !/,\s*$/u.test(nextLines[previous.objectClose])) nextLines[previous.objectClose] = `${nextLines[previous.objectClose]},`;
    nextLines.splice(parsed.flowCloseLine, 0, ...providerLines);
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const text = nextLines.join(newline);
    return { ok: true, text, added: provider.id, revision: sha256(text) };
  }
  const displayName = yamlScalar(provider.display_name ?? provider.id, 256);
  if (!displayName) return { ok: false, code: 'PROVIDER_MATERIALIZATION_INVALID', revision: currentRevision };
  const lines = [`    ${provider.id}:`, `      displayName: ${displayName}`];
  const api = yamlScalar(provider.api, 128);
  const baseUrl = yamlScalar(provider.base_url, 2048);
  const credential = provider.credential_ref ? classifyCredentialReference(provider.credential_ref, { kind: 'env' }).value : null;
  if (provider.credential_ref && !credential) return { ok: false, code: 'PROVIDER_CREDENTIAL_REFERENCE_UNSAFE', revision: currentRevision };
  if (api) lines.push(`      api: ${api}`);
  if (baseUrl) lines.push(`      baseURL: ${baseUrl}`);
  if (credential) lines.push(`      apiKeyEnv: ${credential}`);
  const models = Array.isArray(provider.models) ? provider.models.filter((model) => model && typeof model.id === 'string' && model.id.trim() && model.id.length <= 256).slice(0, 256) : [];
  if (models.length > 0) {
    lines.push('      models:');
    for (const model of models) {
      const id = yamlScalar(model.id, 256);
      if (!id) continue;
      lines.push(`        - id: ${id}`);
      const name = yamlScalar(model.name, 256);
      if (name) lines.push(`          name: ${name}`);
      if (Number.isSafeInteger(model.context_window) && model.context_window > 0) lines.push(`          contextWindow: ${model.context_window}`);
      if (Number.isSafeInteger(model.max_tokens) && model.max_tokens > 0) lines.push(`          maxTokens: ${model.max_tokens}`);
      if (Array.isArray(model.input) && model.input.every((value) => value === 'text' || value === 'image')) lines.push(`          input: [${[...new Set(model.input)].join(', ')}]`);
      if (model.reasoning_efforts && typeof model.reasoning_efforts === 'object' && !Array.isArray(model.reasoning_efforts)) {
        lines.push('          reasoningEfforts:');
        for (const [key, value] of Object.entries(model.reasoning_efforts)) if (/^[A-Za-z][A-Za-z0-9_-]*$/u.test(key) && (value === null || yamlScalar(value, 256))) lines.push(`            ${key}: ${value === null ? 'null' : yamlScalar(value, 256)}`);
      }
      if (model.compat && typeof model.compat === 'object' && !Array.isArray(model.compat) && Object.keys(model.compat).length === 0) lines.push('          compat: {}');
    }
  }
  const nextLines = [...parsed.lines];
  const insertAt = parsed.blockEnd;
  if (/^ {2}providers:\s*\{\s*\}\s*$/u.test(nextLines[parsed.providersLine])) nextLines[parsed.providersLine] = '  providers:';
  nextLines.splice(insertAt, 0, ...lines);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const text = nextLines.join(newline);
  return { ok: true, text, added: provider.id, revision: sha256(text) };
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
  if (removeProvider && parsed.style === 'flow' && finalProvider) {
    const lines = [...parsed.lines];
    lines.splice(parsed.providersLine, parsed.flowCloseLine - parsed.providersLine + 1, '  providers: {}');
    if (defaultParsed) {
      const removedBeforeProvider = parsed.providersLine <= defaultParsed.providerLine ? parsed.flowCloseLine - parsed.providersLine : 0;
      const removedBeforeModel = parsed.providersLine <= defaultParsed.modelLine ? parsed.flowCloseLine - parsed.providersLine : 0;
      lines[defaultParsed.providerLine - removedBeforeProvider] = `  provider: ${replacementDefault.trim()}`;
      lines[defaultParsed.modelLine - removedBeforeModel] = `  model: ${replacementModel.trim()}`;
    }
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const text = lines.join(newline);
    return {
      ok: true, text, removed: [providerId], remaining: [],
      ...(defaultParsed ? { previous_default: { provider: defaultParsed.provider, model: defaultParsed.model } } : {}),
      revision: sha256(text),
    };
  }
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
