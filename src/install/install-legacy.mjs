// One-click installers: register the Claude Code plugin persistently and
// render Codex agent roles with real paths. Called from the CLI entry or the
// DSH settings page. All edits are backed up and idempotent.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, rmSync, statSync, lstatSync, opendirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { normalizeModelPriority } from '../model-routing.mjs';
import { crewSkillFiles, installCrewSkill, readCrewSkill, removeCrewSkill } from './crew-skill.mjs';
import { zcodeStatus } from './zcode.mjs';
import { integrationRoot } from './crew-paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARKETPLACE_NAME = 'dsh-crew';
const PLUGIN_KEY = `dsh-crew@${MARKETPLACE_NAME}`;
// A Claude Code plugin refresh is a real copy of the plugin tree, and its cost
// tracks machine load: 163s measured idle, ~6 minutes measured during an
// activation. The install is the step that copies, so it gets the ceiling that
// has to fit that; `marketplace add` and `uninstall` measure ~3s each and keep a
// short one. Sizing the install ceiling below the copy is not a slow update, it is
// a broken integration: the tree is killed and Claude Code is left without the
// plugin the same run had just removed.
const CLAUDE_STEP_TIMEOUT_MS = 300_000;
const CLAUDE_INSTALL_TIMEOUT_MS = 900_000;
// How long a landing kill gets to actually close the child before the step ends
// and reports the termination as unconfirmed.
const CLAUDE_KILL_GRACE_MS = 15_000;
const CLAUDE_SNAPSHOT_SETTLE_MS = 180_000;
const CLAUDE_SNAPSHOT_POLL_MS = 5_000;
// The one scope this installer writes, and therefore the only scope whose record
// means "the integration is installed". Accepting any scope let a project-scope
// record stand in for a missing user-scope snapshot, so a failed install read as
// a current one.
const CLAUDE_PLUGIN_SCOPE = 'user';
// What a module specifier can look like: a relative or absolute path, a package
// name, or a scoped one. Anything else the scan produces is the source text
// between two quotes, not a dependency.
const SPECIFIER_SHAPE = /^(?:(?:\.{1,2}\/|\/|[A-Za-z]:[\\/])[^\s"']*|(?:@[^/\s]+\/[^/\s]+|[A-Za-z][\w.-]*)(?:\/[^\s"']*)?)$/;

// A `/` starts a regular expression, not a division, when the last significant
// token could not end an expression. Getting this wrong desynchronises the scan:
// the quotes inside a regex were read as string delimiters, and everything after
// them — including real imports — was swallowed into a phantom literal.
const REGEX_MAY_FOLLOW = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '=>',
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await',
]);

/**
 * Split module source into tokens: comments dropped, string and template literals
 * kept whole, regular-expression literals kept whole, identifiers single, and
 * everything else one character. Specifiers are then read from tokens rather than
 * from the raw text, so a keyword inside a comment or a string is not a
 * declaration and a quote inside a regex is not a string.
 */
function tokenizeModuleSource(source) {
  const tokens = [];
  const text = String(source ?? '');
  let i = 0;
  let previous = null;
  const push = (token) => { tokens.push(token); previous = token; };
  const scanQuoted = (quote) => {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === quote) { j += 1; break; }
      if (quote !== '`' && text[j] === '\n') break;
      j += 1;
    }
    push(text.slice(i, j));
    i = j;
  };
  const scanRegex = () => {
    let j = i + 1;
    let inClass = false;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') break;
      if (inClass) { if (c === ']') inClass = false; }
      else if (c === '[') inClass = true;
      else if (c === '/') { j += 1; break; }
      j += 1;
    }
    while (j < text.length && /[a-z]/i.test(text[j])) j += 1;
    push(text.slice(i, j));
    i = j;
  };
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '/' && text[i + 1] === '/') { const end = text.indexOf('\n', i); i = end === -1 ? text.length : end; continue; }
    if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { scanQuoted(ch); continue; }
    if (ch === '/' && (previous === null || REGEX_MAY_FOLLOW.has(previous))) { scanRegex(); continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[\w$]/.test(text[j])) j += 1;
      push(text.slice(i, j));
      i = j;
      continue;
    }
    push(ch);
    i += 1;
  }
  return tokens;
}
const POLICY_START = '<!-- DSH CREW MANAGED POLICY:START -->';
const POLICY_END = '<!-- DSH CREW MANAGED POLICY:END -->';

/**
 * The directory Codex actually reads.
 *
 * Codex honours `CODEX_HOME` and falls back to `~/.codex`; writing only to the
 * latter silently does nothing for anyone who set it — the registration stays
 * frozen on whatever release was current when they set it, while every install
 * reports success because the file it wrote really did change. Resolve the same
 * way Codex does, and treat an empty or whitespace value as unset.
 */
export function codexHomeDir(home = homedir(), env = process.env) {
  const override = typeof env?.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  return override ? resolve(override) : join(home, '.codex');
}
export const CODEX_LEGACY_POLICY_HASHES = Object.freeze([
  '2d6f3839bb3df4bda90f481726281292b1a4b4585298b1cf9ec56215295b5c78',
]);
// dsh_worker_config is included so the session commands (/dsh-crew:config,
// /dsh-config) and any orchestrator policy lookup run without an extra
// authorization prompt.
export const MCP_TOOLS = ['dsh_run_worker', 'dsh_spawn_worker', 'dsh_worker_status', 'dsh_worker_result', 'dsh_worker_cancel', 'dsh_worker_config'];

function backup(file) {
  if (existsSync(file)) {
    const bak = `${file}.dsh-crew-backup-${Date.now()}`;
    copyFileSync(file, bak);
    return bak;
  }
  return null;
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

function normalizedPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const path = resolve(value);
    return process.platform === 'win32' ? path.toLowerCase() : path;
  } catch { return null; }
}

