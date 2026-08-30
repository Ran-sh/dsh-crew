// ZCode host integration.  This module is deliberately file-only: it never
// launches ZCode, mutates credentials, or overwrites an unowned MCP server.
// The generated files make ZCode dispatch through the same dsh-crew MCP server
// used by Codex and Claude while keeping ZCode's native config precedence.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOST = 'zcode';
const SERVER = 'dsh-crew';
const POLICY_START = '<!-- DSH CREW MANAGED ZCODE POLICY:START -->';
const POLICY_END = '<!-- DSH CREW MANAGED ZCODE POLICY:END -->';
const OWNERSHIP_FILE = ({ home = homedir() } = {}) => join(home, '.config', 'dsh-crew', 'integrations', 'zcode.json');

// Keep the allowlist explicit. ZCode rejects wildcard tool permissions, and a
// future server tool is not silently exposed until a template intentionally
// opts into it.
export const ZCODE_MCP_TOOLS = Object.freeze([
  'dsh_run_worker',
  'dsh_spawn_worker',
  'dsh_worker_status',
  'dsh_worker_result',
  'dsh_worker_cancel',
  'dsh_worker_config',
]);

function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function contentHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function backup(file) {
  if (!existsSync(file)) return null;
  const path = `${file}.dsh-crew-backup-${Date.now()}`;
  copyFileSync(file, path);
  return path;
}

function normalizePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const path = resolve(value);
    return process.platform === 'win32' ? path.toLowerCase() : path;
  } catch { return null; }
}

function serverTarget(server) {
  if (!server || typeof server !== 'object') return null;
  if (server.command !== 'node' || !Array.isArray(server.args) || typeof server.args[0] !== 'string') return null;
  return normalizePath(server.args[0]);
}

function nativeServers(config) {
  const servers = config?.mcp?.servers;
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {};
}

function sharedServers(config) {
  const servers = config?.mcpServers;
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {};
}

function configSource({ home = homedir() } = {}) {
  const nativeFile = join(home, '.zcode', 'cli', 'config.json');
  const sharedFile = join(home, '.agents', 'mcp.json');
  const native = readJson(nativeFile, {});
  const shared = readJson(sharedFile, {});
  const nativeMap = nativeServers(native);
  const sharedMap = sharedServers(shared);
  // ZCode shadows .agents/mcp.json whenever its native config has at least
  // one server. If native is empty, the shared file is the least-surprising
  // compatibility path for users who already manage MCP centrally.
  if (Object.keys(nativeMap).length > 0 || Object.keys(sharedMap).length === 0) {
    return { file: nativeFile, kind: 'native', config: native, servers: nativeMap };
  }
  return { file: sharedFile, kind: 'shared', config: shared, servers: sharedMap };
}

export function resolveZCodeMcpTarget({ home = homedir() } = {}) {
  const source = configSource({ home });
  return serverTarget(source.servers[SERVER]);
}

function expectedTarget({ root = ROOT } = {}) {
  return resolve(join(root, 'src', 'server.mjs'));
}

function managedPolicyBlock(root) {
  const template = readText(join(root, 'zcode', 'AGENTS.md'))?.trim();
  return template ? `${POLICY_START}\n${template}\n${POLICY_END}` : null;
}

function installPolicy({ home, root }) {
  const file = join(home, '.zcode', 'AGENTS.md');
  const block = managedPolicyBlock(root);
  if (!block) return { ok: false, code: 'ZCODE_POLICY_TEMPLATE_MISSING' };
  mkdirSync(dirname(file), { recursive: true });
  const current = readText(file) ?? '';
  const escapedStart = POLICY_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = POLICY_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const managed = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`, 'm');
  const next = managed.test(current)
    ? current.replace(managed, block)
    : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`;
  if (next !== current) { backup(file); writeFileSync(file, next); }
  return { ok: true, file };
}

function removePolicy({ home }) {
  const file = join(home, '.zcode', 'AGENTS.md');
  const current = readText(file);
  if (typeof current !== 'string') return false;
  const start = POLICY_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const end = POLICY_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const managed = new RegExp(`(?:\\r?\\n){0,2}${start}[\\s\\S]*?${end}(?:\\r?\\n)?`, 'm');
  if (!managed.test(current)) return false;
  const next = current.replace(managed, '').trimEnd();
  backup(file);
  if (next.trim()) writeFileSync(file, `${next}\n`);
  else rmSync(file, { force: true });
  return true;
}

function ownership({ home = homedir() } = {}) {
  const data = readJson(OWNERSHIP_FILE({ home }), null);
  return data && typeof data === 'object' && data.host === HOST ? data : null;
}

