// Workspace Context carries stable project facts by reference. Instruction
// file contents and validation output remain in the workspace and are never
// copied into this registry or across Agent hand-offs.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const WORKSPACE_CONTEXT_SCHEMA_VERSION = 1;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function boundedStrings(value, { maxItems = 32, maxLength = 256 } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const result = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '' || item.length > maxLength) return null;
    result.push(item.trim());
    if (result.length > maxItems) return null;
  }
  return [...new Set(result)];
}

function safeReference(value) {
  if (isAbsolute(value)) return false;
  const normalized = value.replace(/\\/g, '/');
  return normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../');
}

function normalizeContext(id, raw) {
  if (!ID.test(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.repo_root !== 'string' || !isAbsolute(raw.repo_root)) return null;
  const instructionFiles = boundedStrings(raw.instruction_files);
  const validationHints = boundedStrings(raw.validation_hints, { maxItems: 32, maxLength: 512 });
  if (!instructionFiles || !validationHints || instructionFiles.some((entry) => !safeReference(entry))) return null;
  if (raw.default_branch !== undefined && (typeof raw.default_branch !== 'string' || raw.default_branch.length > 128)) return null;
  return {
    workspace_id: id,
    repo_root: resolve(raw.repo_root),
    default_branch: raw.default_branch?.trim() || null,
    instruction_files: instructionFiles,
    validation_hints: validationHints,
  };
}

export function workspaceContextsFile({ home = homedir() } = {}) {
  return join(home, '.config', 'dsh-crew', 'workspaces.json');
}

export function loadWorkspaceContexts({ home = homedir(), file = workspaceContextsFile({ home }) } = {}) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch {
    return { schema_version: WORKSPACE_CONTEXT_SCHEMA_VERSION, ok: true, source: 'none', contexts: {}, errors: [] };
  }
  if (raw?.schema_version !== WORKSPACE_CONTEXT_SCHEMA_VERSION || !raw.workspaces || typeof raw.workspaces !== 'object' || Array.isArray(raw.workspaces)) {
    return { schema_version: WORKSPACE_CONTEXT_SCHEMA_VERSION, ok: false, source: 'file', contexts: {}, errors: [{ code: 'WORKSPACE_CONTEXT_FILE_INVALID' }] };
  }
  const contexts = {};
  const errors = [];
  for (const [id, value] of Object.entries(raw.workspaces)) {
    const context = normalizeContext(id, value);
    if (!context) errors.push({ code: 'WORKSPACE_CONTEXT_INVALID', workspace_id: ID.test(id) ? id : '<invalid>' });
    else contexts[id] = context;
  }
  return { schema_version: WORKSPACE_CONTEXT_SCHEMA_VERSION, ok: errors.length === 0, source: 'file', contexts, errors: errors.slice(0, 32) };
}

function contains(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel));
}

export function resolveWorkspaceContext(registry, { workspace_id: workspaceId, cwd } = {}) {
  if (!workspaceId) return { ok: true, context: null };
  const context = registry?.contexts?.[workspaceId];
  if (!context) return { ok: false, code: 'WORKSPACE_CONTEXT_NOT_FOUND', workspace_id: workspaceId };
  if (cwd && !contains(context.repo_root, cwd)) {
    return { ok: false, code: 'WORKSPACE_ROOT_MISMATCH', workspace_id: workspaceId };
  }
  return { ok: true, context: { ...context, instruction_files: [...context.instruction_files], validation_hints: [...context.validation_hints] } };
}

export function buildWorkspaceTask(objective, context) {
  const task = String(objective ?? '').slice(0, 32_768);
  if (!context) return task;
  const lines = [
    '[DSH Workspace Context — references only]',
    `Workspace: ${context.workspace_id}`,
    `Repository root: ${context.repo_root}`,
  ];
  if (context.default_branch) lines.push(`Default branch: ${context.default_branch}`);
  if (context.instruction_files.length) lines.push(`Instruction references: ${context.instruction_files.join(', ')}`);
  if (context.validation_hints.length) lines.push(`Validation hints: ${context.validation_hints.join(' | ')}`);
  lines.push('Open referenced files in the workspace when needed; do not expect their contents in this hand-off.', '', '[Delegated objective]', task);
  return lines.join('\n');
}