function renderedCodexRole(root, file) {
  const source = readText(join(root, 'codex', 'agents', file));
  if (source === null) return null;
  const renderedPath = join(root, 'src', 'server.mjs').replace(/\\/g, '/');
  return source.replace(/args = \[.*server\.mjs"\]/, `args = ["${renderedPath}"]`);
}

export function codexLegacyPolicyDigest(text) {
  const canonical = typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
  return canonical ? createHash('sha256').update(canonical, 'utf8').digest('hex') : null;
}
export function stripKnownLegacyCodexPolicy(text, { knownHashes = CODEX_LEGACY_POLICY_HASHES } = {}) {
  if (typeof text !== 'string') return text;
  const start = POLICY_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const end = POLICY_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${start}[\\s\\S]*?${end}`, 'm').exec(text);
  if (!match) return text;
  const allowed = new Set(Array.isArray(knownHashes) ? knownHashes : []);
  const prefix = text.slice(0, match.index);
  const suffix = text.slice(match.index + match[0].length);
  const keptPrefix = allowed.has(codexLegacyPolicyDigest(prefix)) ? '' : prefix;
  const keptSuffix = allowed.has(codexLegacyPolicyDigest(suffix)) ? '' : suffix;
  return `${keptPrefix}${match[0]}${keptSuffix}`;
}

/** The installed skill is present and still matches the payload template. */
function crewSkillInstalled({ home, root, env = process.env }) {
  const expected = readCrewSkill({ root });
  if (expected === null) return false;
  // Every host directory must hold the current template, not just the first.
  return crewSkillFiles({ home, env }).every((file) => readText(file) === expected);
}
function uninstallGlobalCodexPolicy({ home, env = process.env }) {
  const file = join(codexHomeDir(home, env), 'AGENTS.md');
  const current = readText(file);
  if (typeof current !== 'string') return null;
  const managed = new RegExp(`(?:\\r?\\n){0,2}${POLICY_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${POLICY_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\r?\\n)?`, 'm');
  if (!managed.test(current)) return null;
  const next = current.replace(managed, '').trimEnd();
  backup(file);
  if (next.trim()) writeFileSync(file, `${next}\n`);
  else rmSync(file);
  return `codex global policy: removed managed block`;
}

function tomlSection(text, name) {
  if (typeof text !== 'string') return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`, 'm').exec(text);
  if (!header) return null;
  const rest = text.slice(header.index + header[0].length);
  const nextHeader = rest.search(/^\s*\[[^\]\r\n]+\]\s*(?:#.*)?$/m);
  return nextHeader === -1 ? rest : rest.slice(0, nextHeader);
}

function existingServerTarget(block) {
  if (typeof block !== 'string' || !/^\s*command\s*=\s*"node"\s*$/m.test(block)) return null;
  const match = /^\s*args\s*=\s*\[\s*"([^"\r\n]*server\.mjs)"\s*\]\s*$/m.exec(block);
  if (!match) return null;
  try {
    if (!statSync(match[1]).isFile()) return null;
    const target = resolve(match[1]);
    return process.platform === 'win32' ? target.toLowerCase() : target;
  } catch { return null; }
}

function codexRoleTarget(file, expectedName) {
  const text = readText(file);
  if (typeof text !== 'string'
    || !new RegExp(`^\\s*name\\s*=\\s*"${expectedName}"\\s*$`, 'm').test(text)) return null;
  return existingServerTarget(tomlSection(text, 'mcp_servers.dsh-crew'));
}

function codexMcpTarget(configText) {
  const section = tomlSection(configText, 'mcp_servers');
  if (!section) return null;
  const entry = /^\s*dsh-crew\s*=\s*\{\s*command\s*=\s*"node"\s*,\s*args\s*=\s*\[\s*"([^"\r\n]*server\.mjs)"\s*\]\s*\}\s*(?:#.*)?$/m.exec(section);
  if (!entry) return null;
  try {
    if (!statSync(entry[1]).isFile()) return null;
    const target = resolve(entry[1]);
    return process.platform === 'win32' ? target.toLowerCase() : target;
  } catch { return null; }
}

function isFile(file) {
  try { return statSync(file).isFile(); } catch { return false; }
}

function claudePluginRootReady(root) {
  if (typeof root !== 'string' || !root.trim() || !isFile(join(root, 'src', 'server.mjs'))) return false;
  const plugin = readJson(join(root, '.claude-plugin', 'plugin.json'), null);
  const mcp = plugin?.mcpServers?.['dsh-crew'];
  return !!plugin
    && typeof plugin.version === 'string'
    && mcp?.command === 'node'
    && Array.isArray(mcp.args)
    && mcp.args.length === 1
    && mcp.args[0] === '${CLAUDE_PLUGIN_ROOT}/src/server.mjs';
}

export function managedClaudeFileManifest(root, { maxFiles = 512, maxBytes = 8 * 1024 * 1024, maxDirectories = 256, maxDepth = 12, maxEntries = 2048 } = {}) {
  const files = [];
  let bytes = 0;
  let directories = 0;
  let entries = 0;
  const add = (file, relativePath) => {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('unsupported snapshot entry');
    // Bound before reading, not after: reading first and rejecting afterwards
    // loads a whole oversized file on the strength of its name.
    if (files.length >= maxFiles || bytes + info.size > maxBytes) throw new Error('snapshot manifest bound exceeded');
    const content = readFileSync(file);
    bytes += content.length;
    files.push([relativePath.replace(/\\/g, '/'), createHash('sha256').update(content).digest('hex')]);
  };
  const listEntries = (directory) => {
    // Enumerated incrementally, and rejected the moment it goes over budget:
    // `readdirSync` materialises the whole listing first, so a bound applied to
    // its result is a bound applied after the cost has already been paid.
    const found = [];
    const handle = opendirSync(directory);
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        if (++entries > maxEntries) throw new Error('snapshot entry count exceeded');
        found.push(entry);
      }
    } finally {
      try { handle.closeSync(); } catch { /* already closed */ }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  };
  const walk = (directory, relativeDirectory, depth = 0) => {
    if (depth > maxDepth) throw new Error('snapshot directory depth exceeded');
    if (!existsSync(directory)) return;
    if (++directories > maxDirectories) throw new Error('snapshot directory count exceeded');
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('unsupported snapshot directory');
    for (const entry of listEntries(directory)) {
      const file = join(directory, entry.name);
      const relativePath = join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('snapshot symlink not allowed');
      if (entry.isDirectory()) walk(file, relativePath, depth + 1);
      else if (entry.isFile()) add(file, relativePath);
      else throw new Error('unsupported snapshot entry');
    }
  };
  try {
    add(join(root, '.claude-plugin', 'plugin.json'), join('.claude-plugin', 'plugin.json'));
    if (isFile(join(root, 'package.json'))) add(join(root, 'package.json'), 'package.json');
    // What the plugin loads, not just what names it. `worker.cordis.yml` is
    // required before any dispatch (`src/jobs.mjs` throws without it) and the
    // statusline scripts are named by the settings this installer writes, so a
    // snapshot missing either is not this release even when the manifest it came
    // from is byte-identical — which is exactly how a stale snapshot used to read
    // as current.
    if (isFile(join(root, 'worker.cordis.yml'))) add(join(root, 'worker.cordis.yml'), 'worker.cordis.yml');
    for (const directory of ['agents', 'commands', 'skills', 'src', 'statusline']) walk(join(root, directory), directory);
    return files;
  } catch { return null; }
}

function sameManagedClaudeFiles(expectedRoot, snapshotRoot) {
  if (!claudePluginRootReady(expectedRoot) || !claudePluginRootReady(snapshotRoot)) return false;
  const expected = managedClaudeFileManifest(expectedRoot);
  const snapshot = managedClaudeFileManifest(snapshotRoot);
  return expected !== null && snapshot !== null && JSON.stringify(snapshot) === JSON.stringify(expected);
}

function claudeSnapshotReady(home, root, { scope = null } = {}) {
  const installed = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'), {});
  const record = installed?.plugins?.[PLUGIN_KEY];
  const entries = Array.isArray(record) ? record : [record];
  return entries.some((entry) => (scope === null || entry?.scope === scope)
    && sameManagedClaudeFiles(root, entry?.installPath)
    && claudeSnapshotResolvable(entry?.installPath));
}

function claudePermissionsReady(settings) {
  const allowed = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  return MCP_TOOLS.every((tool) => allowed.includes(`mcp__plugin_dsh-crew_dsh-crew__${tool}`));
}

// One-time migration from the pre-rename config dir (dsh-workers → dsh-crew).
try {
  const oldDir = join(homedir(), '.config', 'dsh-workers');
  const newDir = join(homedir(), '.config', 'dsh-crew');
  if (existsSync(oldDir) && !existsSync(newDir)) {
    const { renameSync } = await import('node:fs');
    renameSync(oldDir, newDir);
  }
} catch {}

const GLOBAL_CONFIG_FILE = join(CONFIG_DIR_HOME(), 'config.json');
function CONFIG_DIR_HOME() { return join(homedir(), '.config', 'dsh-crew'); }

export const GLOBAL_CONFIG_DEFAULTS = {
  default_tier: 'flash',
  default_effort: 'max',
  mode: 'auto',
  default_timeout_seconds: 1800,
  hub_url: 'http://127.0.0.1:3080',
  // auto = orchestrator picks the tier; flash-only / pro-only clamp every
  // dispatch to one tier at the tool layer regardless of what was requested.
  tier_policy: 'flash-only',
  // When a blocking flash run fails, retry the same task once on pro.
  escalate_on_failure: false,
  // ---- configurable-crew orchestration (see src/policy.mjs) ----
  // Master switch for the whole worker dispatch path (hard, backend-enforced).
  subagents_enabled: true,
  // flash-only | pro-only | balanced | review-pipeline | custom
  collaboration_mode: 'flash-only',
  // direct-allowed | coordinator-first | dispatcher-only (host routing
  // guidance — the Crew MCP backend cannot restrict the host's own tools).
  main_agent_mode: 'direct-allowed',
  // Per-tier state: disabled | manual | auto. Owned by the collaboration
  // preset unless collaboration_mode is "custom".
  flash_state: 'auto',
  pro_state: 'disabled',
  // Roles per tier: routing guidance only, not a keyword classifier.
  flash_roles: ['implementation', 'simple_fix', 'tests', 'search_inspection'],
  pro_roles: ['architecture', 'complex_debugging', 'refactor', 'code_review', 'implementation'],
  // Automatic Pro review after a successful Flash run (review-pipeline forces
  // this on; balanced/custom only when this flag is set).
  pro_reviews_flash: false,
  // Worker provider routing for HUB workers: which DSH provider backs each
  // worker session. Fresh installs stay on the built-in DeepSeek provider;
  // follow-dsh is an explicit opt-in that uses the provider selected in DSH
  // Models (Flash/Pro still map to the selected Harness models).
  // Standalone mode always uses deepseek-official + DEEPSEEK_API_KEY.
  worker_provider_mode: 'deepseek-official',
  // Ordered Harness provider/model selections. The configured flags preserve
  // the distinction between a fresh recommendation and a user-cleared list.
  flash_model_priority: [],
  flash_model_priority_configured: false,
  flash_model_fallback: 'harness-default',
  pro_model_priority: [],
  pro_model_priority_configured: false,
  pro_model_fallback: 'harness-default',
  // User-added model ids per provider, merged into the panel's model list.
  extra_models: {},
  // Hub-mode agent preset per tier: 'default' follows the DSH roster default.
  // Harness Default uses the session-aware filesystem/shell stack. The DSH
  // minimal preset's provider-native tools use the Host process cwd instead,
  // so it is unsafe as the fresh default for jobs targeting another workspace.
  preset_flash: 'default',
  preset_pro: 'default',
  // ---- v0.2 runtime execution (writable via the settings config endpoint) ----
  // Concurrency cap for parallel workflows; isolation: worktree = run coding
  // workers in per-job git worktrees (fail-closed for non-git workspaces),
  // shared = legacy in-place behaviour.
  max_parallel: 3,
  isolation: 'worktree',
  // ---- v0.2 role state overrides (writable; unset = derived by migration) ----
  // Explicit worker/reviewer role states (auto | manual | disabled) and the
  // automatic-review switch. When unset, migrateLegacyConfig derives them from
  // collaboration_mode / tier_policy / pro_reviews_flash.
  worker_state: undefined,
  review_state: undefined,
  auto_review: undefined,
  // ---- per-model peak/off-peak scheduling ----
  // Some providers price by wall clock (DeepSeek doubles its rate during peak
  // hours). `models` lists only the restricted models — one absent from it is
  // unrestricted — each at `warn` (selectable, flagged) or `block` (skipped, so
  // the next candidate serves the job). Times are the operator's local wall
  // clock at `timezone_offset_minutes`, defaulting to UTC+8 with DeepSeek's
  // published peak hours expressed in it.
  model_schedule: undefined,
};

/** Config keys removed with the vision / image-generation bridge. */
export const REMOVED_MULTIMODAL_KEYS = Object.freeze([
  'vision_enabled', 'imagegen_enabled', 'vision_provider', 'vision_model',
  'imagegen_provider', 'custom_providers',
]);

export function mergeStoredGlobalConfig(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { ...GLOBAL_CONFIG_DEFAULTS };
  const has = (key) => Object.prototype.hasOwnProperty.call(stored, key);
  const merged = { ...GLOBAL_CONFIG_DEFAULTS, ...stored };
  // Keys that belonged to the removed vision / image-generation bridge. The
  // merge above keeps unknown stored keys for forward compatibility, so a file
  // written by an older release would otherwise carry them forever. These are
  // known-dead, so drop exactly them and leave every other unknown key alone.
  for (const dead of REMOVED_MULTIMODAL_KEYS) delete merged[dead];
  // Fields introduced by configurable Crew keep the prior release's behavior
  // when an existing file predates them. Only a genuinely fresh config gets
  // the new minimal defaults above.
  if (!has('collaboration_mode')) {
    merged.collaboration_mode = stored.tier_policy === 'flash-only' ? 'flash-only'
      : stored.tier_policy === 'pro-only' ? 'pro-only' : 'balanced';
  }
  if (!has('flash_state') || !has('pro_state')) {
    if (stored.tier_policy === 'flash-only') { merged.flash_state = 'auto'; merged.pro_state = 'disabled'; }
    else if (stored.tier_policy === 'pro-only') { merged.flash_state = 'disabled'; merged.pro_state = 'auto'; }
    else { merged.flash_state = 'auto'; merged.pro_state = 'auto'; }
  }
  if (!has('main_agent_mode')) merged.main_agent_mode = 'coordinator-first';
  if (!has('worker_provider_mode')) merged.worker_provider_mode = 'deepseek-official';
  // Existing configs that predate preset_flash should inherit the current safe
  // Harness Default. The older implicit `minimal` migration is unsafe for
  // workspace-targeted jobs on Windows; an explicit user-set `minimal` value
  // is still preserved by the normal object merge above.
  if (!has('preset_flash')) merged.preset_flash = 'default';
  return merged;
}

export function readGlobalConfig({ configFile = GLOBAL_CONFIG_FILE } = {}) {
  if (!existsSync(configFile)) return { ...GLOBAL_CONFIG_DEFAULTS };
  return mergeStoredGlobalConfig(readJson(configFile, {}));
}

export function writeGlobalConfig(patch) {
  mkdirSync(CONFIG_DIR_HOME(), { recursive: true });
  const next = { ...readGlobalConfig() };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v !== undefined && k in GLOBAL_CONFIG_DEFAULTS) next[k] = v;
  }
  for (const tier of ['flash', 'pro']) {
    const key = `${tier}_model_priority`;
    if (patch?.[key] !== undefined) {
      next[key] = normalizeModelPriority(patch[key]);
      next[`${tier}_model_priority_configured`] = true;
    }
  }
  // Legacy clamp fields stay writable (session commands still read them), and
  // a tier_policy write resyncs the new fields so old UIs can't drift apart
  // from the new policy. Deprecated but harmless.
  if (patch?.tier_policy !== undefined) {
    next.tier_policy = patch.tier_policy;
    if (patch.tier_policy === 'flash-only') { next.collaboration_mode = 'flash-only'; }
    else if (patch.tier_policy === 'pro-only') { next.collaboration_mode = 'pro-only'; }
    else if (next.collaboration_mode === 'flash-only' || next.collaboration_mode === 'pro-only') { next.collaboration_mode = 'balanced'; }
  }
  writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** What is currently installed where — drives the settings-page buttons. */