function ownedSourceRecords(owned) {
  if (!owned) return [];
  const records = [];
  const seen = new Set();
  const current = owned.config_file ? {
    file: owned.config_file,
    kind: owned.config_kind === 'shared' ? 'shared' : 'native',
  } : null;
  for (const record of [current, ...(Array.isArray(owned.config_files) ? owned.config_files : [])]) {
    if (!record || typeof record.file !== 'string' || !record.file.trim()) continue;
    const key = normalizePath(record.file);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    records.push({ file: record.file, kind: record.kind === 'shared' ? 'shared' : 'native' });
  }
  return records;
}

function removeOwnedMcp({ file, kind, target }) {
  const config = readJson(file, null);
  if (!config || typeof config !== 'object') return false;
  const isShared = kind === 'shared';
  const servers = isShared ? sharedServers(config) : nativeServers(config);
  const current = servers[SERVER];
  if (normalizePath(target) !== serverTarget(current)) return false;
  const next = { ...config };
  if (isShared) {
    next.mcpServers = { ...servers };
    delete next.mcpServers[SERVER];
    if (Object.keys(next.mcpServers).length === 0) delete next.mcpServers;
  } else {
    next.mcp = { ...(next.mcp ?? {}), servers: { ...servers } };
    delete next.mcp.servers[SERVER];
    if (Object.keys(next.mcp.servers).length === 0) delete next.mcp.servers;
    if (Object.keys(next.mcp).length === 0) delete next.mcp;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(config);
  if (changed) {
    backup(file);
    writeJson(file, next);
  }
  return changed;
}

function cleanupPriorMcpSources({ owned, exceptFile }) {
  if (!owned) return [];
  const actions = [];
  const except = normalizePath(exceptFile);
  for (const source of ownedSourceRecords(owned)) {
    if (except && normalizePath(source.file) === except) continue;
    if (removeOwnedMcp({ file: source.file, kind: source.kind, target: owned.target })) {
      actions.push(`mcp: removed ${SERVER} from prior ${source.file}`);
    }
  }
  return actions;
}

function writeOwnership({ home, configFile, configKind, target, files = [], configFiles = [] }) {
  writeJson(OWNERSHIP_FILE({ home }), {
    schema_version: 1,
    host: HOST,
    server: SERVER,
    config_file: configFile,
    config_kind: configKind,
    target,
    files,
    config_files: configFiles,
    managed_at: new Date().toISOString(),
  });
}

function templateFiles({ home, root }) {
  return [
    ['agents', 'ds-worker.md'],
    ['agents', 'ds-reviewer.md'],
    ['commands', 'dsh-config.md'],
    ['commands', 'dsh-status.md'],
  ].map(([dir, file]) => ({ source: join(root, 'zcode', dir, file), dest: join(home, '.zcode', dir, file) }));
}

function installTemplates({ home, root, priorFiles = [] }) {
  const actions = [];
  const records = [];
  for (const { source, dest } of templateFiles({ home, root })) {
    if (!existsSync(source)) return { ok: false, code: 'ZCODE_TEMPLATE_MISSING', source };
    mkdirSync(dirname(dest), { recursive: true });
    const before = readText(dest);
    const rendered = readFileSync(source, 'utf8');
    const previous = priorFiles.find((entry) => entry?.path === dest);
    let backupFile = previous?.backup ?? null;
    if (before !== rendered) {
      if (before !== null && !backupFile) backupFile = backup(dest);
      writeFileSync(dest, rendered);
    }
    actions.push(dest);
    records.push({
      path: dest,
      preexisting: previous?.preexisting === true || (previous === undefined && before !== null),
      ...(backupFile ? { backup: backupFile } : {}),
      managed_sha256: contentHash(rendered),
    });
  }
  return { ok: true, actions, records };
}

function updateMcp({ home, root }) {
  const source = configSource({ home });
  const target = expectedTarget({ root });
  const current = source.servers[SERVER];
  const currentTarget = serverTarget(current);
  const owned = ownership({ home });
  if (current && currentTarget !== target) {
    // Only an exact previously-owned entry may be repaired. Any foreign
    // command, even if it is also named dsh-crew, is a hard collision.
    if (!(owned && owned.config_file === source.file && normalizePath(owned.target) === currentTarget)) {
      return { ok: false, code: 'ZCODE_MCP_COLLISION', config_file: source.file };
    }
  }

  const next = { ...source.config };
  if (source.kind === 'native') next.mcp = { ...(next.mcp ?? {}), servers: { ...source.servers, [SERVER]: { command: 'node', args: [target] } } };
  else next.mcpServers = { ...source.servers, [SERVER]: { command: 'node', args: [target] } };
  const changed = JSON.stringify(next) !== JSON.stringify(source.config);
  if (changed) { backup(source.file); writeJson(source.file, next); }
  return { ok: true, changed, config_file: source.file, config_kind: source.kind, target };
}

export function installZCode({ home = homedir(), root = ROOT } = {}) {
  const templates = templateFiles({ home, root });
  const missing = templates.find(({ source }) => !existsSync(source));
  if (missing) return { ok: false, code: 'ZCODE_TEMPLATE_MISSING', source: missing.source };
  const previousOwnership = ownership({ home });
  const priorFiles = previousOwnership?.files ?? [];
  // Check for collisions before writing any other integration surface so a
  // failed install is transaction-like and leaves user files untouched.
  const mcp = updateMcp({ home, root });
  if (!mcp.ok) return mcp;
  const policy = installPolicy({ home, root });
  if (!policy.ok) return policy;
  const installed = installTemplates({ home, root, priorFiles });
  if (!installed.ok) return installed;
  cleanupPriorMcpSources({ owned: previousOwnership, exceptFile: mcp.config_file });
  const currentSourceRecord = { file: mcp.config_file, kind: mcp.config_kind };
  const priorSourceRecords = ownedSourceRecords(previousOwnership)
    .filter((record) => normalizePath(record.file) !== normalizePath(currentSourceRecord.file));
  writeOwnership({
    home,
    configFile: mcp.config_file,
    configKind: mcp.config_kind,
    target: mcp.target,
    files: installed.records,
    configFiles: [currentSourceRecord, ...priorSourceRecords],
  });
  return { ok: true, ...mcp, policy_file: policy.file, files: installed.actions };
}

function zcodeComponents({ home = homedir(), root = ROOT } = {}) {
  const expected = normalizePath(expectedTarget({ root }));
  const source = configSource({ home });
  const configured = serverTarget(source.servers[SERVER]);
  const owned = ownership({ home });
  const components = {
    mcp: configured === expected,
    policy: typeof readText(join(home, '.zcode', 'AGENTS.md')) === 'string' && readText(join(home, '.zcode', 'AGENTS.md')).includes(POLICY_START),
    worker_agent: existsSync(join(home, '.zcode', 'agents', 'ds-worker.md')),
    reviewer_agent: existsSync(join(home, '.zcode', 'agents', 'ds-reviewer.md')),
    config_prompt: existsSync(join(home, '.zcode', 'commands', 'dsh-config.md')),
    status_prompt: existsSync(join(home, '.zcode', 'commands', 'dsh-status.md')),
    ownership: !!owned && owned.config_file === source.file && normalizePath(owned.target) === expected,
  };
  return { components, source, expected, configured, owned };
}

export function zcodeStatus({ home = homedir(), root = ROOT } = {}) {
  const { components, source, expected, configured } = zcodeComponents({ home, root });
  const missing = Object.entries(components).filter(([, value]) => !value).map(([key]) => key);
  const installed = Object.values(components).some(Boolean);
  return {
    installed,
    ready: missing.length === 0,
    components,
    missing,
    config_file: source.file,
    config_kind: source.kind,
    target: configured ?? expected,
  };
}

export function uninstallZCode({ home = homedir() } = {}) {
  const actions = [];
  const owned = ownership({ home });
  if (owned) {
    for (const source of ownedSourceRecords(owned)) {
      if (removeOwnedMcp({ file: source.file, kind: source.kind, target: owned.target })) {
        actions.push(`mcp: removed ${SERVER} from ${source.file}`);
      }
    }
    rmSync(OWNERSHIP_FILE({ home }), { force: true });
  }
  if (removePolicy({ home })) actions.push('policy: removed managed ZCode block');
  const managedFiles = Array.isArray(owned?.files) && owned.files.length
    ? owned.files
    : ['agents/ds-worker.md', 'agents/ds-reviewer.md', 'commands/dsh-config.md', 'commands/dsh-status.md']
      .map((rel) => ({ path: join(home, '.zcode', rel) }));
  for (const entry of managedFiles) {
    const file = entry?.path;
    if (!file || !existsSync(file)) continue;
    const current = readText(file);
    const unchanged = !entry.managed_sha256 || (current !== null && contentHash(current) === entry.managed_sha256);
    if (!unchanged) continue;
    if (entry.preexisting && entry.backup && existsSync(entry.backup)) {
      copyFileSync(entry.backup, file);
      actions.push(`restored: ${file}`);
    } else {
      rmSync(file, { force: true });
      actions.push(`removed: ${file}`);
    }
  }
  return { ok: true, actions };
}

export function zcodeOwnershipFile({ home = homedir() } = {}) { return OWNERSHIP_FILE({ home }); }