export function installStatus({ home = homedir(), root = ROOT, env = process.env } = {}) {
  // Host integrations are installed from the profile's loader link, not from the
  // release directory, so an upgrade re-points one link instead of rewriting four
  // host configurations. Readiness has to judge them against the path they were
  // actually written with: deriving it from the release directory made every
  // correctly installed machine read as needing repair.
  const manifestName = readJson(join(root, 'package.json'), {})?.name ?? null;
  const effectiveRoot = integrationRoot({ home, root, name: manifestName });
  const settings = readJson(join(home, '.claude', 'settings.json'), {});
  const enabled = settings.enabledPlugins;
  const claudeInstalled = !!(enabled && !Array.isArray(enabled) && enabled[PLUGIN_KEY]);
  const hudWired = typeof settings.statusLine?.command === 'string'
    && settings.statusLine.command.includes('worker-segment.sh');
  const marketplaceRoot = settings?.extraKnownMarketplaces?.[MARKETPLACE_NAME]?.source?.path;
  const installedPluginRecord = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'), {})?.plugins?.[PLUGIN_KEY];
  const claudeFootprint = claudeInstalled || typeof marketplaceRoot === 'string' || installedPluginRecord !== undefined;
  const claudeComponents = {
    enabled: claudeInstalled,
    marketplace: normalizedPath(marketplaceRoot) === normalizedPath(effectiveRoot) && claudePluginRootReady(effectiveRoot),
    // User scope only: this installer writes that scope, so it is the one whose
    // record means the integration is installed. Accepting any scope let a
    // project-scope record make a missing user-scope snapshot read as present.
    snapshot: claudeSnapshotReady(home, effectiveRoot, { scope: CLAUDE_PLUGIN_SCOPE }),
    permissions: claudePermissionsReady(settings),
  };
  const claudeMissing = Object.entries(claudeComponents).filter(([, present]) => !present).map(([key]) => key);
  const codexRoot = codexHomeDir(home, env);
  const configFile = join(codexRoot, 'config.toml');
  const configText = readText(configFile) ?? '';
  const workerFile = join(codexRoot, 'agents', 'ds-worker.toml');
  const reviewerFile = join(codexRoot, 'agents', 'ds-reviewer.toml');
  const workerTarget = codexRoleTarget(workerFile, 'ds-worker');
  const reviewerTarget = codexRoleTarget(reviewerFile, 'ds-reviewer');
  const mcpTarget = codexMcpTarget(configText);
  const expectedTarget = normalizedPath(join(effectiveRoot, 'src', 'server.mjs'));
  const expectedWorkerRole = renderedCodexRole(effectiveRoot, 'ds-worker.toml');
  const expectedReviewerRole = renderedCodexRole(effectiveRoot, 'ds-reviewer.toml');
  const expectedConfigPrompt = readText(join(effectiveRoot, 'codex', 'prompts', 'dsh-config.md'));
  const expectedStatusPrompt = readText(join(effectiveRoot, 'codex', 'prompts', 'dsh-status.md'));
  const components = {
    worker_role: expectedWorkerRole !== null && readText(workerFile) === expectedWorkerRole,
    reviewer_role: expectedReviewerRole !== null && readText(reviewerFile) === expectedReviewerRole,
    config_prompt: expectedConfigPrompt !== null && readText(join(codexRoot, 'prompts', 'dsh-config.md')) === expectedConfigPrompt,
    status_prompt: expectedStatusPrompt !== null && readText(join(codexRoot, 'prompts', 'dsh-status.md')) === expectedStatusPrompt,
    mcp: !!expectedTarget && mcpTarget === expectedTarget,
    target_alignment: !!expectedTarget && workerTarget === expectedTarget && reviewerTarget === expectedTarget && mcpTarget === expectedTarget,
    skill: crewSkillInstalled({ home, root, env }),
  };
  const codexInstalled = Object.values(components).some(Boolean)
    || existsSync(join(codexRoot, 'agents', 'ds-flash.toml'))
    || existsSync(join(codexRoot, 'agents', 'ds-pro.toml'));
  const missing = Object.entries(components).filter(([, present]) => !present).map(([key]) => key);
  return {
    claude: {
      installed: claudeFootprint,
      ready: claudeMissing.length === 0,
      hud: hudWired,
      components: claudeComponents,
      missing: claudeMissing,
    },
    codex: { installed: codexInstalled, ready: missing.length === 0, components, missing },
    zcode: zcodeStatus({ home, root: effectiveRoot }),
  };
}

function removeLegacyCodexRoles({ agentsDir }) {
  const actions = [];
  for (const f of ['worker.toml', 'reviewer.toml']) {
    const p = join(agentsDir, f);
    if (!existsSync(p)) continue;
    // Only Crew's own abandoned stub is removed. An earlier release wrote these
    // before the roles were renamed to ds-worker/ds-reviewer, and every Codex
    // start since has logged "Ignoring malformed agent role definition" about a
    // file of ours that Codex cannot use: a role without `developer_instructions`
    // is not a role, so anything that *is* a real user role cannot match here.
    const text = readText(p);
    if (typeof text !== 'string') continue;
    const name = f.replace(/\.toml$/, '');
    const stripped = text.replace(/#[^\n]*/g, '').trim();
    if (/developer_instructions/.test(stripped)) continue;
    if (!new RegExp(`^name\\s*=\\s*["']${name}["']$`).test(stripped)) continue;
    const bak = backup(p);
    if (bak) actions.push(`backup: ${bak}`);
    rmSync(p);
    actions.push(`removed obsolete role: ${p}`);
  }
  return actions;
}

export function uninstallCodex({ home = homedir(), env = process.env } = {}) {
  const actions = [];
  // Both the v0.2 roles (ds-worker / ds-reviewer) and the deprecated v0.1
  // aliases (ds-flash / ds-pro) are dsh-crew managed; uninstall removes only
  // these, never a user's own role files.
  for (const f of ['ds-flash.toml', 'ds-pro.toml', 'ds-worker.toml', 'ds-reviewer.toml']) {
    const p = join(codexHomeDir(home, env), 'agents', f);
    if (existsSync(p)) { backup(p); rmSync(p); actions.push(`removed: ${p} (backup kept)`); }
  }
  actions.push(...removeLegacyCodexRoles({ agentsDir: join(codexHomeDir(home, env), 'agents') }));
  for (const f of ['dsh-config.md', 'dsh-status.md']) {
    const p = join(codexHomeDir(home, env), 'prompts', f);
    if (existsSync(p)) { rmSync(p); actions.push(`removed: ${p}`); }
  }
  const policyAction = uninstallGlobalCodexPolicy({ home, env });
  if (policyAction) actions.push(policyAction);
  const skillAction = removeCrewSkill({ home, env });
  if (skillAction.changed) actions.push(...skillAction.removed.map((dir) => `removed: ${dir}`));
  // Remove only the dsh-crew entry from [mcp_servers], keeping any other
  // MCP servers the user configured.
  const configFile = join(codexHomeDir(home, env), 'config.toml');
  if (existsSync(configFile)) {
    const before = readFileSync(configFile, 'utf8');
    const lineRe = /(^|\n)[ \t]*dsh-crew\s*=\s*\{[^\n]*\}/;
    const after = lineRe.test(before) ? before.replace(lineRe, '') : before;
    if (after !== before) {
      backup(configFile);
      writeFileSync(configFile, after.replace(/(^|\n){2,}/g, '\n\n').replace(/^\[mcp_servers\]\n?$/, ''));
      actions.push(`codex config: removed dsh-crew MCP entry`);
    }
  }
  return { ok: true, actions: actions.length ? actions : ['nothing to remove'] };
}

/**
 * The one line both install entries print for a Claude Code integration result.
 *
 * A missing `claude` CLI is a supported install, so `installClaudeCode` stays
 * best-effort and keeps `ok: true`. A CLI that is present and fails or times out
 * is a different thing: it leaves Claude Code without the plugin snapshot while
 * the settings still name it, which is the state `installStatus` later reads as
 * "needs repair". This used to be rendered separately in each entry — and only
 * one of them learned about `degraded`, so the other kept printing a checkmark.
 */
export function claudeIntegrationLine(result) {
  if (result?.ok === false) return '✗ Claude Code integration failed';
  if (result?.detected === false) {
    return '- Claude Code not detected; settings registered, CLI step skipped';
  }
  if (result?.degraded === true) {
    return `- Claude Code integration registered, but not loaded: ${result.reason ?? 'plugin snapshot not refreshed'}`;
  }
  return '✓ Claude Code integration';
}

/**
 * How long to keep watching the plugin snapshot after a failed CLI attempt.
 *
 * Zero unless that attempt timed out. The install is a real copy of the plugin
 * tree, and a timed-out child on Windows is not in the shell's process tree, so
 * it can go on writing after the shell has given up — that is the only case with
 * something to wait for. A `claude` that is not installed exits with status 1 and
 * never started a copy, and a CLI that failed on its own terms has already
 * stopped; waiting on either cost a fixed 180s on every update of a machine
 * without Claude Code, to learn nothing it did not already know.
 */
export function claudeSnapshotSettleMs(err) {
  // Only the shell's own timeout can leave a copy running. Matching on the signal
  // as well spent the whole window on an `ENOBUFS` (output over maxBuffer) child
  // that had already stopped and could never make the snapshot current.
  return err?.code === 'ETIMEDOUT' ? CLAUDE_SNAPSHOT_SETTLE_MS : 0;
}

/**
 * Whether the snapshot can actually run, not merely whether its files match.
 *
 * `src/server.mjs` is the MCP server Claude Code launches, so what has to be
 * present is what *it* imports. The manifest is not a substitute: it declares 28
 * dependencies, including meta-packages the server never imports from here, and
 * requiring all of them to resolve read a working install as broken. Resolution
 * follows local modules from the entry, and subpath specifiers are kept as they are —
 * `@modelcontextprotocol/sdk/server/mcp.js` resolves through its package's
 * `exports`, which the bare package name does not.
 */
function claudeSnapshotResolvable(snapshotRoot) {
  if (typeof snapshotRoot !== 'string' || !snapshotRoot.trim()) return false;
  const root = resolve(snapshotRoot);
  const visited = new Set();
  let bytes = 0;
  const inspect = (entry) => {
    if (visited.has(entry)) return true;
    if (visited.size >= 512) return false;
    const local = relative(root, entry);
    if (local.startsWith('..') || resolve(root, local) !== entry) return false;
    visited.add(entry);
    try {
      const info = lstatSync(entry);
      if (!info.isFile() || info.isSymbolicLink() || bytes + info.size > 8 * 1024 * 1024) return false;
      bytes += info.size;
      if (!/\.[cm]?js$/i.test(entry)) return true;
      const source = readFileSync(entry, 'utf8');
      const fromEntry = createRequire(entry);
      // Consume comments and literals as complete tokens before recognizing declarations.
      const tokens = tokenizeModuleSource(source);
      const specifiers = [];
      const literal = (token) => token && /^['"]/.test(token);
      for (let i = 0; i < tokens.length; i += 1) {
        if (!['import', 'export', 'require'].includes(tokens[i])) continue;
        if (tokens[i - 1] === '.') continue;
        let next = i + 1;
        while (tokens[next]?.startsWith('/*') || tokens[next]?.startsWith('//')) next += 1;
        if (['import', 'require'].includes(tokens[i]) && tokens[next] === '(') {
          if (literal(tokens[next + 1])) specifiers.push(tokens[next + 1].slice(1, -1));
          continue;
        }
        if (tokens[i] === 'require') continue;
        if (literal(tokens[next])) { specifiers.push(tokens[next].slice(1, -1)); continue; }
        // Only import/export declarations can introduce a `from` clause.
        if (tokens[next] === '.' || tokens[next] === '(' || ['const', 'let', 'var', 'function', 'class', 'default', 'async'].includes(tokens[next])) continue;
        for (let j = next; j < tokens.length && tokens[j] !== ';'; j += 1) {
          if (tokens[j] === 'from' && literal(tokens[j + 1])) { specifiers.push(tokens[j + 1].slice(1, -1)); break; }
        }
      }
      // The scan is lexical, and a regex literal holding a quote — `/^['"]/`, or
      // the TOML matchers above — desynchronises it: the phantom string swallows
      // text up to the next quote in the file, which can expose a keyword as a
      // bare token and hand back the source between two of them as a "specifier".
      // Those are not module specifiers, and resolving them read a working install
      // as broken, so anything not shaped like a path or a package name is dropped.
      const shaped = specifiers.filter((specifier) => isBuiltin(specifier) || SPECIFIER_SHAPE.test(specifier));
      return shaped.every((specifier) => {
        if (isBuiltin(specifier)) return true;
        const target = fromEntry.resolve(specifier);
        if (!existsSync(target)) return false;
        return specifier.startsWith('.') ? inspect(target) : true;
      });
    } catch { return false; }
  };
  return inspect(join(root, 'src', 'server.mjs'));
}

/**
 * The `claude` executable this machine actually has.
 *
 * `where claude` reports every match — the extensionless shim, `claude.cmd`, and
 * `claude.exe` on an install that ships the native binary. Detection and execution
 * are different questions: hardcoding `.cmd` meant a host with only the native
 * executable was detected and then could not be run. A native executable is
 * preferred because it starts without a command processor, so there is no quoting
 * to get wrong.
 */
export function pickClaudeCommand(candidates, { platform = process.platform } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).map((line) => String(line).trim()).filter(Boolean);
  if (!list.length) return null;
  if (platform !== 'win32') return list[0];
  // A native executable is preferred because it starts without a command
  // processor, so there is no quoting to get wrong.
  return list.find((candidate) => /\.exe$/i.test(candidate))
    ?? list.find((candidate) => /\.(cmd|bat)$/i.test(candidate))
    ?? list[0];
}

function resolveClaudeCommand({ platform = process.platform } = {}) {
  const probe = spawnSync(platform === 'win32' ? 'where' : 'which', ['claude'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (probe.status !== 0) return null;
  return pickClaudeCommand(String(probe.stdout ?? '').split(/\r?\n/), { platform });
}

/**
 * How to run the `claude` CLI, as an executable plus an argument array.
 *
 * Paths go in as arguments and never into a shell string: `JSON.stringify` quotes
 * for JSON, not for a command processor, so a path containing `%NAME%` was
 * expanded before the CLI ever saw it. Windows has to reach the CLI through a
 * command processor because a `.cmd` shim cannot be executed directly, so an
 * argument the processor would act on is refused rather than escaped — a refused
 * install is recoverable, a silently relocated path is not.
 */
export function claudeCliInvocation(args, { platform = process.platform, environment = process.env, executable = null } = {}) {
  const argv = args.map((arg) => String(arg));
  if (platform !== 'win32') return { command: executable ?? 'claude', args: argv };
  const target = executable ?? 'claude.cmd';
  // A native executable starts directly: no command processor, so no quoting rules
  // to be wrong about.
  if (/\.exe$/i.test(target)) return { command: target, args: argv };
  const unsafe = [target, ...argv].find((arg) => /[\0\r\n"%!^&|<>]/.test(arg));
  if (unsafe !== undefined) throw new Error(`unsafe claude CLI argument: ${unsafe}`);
  const quotedTarget = /\s/.test(target) ? `"${target}"` : target;
  return {
    command: environment.ComSpec || environment.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${[quotedTarget, ...argv.map((arg) => `"${arg}"`)].join(' ')}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Kill a process and everything it started.
 *
 * The killed shell is not the process doing the work: `claude` is a grandchild
 * that Windows does not reach when only its parent is terminated. An `uninstall`
 * left running that way finishes *after* the install that followed it and deletes
 * the plugin the install just registered, so the tree has to go, and the caller
 * must not return until it has.
 */
async function killClaudeProcessTree(pid, { platform = process.platform, timeoutMs = CLAUDE_KILL_GRACE_MS } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const { spawn } = await import('node:child_process');
  if (platform === 'win32') {
    return await new Promise((done) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); done(value); } };
      const timer = setTimeout(() => { killer.kill(); finish(false); }, timeoutMs);
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => finish(false));
      killer.on('close', (code) => finish(code === 0));
    });
  }
  try { process.kill(-pid, 'SIGKILL'); return true; } catch { /* fall through to the single pid */ }
  try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; }
}

/**
 * Run one CLI step to completion, or end it and its descendants on timeout.
 *
 * Resolves only once nothing from this step can still be running, so the next step
 * cannot be raced by the previous one — but it does resolve. A termination that
 * does not land is reported as unconfirmed rather than waited on forever, and a
 * timeout carries the shape `execSync` uses so the settle rule reads it the same
 * way.
 */
export async function runClaudeStep(args, { timeoutMs = CLAUDE_STEP_TIMEOUT_MS, executable = null, killGraceMs = CLAUDE_KILL_GRACE_MS, terminate = killClaudeProcessTree } = {}) {
  let invocation;
  try { invocation = claudeCliInvocation(args, { executable }); }
  catch (error) { return { ok: false, timedOut: false, refused: true, terminated: null, status: null, detail: '', error }; }
  const { spawn } = await import('node:child_process');
  const child = spawn(invocation.command, invocation.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
    detached: process.platform !== 'win32',
  });

  // Both pipes are drained. An unread pipe fills — 64 KiB is enough — and the
  // child then blocks on write, so a step that prints a lot of output never exits
  // and is killed at the ceiling for being talkative rather than for being stuck.
  let output = '';
  const drain = (chunk) => { output = (output + String(chunk)).slice(-400); };
  child.stdout?.on('data', drain);
  child.stderr?.on('data', drain);

  const exited = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, error: null }));
    child.on('error', (error) => resolve({ code: null, error }));
  });
  const bounded = async (promise, ms) => {
    let timer;
    try { return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  };

  let timedOut = false;
  let raiseCeiling;
  const ceiling = new Promise((resolve) => { raiseCeiling = resolve; });
  const timer = setTimeout(() => { timedOut = true; raiseCeiling(); }, timeoutMs);

  const outcome = await Promise.race([exited.then(() => 'exited'), ceiling.then(() => 'ceiling')]);
  clearTimeout(timer);

  if (outcome === 'ceiling') {
    // The kill is bounded too: a `taskkill` that itself hangs must not leave the
    // step pending any more than one that returns non-zero.
    const killLanded = await bounded(Promise.resolve().then(() => terminate(child.pid, { timeoutMs: killGraceMs })).catch(() => false), killGraceMs);
    // Give a landing kill its moment to actually close the child, and take the
    // close as proof if it arrives. Never wait on a termination that did not land:
    // the step has to end either way, and saying the tree is unconfirmed is the
    // honest result, not a pending promise.
    const closed = await bounded(exited.then(() => true), killGraceMs);
    const terminated = killLanded === true && closed === true;
    if (!closed) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
    return {
      ok: false,
      timedOut: true,
      refused: false,
      terminated,
      status: null,
      detail: output,
      error: Object.assign(new Error('claude CLI step timed out'), { code: 'ETIMEDOUT', signal: 'SIGTERM', status: null }),
    };
  }

  const { code, error } = await exited;
  return {
    ok: code === 0 && !error,
    timedOut: false,
    refused: false,
    terminated: null,
    status: code ?? null,
    detail: error ? `${output}${String(error?.message ?? error)}`.slice(-400) : output,
    error: error ?? null,
  };
}

export async function installClaudeCode({ home = homedir(), statusline = false, root = ROOT } = {}) {
  const actions = [];

  // The repository carries its own marketplace manifest (.claude-plugin/
  // marketplace.json with source "."), so the marketplace root IS the plugin
  // checkout itself — no parent-directory layout assumption. This keeps the
  // installer working when the repo is cloned anywhere (e.g. Desktop\dsh-crew).
  // `root` lets an npx-managed install point every rendered path at the
  // durable Crew-owned payload instead of a transient package extraction dir.
  const mpDir = root;
  actions.push(`marketplace: ${mpDir} (self-marketplace, source .)`);

  // 2. settings.json: marketplace + enabledPlugins + permissions allowlist.
  const settingsFile = join(home, '.claude', 'settings.json');
  try {
    mkdirSync(dirname(settingsFile), { recursive: true });
    const bak = backup(settingsFile);
    if (bak) actions.push(`backup: ${bak}`);
    const settingsPresent = existsSync(settingsFile);
    const parsed = readJson(settingsFile, null);
    if (parsed === null && settingsPresent) {
      // Present but unparseable is not "no settings yet". Rebuilding it as an
      // empty configuration is exactly how an operator's settings disappear, with
      // a backup left for them to restore by hand — the file is theirs, and an
      // unreadable one is not permission to replace it.
      return {
        ok: false,
        code: 'CLAUDE_SETTINGS_UNREADABLE',
        error: `${settingsFile} is present but not valid JSON`,
        actions,
      };
    }
    const settings = parsed ?? {};

    // Both fields are records (see json.schemastore.org/claude-code-settings.json).
    // Older versions of this installer wrote arrays, which Claude Code ignores
    // with a warning — migrate those in place.
    const markets = (settings.extraKnownMarketplaces && !Array.isArray(settings.extraKnownMarketplaces)
      && typeof settings.extraKnownMarketplaces === 'object') ? settings.extraKnownMarketplaces : {};
    if (Array.isArray(settings.extraKnownMarketplaces)) actions.push('migrated legacy extraKnownMarketplaces array');
    markets[MARKETPLACE_NAME] = { source: { source: 'directory', path: mpDir } };
    if (markets['dsh-workers']) {
      delete markets['dsh-workers'];
      actions.push('removed pre-rename dsh-workers marketplace entry');
    }
    settings.extraKnownMarketplaces = markets;

    const enabled = (settings.enabledPlugins && !Array.isArray(settings.enabledPlugins)
      && typeof settings.enabledPlugins === 'object') ? settings.enabledPlugins : {};
    if (Array.isArray(settings.enabledPlugins)) {
      for (const key of settings.enabledPlugins) if (typeof key === 'string') enabled[key] = true;
      actions.push('migrated legacy enabledPlugins array');
    }
    enabled[PLUGIN_KEY] = true;
    if (enabled['dsh-workers@dsh-workers']) {
      delete enabled['dsh-workers@dsh-workers'];
      actions.push('removed pre-rename dsh-workers plugin entry');
    }
    settings.enabledPlugins = enabled;

    settings.permissions = settings.permissions ?? {};
    let allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
    const preRename = allow.filter((r) => typeof r === 'string' && r.startsWith('mcp__plugin_dsh-workers_'));
    if (preRename.length) {
      allow = allow.filter((r) => !preRename.includes(r));
      actions.push(`removed ${preRename.length} pre-rename permission rules`);
    }
    for (const tool of MCP_TOOLS) {
      const rule = `mcp__plugin_dsh-crew_dsh-crew__${tool}`;
      if (!allow.includes(rule)) allow.push(rule);
    }
    settings.permissions.allow = allow;

    if (statusline && !settings.statusLine) {
      settings.statusLine = { type: 'command', command: `bash ${join(root, 'statusline', 'statusline.sh')}` };
      actions.push('statusline: installed');
    } else if (statusline) {
      actions.push('statusline: skipped (one already configured)');
    }

    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  } catch (error) {
    // Both install entries branch on `ok === false` for this integration and
    // neither could ever see it: a settings path that could not be backed up or
    // written threw straight out of both of them. Failing to register is the
    // integration failing, so it gets the shape its callers already handle.
    return { ok: false, code: 'CLAUDE_SETTINGS_UNWRITABLE', error: String(error?.message ?? error), actions };
  }
  actions.push(`settings: registered ${PLUGIN_KEY} + ${MCP_TOOLS.length} permission rules`);

  // Materialize the install through the claude CLI: registers the marketplace
  // in the plugin cache (settings alone leave a stale/absent cache entry) and
  // pulls the plugin so the next session loads it. Best-effort: settings are
  // already correct, so a missing CLI just means one manual `plugin install`.
  const registered = readJson(join(home, '.claude', 'plugins', 'known_marketplaces.json'), {})?.[MARKETPLACE_NAME];
  const installedRecord = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'), {})?.plugins?.[PLUGIN_KEY];
  const installedEntries = Array.isArray(installedRecord) ? installedRecord : [installedRecord];
  const marketplaceCurrent = registered?.source?.source === 'directory'
    && normalizedPath(registered.source.path) === normalizedPath(root)
    && normalizedPath(registered.installLocation) === normalizedPath(root);
  // The same predicate the post-attempt check uses, dependency resolution
  // included: a fast path that skipped it reported "already current" for a
  // snapshot the status surface reads as not ready.
  if (marketplaceCurrent && installedEntries.some((entry) => entry?.scope === CLAUDE_PLUGIN_SCOPE
    && sameManagedClaudeFiles(root, entry.installPath)
    && claudeSnapshotResolvable(entry.installPath))) {
    actions.push('cli: skipped (registered marketplace and snapshot already current)');
    return { ok: true, actions };
  }
  if (home !== homedir()) {
    actions.push('cli: skipped (non-default home; test mode)');
    return { ok: true, actions };
  }
  // The CLI is best-effort, but a host that does not have it must not be told to
  // run it. The checkout entry already gates on this; doing it here too keeps the
  // two entries describing the same machine the same way.
  const claudeCommand = resolveClaudeCommand();
  if (!claudeCommand) {
    actions.push('cli: skipped (claude not found)');
    return { ok: true, detected: false, actions };
  }
  return refreshClaudePlugin({ home, root, actions, claudeCommand });
}

// Keep CLI transaction ordering testable without changing the operator's home.
async function refreshClaudePlugin({ home, root, actions = [], claudeCommand, runStep = runClaudeStep }) {
  // Each step runs to completion — including ending the whole process tree on a
  // timeout — before the next one starts, and the settle window is the widest any
  // step asks for. Two things this replaces: an `uninstall` left running past its
  // timeout finished *after* the install that followed and deleted the plugin the
  // install had just registered, and a later step's ordinary failure used to erase
  // an earlier step's timeout from the evidence.
  // 300s, not 120: the install runs after the uninstall, so it does a real copy of
  // the plugin tree rather than the no-op an already-installed plugin gets.
  // Measured on this machine: `marketplace add` 3s, `uninstall` 3s, `install` 163s
  // (no-op install: 6s). The old ceiling killed the copy partway and left Claude
  // Code without the plugin the same run had just removed.
  let settleMs = 0;
  const noteStep = (step) => { settleMs = Math.max(settleMs, claudeSnapshotSettleMs(step?.error)); };

  const marketplace = await runStep(['plugin', 'marketplace', 'add', root], { executable: claudeCommand });
  noteStep(marketplace);
  if (!marketplace.ok) {
    // Registering is what says where the plugin comes from. Removing the current
    // one after it failed leaves the machine with neither, and that is exactly the
    // shape a refused path produces — where nothing was even attempted. The
    // existing integration is left exactly as it was.
    actions.push(`cli: plugin refresh skipped — marketplace registration failed${marketplace.timedOut ? ' (timed out)' : ''}`);
    return {
      ok: true,
      degraded: true,
      code: 'CLAUDE_MARKETPLACE_UNAVAILABLE',
      reason: `marketplace registration failed; the installed plugin was left untouched. Run: claude plugin marketplace add ${root}`,
      actions,
    };
  }
  actions.push('cli: marketplace registered');

  // `plugin install` on an already-installed plugin is a no-op and leaves a
  // stale snapshot in ~/.claude/plugins/cache — uninstall first so an update
  // always re-copies the current code.
  const uninstall = await runStep(['plugin', 'uninstall', PLUGIN_KEY], { executable: claudeCommand });
  noteStep(uninstall);
  if (uninstall.timedOut && !uninstall.terminated) {
    return { ok: false, code: 'CLAUDE_TERMINATION_UNCONFIRMED', reason: 'Uninstall termination could not be confirmed; plugin installation was not started.', actions };
  }

  // Newer Claude Code (>= 2.1.x) dropped the -y flag; older builds accepted it.
  // Try without it first, fall back to the legacy flag. This is the step that
  // copies, so it carries the ceiling sized for the copy.
  let install = await runStep(['plugin', 'install', PLUGIN_KEY, '--scope', CLAUDE_PLUGIN_SCOPE], { timeoutMs: CLAUDE_INSTALL_TIMEOUT_MS, executable: claudeCommand });
  if (!install.ok && !install.timedOut && /unknown option/i.test(String(install.detail ?? ''))) {
    install = await runStep(['plugin', 'install', PLUGIN_KEY, '--scope', CLAUDE_PLUGIN_SCOPE, '-y'], { timeoutMs: CLAUDE_INSTALL_TIMEOUT_MS, executable: claudeCommand });
  }
  noteStep(install);
  if (install.timedOut && !install.terminated) {
    return { ok: false, code: 'CLAUDE_TERMINATION_UNCONFIRMED', reason: 'Install termination could not be confirmed; snapshot readiness was not accepted.', actions };
  }
  actions.push(install.ok
    ? `cli: plugin snapshot refreshed (${PLUGIN_KEY})`
    : `cli: plugin install failed — run manually: claude plugin install ${PLUGIN_KEY}${install.timedOut ? ' (timed out)' : ''}`);
  // Report the state that resulted, not the step that was attempted. The CLI is
  // best-effort — a machine without `claude` is a supported install, and its
  // settings alone are correct — but a CLI that is present and slow, timed out,
  // or failed leaves the snapshot exactly as stale as it was, and it is the
  // snapshot that `installStatus` reads. Saying so here is what lets the caller
  // stop printing a checkmark for a state it never verified.
  if (claudeSnapshotReady(home, root, { scope: CLAUDE_PLUGIN_SCOPE })) return { ok: true, actions };
  // Reconcile snapshot records after a timed-out attempt, without starting another CLI step.
  const settleDeadline = Date.now() + settleMs;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  while (Date.now() < settleDeadline) {
    await wait(CLAUDE_SNAPSHOT_POLL_MS);
    if (claudeSnapshotReady(home, root, { scope: CLAUDE_PLUGIN_SCOPE })) {
      return { ok: true, actions: [...actions, 'cli: snapshot confirmed current after the ceiling'] };
    }
  }
  return {
    ok: true,
    degraded: true,
    code: 'CLAUDE_PLUGIN_SNAPSHOT_STALE',
    reason: `Claude Code has not loaded the plugin; run: claude plugin install ${PLUGIN_KEY}`,
    actions,
  };
}

export function installCodex({ home = homedir(), scope, root = ROOT, env = process.env } = {}) {
  const actions = [];
  const agentsDir = scope === 'project' ? join(process.cwd(), '.codex', 'agents') : join(codexHomeDir(home, env), 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const srcDir = join(root, 'codex', 'agents');
  // Windows drive paths must render with forward slashes: backslashes in a
  // TOML basic string are escape sequences (\\U\\u... are invalid), which made
  // the role files unparseable for Codex Desktop. node accepts forward slashes
  // on Windows, so the absolute path rendered as D:/... is both valid TOML and
  // runnable. `root` targets the durable installed payload for npx installs.
  const renderedPath = join(root, 'src', 'server.mjs').replace(/\\/g, '/');
  for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.toml'))) {
    const dest = join(agentsDir, f);
    const bak = backup(dest);
    if (bak) actions.push(`backup: ${bak}`);
    const rendered = renderedCodexRole(root, f);
    writeFileSync(dest, rendered);
    actions.push(`role: ${dest}`);
  }
  const promptsDir = scope === 'project' ? join(process.cwd(), '.codex', 'prompts') : join(codexHomeDir(home, env), 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const promptsSrc = join(root, 'codex', 'prompts');
  for (const f of readdirSync(promptsSrc).filter((f) => f.endsWith('.md'))) {
    writeFileSync(join(promptsDir, f), readFileSync(join(promptsSrc, f), 'utf8'));
    actions.push(`prompt: ${join(promptsDir, f)}`);
  }
  actions.push(...removeLegacyCodexRoles({ agentsDir }));
  if (scope !== 'project') {
    const act = writeGlobalCodexMcpServer(home, renderedPath, env);
    actions.push(...act);
    // Crew guidance is a skill now, loaded only when the operator asks for it.
    // Removing the policy block here cleans up what an earlier release put in
    // the host instruction file; ignoring the result keeps the first install on
    // a machine that never had one quiet.
    const droppedPolicy = uninstallGlobalCodexPolicy({ home, env });
    if (droppedPolicy) actions.push(`removed delegating policy block: ${join(codexHomeDir(home, env), 'AGENTS.md')}`);
    const skill = installCrewSkill({ home, root, env });
    if (!skill.ok) return { ok: false, actions: [...actions, `crew skill: ${skill.code}`] };
    actions.push(...skill.written.map((file) => `skill: ${file}`));
  }
  return { ok: true, actions };
}

/**
 * Codex Desktop reads the shared config at ~/.codex/config.toml, and the role
 * files alone only expose dsh MCP tools inside the ds-flash/ds-pro subagents.
 * To make dsh_worker_config (policy) visible to the MAIN Codex session, add a
 * top-level [mcp_servers] entry under dsh-crew — preserving any other servers
 * the user already configured. Idempotent (updates in place). Never requires
 * the codex CLI.
 */
export function writeGlobalCodexMcpServer(home, renderedPath, env = process.env) {
  const configFile = join(codexHomeDir(home, env), 'config.toml');
  const entry = `dsh-crew = { command = "node", args = ["${renderedPath}"] }`;
  const backupFile = backup(configFile);
  const existing = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
  const hasSection = /(^|\n)\s*\[mcp_servers\]/.test(existing);
  const sectionIdx = hasSection ? existing.search(/(^|\n)\s*\[mcp_servers\]/) : -1;

  let next;
  if (hasSection) {
    // Section exists: find its extent (next top-level [section]) and patch the
    // dsh-crew entry within it.
    const afterHeader = sectionIdx + existing.slice(sectionIdx).indexOf(']') + 1;
    const rest = existing.slice(afterHeader);
    const nextHeader = rest.search(/(^|\n)\s*\[[^\]]+\]/);
    const sectionBody = nextHeader === -1 ? rest : rest.slice(0, nextHeader);
    const tail = nextHeader === -1 ? '' : rest.slice(nextHeader);
    const lineRe = /(^|\n)([ \t]*)dsh-crew\s*=\s*\{[^\n]*\}/;
    const patched = lineRe.test(sectionBody)
      ? sectionBody.replace(lineRe, `$1$2${entry}`)
      : `${sectionBody.replace(/\s*$/, '')}\n${entry}`;
    next = existing.slice(0, afterHeader) + patched + tail;
  } else {
    // No [mcp_servers] section: append a fresh one.
    const sep = existing && !/[\n]$/.test(existing) ? '\n' : '';
    next = `${existing}${sep}[mcp_servers]\n${entry}\n`;
  }
  writeFileSync(configFile, next);
  const actions = [];
  if (backupFile) actions.push(`config backup: ${backupFile}`);
  actions.push(`codex config: [mcp_servers] dsh-crew → ${renderedPath}`);
  return actions;
}

export function installHudSegment({ home = homedir() } = {}) {
  const settingsFile = join(home, '.claude', 'settings.json');
  const settings = readJson(settingsFile, null);
  if (!settings) return { ok: false, actions: ['settings.json not found'] };
  const cmd = settings.statusLine?.command;
  if (typeof cmd !== 'string' || !cmd.includes('claude-hud')) {
    return { ok: false, actions: ['statusLine is not claude-hud; use statusline/statusline.sh directly instead'] };
  }
  const segment = join(ROOT, 'statusline', 'worker-segment.sh');
  if (cmd.includes(segment)) return { ok: true, actions: ['already wired'] };
  if (cmd.includes('worker-segment.sh')) {
    // Wired to a stale copy (e.g. pre-rename path) — repoint the --extra-cmd at the current segment.
    const next = cmd.replace(/--extra-cmd "bash [^"]*worker-segment\.sh"/, `--extra-cmd "bash ${segment}"`);
    if (next === cmd) return { ok: false, actions: ['worker-segment.sh present but path not replaceable; rewire manually'] };
    const bak = backup(settingsFile);
    settings.statusLine.command = next;
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    return { ok: true, actions: [...(bak ? [`backup: ${bak}`] : []), `statusLine: repointed worker-segment.sh to ${segment}`] };
  }
  let next = cmd;
  if (!next.includes('CLAUDE_HUD_ALLOW_EXTRA_CMD')) {
    next = next.replace(/exec\s+/, 'exec env CLAUDE_HUD_ALLOW_EXTRA_CMD=1 ');
    if (!next.includes('CLAUDE_HUD_ALLOW_EXTRA_CMD')) return { ok: false, actions: ['could not find exec in statusLine command; wire manually'] };
  }
  const extra = ` --extra-cmd "bash ${segment}"`;
  if (next.endsWith("'")) next = next.slice(0, -1) + extra + "'";
  else next += extra;
  const bak = backup(settingsFile);
  settings.statusLine.command = next;
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  return { ok: true, actions: [...(bak ? [`backup: ${bak}`] : []), 'statusLine: claude-hud now runs worker-segment.sh via --extra-cmd'] };
}

export function uninstallClaudeCode({ home = homedir() } = {}) {
  const settingsFile = join(home, '.claude', 'settings.json');
  const settings = readJson(settingsFile, null);
  if (!settings) return { ok: true, actions: ['settings.json not found'] };
  backup(settingsFile);
  const mpDir = join(home, '.config', 'dsh-crew', 'marketplace');
  if (Array.isArray(settings.extraKnownMarketplaces)) {
    settings.extraKnownMarketplaces = settings.extraKnownMarketplaces.filter((m) => m?.path !== mpDir);
  } else if (settings.extraKnownMarketplaces) {
    delete settings.extraKnownMarketplaces[MARKETPLACE_NAME];
  }
  if (Array.isArray(settings.enabledPlugins)) {
    settings.enabledPlugins = settings.enabledPlugins.filter((p) => p !== PLUGIN_KEY);
  } else if (settings.enabledPlugins) {
    delete settings.enabledPlugins[PLUGIN_KEY];
  }
  if (settings.permissions?.allow) {
    settings.permissions.allow = settings.permissions.allow.filter((r) => !r.startsWith('mcp__plugin_dsh-crew_'));
  }
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  return { ok: true, actions: ['unregistered from settings.json (backup kept)'] };
}
