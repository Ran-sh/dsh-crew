// One-click installers: register the Claude Code plugin persistently and
// render Codex agent roles with real paths. Called from the CLI entry or the
// DSH settings page. All edits are backed up and idempotent.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { normalizeModelPriority } from '../model-routing.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARKETPLACE_NAME = 'dsh-crew';
const PLUGIN_KEY = `dsh-crew@${MARKETPLACE_NAME}`;
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
  // worker session. follow-dsh = use the provider selected in DSH Models
  // (Flash/Pro still map to deepseek-v4-flash / deepseek-v4-pro);
  // deepseek-official = always use the built-in provider (legacy behavior,
  // kept the default so upgraded configs never silently switch providers).
  // Standalone mode always uses deepseek-official + DEEPSEEK_API_KEY.
  worker_provider_mode: 'follow-dsh',
  // Ordered Harness provider/model selections. The configured flags preserve
  // the distinction between a fresh recommendation and a user-cleared list.
  flash_model_priority: [],
  flash_model_priority_configured: false,
  flash_model_fallback: 'harness-default',
  pro_model_priority: [],
  pro_model_priority_configured: false,
  pro_model_fallback: 'harness-default',
  // ---- configurable-crew multimodal switches ----
  // False = the Crew describe_image tool and vision route are not registered
  // at DSH boot (takes effect after a DSH restart). Provider/model values are
  // kept untouched so re-enabling restores the previous setup.
  vision_enabled: false,
  imagegen_enabled: false,
  // Multimodal bridge: which subscription CLI lends the text-only DS model
  // eyes (describe_image) and a brush (generate_image).
  vision_provider: 'claude-code', // claude-code | codex | grok | agy | <custom id> | off
  vision_model: 'haiku', // model passed to the vision CLI; free-form
  imagegen_provider: 'codex', // codex | agy | grok | <custom id> | off
  // User-defined providers, each either an OpenAI-compatible HTTP endpoint or a
  // local command. Entry shape:
  //   { id, name, type: 'api' | 'cli', models: [],
  //     api: base_url, api_key, imagegen_model
  //     cli: vision_command, imagegen_command }
  // CLI commands run via bash with shell-quoted placeholders: vision
  // {image} {question} {model} (stdout is the answer), imagegen
  // {prompt} {output} {size} (must write the file to {output}).
  custom_providers: [],
  // User-added model ids per provider, merged into the panel's model list.
  extra_models: {},
  // Hub-mode agent preset per tier: 'default' follows the DSH roster default.
  // Harness Default uses the session-aware filesystem/shell stack. The DSH
  // minimal preset's provider-native tools use the Host process cwd instead,
  // so it is unsafe as the fresh default for jobs targeting another workspace.
  preset_flash: 'default',
  preset_pro: 'default',
};

export function mergeStoredGlobalConfig(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { ...GLOBAL_CONFIG_DEFAULTS };
  const has = (key) => Object.prototype.hasOwnProperty.call(stored, key);
  const merged = { ...GLOBAL_CONFIG_DEFAULTS, ...stored };
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
  // Preserve the prior release's Flash preset for existing files that predate
  // this field; only a genuinely fresh/no-file config gets Harness Default.
  if (!has('preset_flash')) merged.preset_flash = 'minimal';
  if (!has('vision_enabled')) merged.vision_enabled = stored.vision_provider !== 'off';
  if (!has('imagegen_enabled')) merged.imagegen_enabled = stored.imagegen_provider !== 'off';
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
export function installStatus({ home = homedir() } = {}) {
  const settings = readJson(join(home, '.claude', 'settings.json'), {});
  const enabled = settings.enabledPlugins;
  const claudeInstalled = !!(enabled && !Array.isArray(enabled) && enabled[PLUGIN_KEY]);
  const hudWired = typeof settings.statusLine?.command === 'string'
    && settings.statusLine.command.includes('worker-segment.sh');
  const codexInstalled = existsSync(join(home, '.codex', 'agents', 'ds-flash.toml'));
  return { claude: { installed: claudeInstalled, hud: hudWired }, codex: { installed: codexInstalled } };
}

export function uninstallCodex({ home = homedir() } = {}) {
  const actions = [];
  for (const f of ['ds-flash.toml', 'ds-pro.toml']) {
    const p = join(home, '.codex', 'agents', f);
    if (existsSync(p)) { backup(p); rmSync(p); actions.push(`removed: ${p} (backup kept)`); }
  }
  for (const f of ['dsh-config.md', 'dsh-status.md']) {
    const p = join(home, '.codex', 'prompts', f);
    if (existsSync(p)) { rmSync(p); actions.push(`removed: ${p}`); }
  }
  // Remove only the dsh-crew entry from [mcp_servers], keeping any other
  // MCP servers the user configured.
  const configFile = join(home, '.codex', 'config.toml');
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

export async function installClaudeCode({ home = homedir(), statusline = false } = {}) {
  const actions = [];

  // The repository carries its own marketplace manifest (.claude-plugin/
  // marketplace.json with source "."), so the marketplace root IS the plugin
  // checkout itself — no parent-directory layout assumption. This keeps the
  // installer working when the repo is cloned anywhere (e.g. Desktop\dsh-crew).
  const mpDir = ROOT;
  actions.push(`marketplace: ${mpDir} (self-marketplace, source .)`);

  // 2. settings.json: marketplace + enabledPlugins + permissions allowlist.
  const settingsFile = join(home, '.claude', 'settings.json');
  mkdirSync(dirname(settingsFile), { recursive: true });
  const bak = backup(settingsFile);
  if (bak) actions.push(`backup: ${bak}`);
  const settings = readJson(settingsFile, {});

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
    settings.statusLine = { type: 'command', command: `bash ${join(ROOT, 'statusline', 'statusline.sh')}` };
    actions.push('statusline: installed');
  } else if (statusline) {
    actions.push('statusline: skipped (one already configured)');
  }

  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  actions.push(`settings: registered ${PLUGIN_KEY} + ${MCP_TOOLS.length} permission rules`);

  // Materialize the install through the claude CLI: registers the marketplace
  // in the plugin cache (settings alone leave a stale/absent cache entry) and
  // pulls the plugin so the next session loads it. Best-effort: settings are
  // already correct, so a missing CLI just means one manual `plugin install`.
  if (home !== homedir()) {
    actions.push('cli: skipped (non-default home; test mode)');
    return { ok: true, actions };
  }
  try {
    const { execSync } = await import('node:child_process');
    const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    try { run(`claude plugin marketplace add ${JSON.stringify(mpDir)}`); actions.push('cli: marketplace registered'); }
    catch { actions.push('cli: marketplace add skipped (already registered)'); }
    // `plugin install` on an already-installed plugin is a no-op and leaves a
    // stale snapshot in ~/.claude/plugins/cache — uninstall first so an update
    // always re-copies the current code.
    try { run(`claude plugin uninstall ${PLUGIN_KEY}`); } catch {}
    // Newer Claude Code (>= 2.1.x) dropped the -y flag; older builds accepted
    // it. Try without it first, fall back to the legacy flag.
    try {
      run(`claude plugin install ${PLUGIN_KEY} --scope user`);
    } catch (errNoFlag) {
      if (!String(errNoFlag?.message ?? '').includes('unknown option')) throw errNoFlag;
      run(`claude plugin install ${PLUGIN_KEY} --scope user -y`);
    }
    actions.push(`cli: plugin snapshot refreshed (${PLUGIN_KEY})`);
  } catch (err) {
    actions.push(`cli: plugin install failed — run manually: claude plugin install ${PLUGIN_KEY} (${String(err?.message ?? err).slice(0, 120)})`);
  }
  return { ok: true, actions };
}

export function installCodex({ home = homedir(), scope } = {}) {
  const actions = [];
  const agentsDir = scope === 'project' ? join(process.cwd(), '.codex', 'agents') : join(home, '.codex', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const srcDir = join(ROOT, 'codex', 'agents');
  // Windows drive paths must render with forward slashes: backslashes in a
  // TOML basic string are escape sequences (\\U\\u... are invalid), which made
  // the role files unparseable for Codex Desktop. node accepts forward slashes
  // on Windows, so the absolute path rendered as D:/... is both valid TOML and
  // runnable.
  const renderedPath = join(ROOT, 'src', 'server.mjs').replace(/\\/g, '/');
  for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.toml'))) {
    const dest = join(agentsDir, f);
    const bak = backup(dest);
    if (bak) actions.push(`backup: ${bak}`);
    const rendered = readFileSync(join(srcDir, f), 'utf8')
      .replace(/args = \[.*server\.mjs"\]/, `args = ["${renderedPath}"]`);
    writeFileSync(dest, rendered);
    actions.push(`role: ${dest}`);
  }
  const promptsDir = scope === 'project' ? join(process.cwd(), '.codex', 'prompts') : join(home, '.codex', 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const promptsSrc = join(ROOT, 'codex', 'prompts');
  for (const f of readdirSync(promptsSrc).filter((f) => f.endsWith('.md'))) {
    writeFileSync(join(promptsDir, f), readFileSync(join(promptsSrc, f), 'utf8'));
    actions.push(`prompt: ${join(promptsDir, f)}`);
  }
  if (scope !== 'project') {
    const act = writeGlobalCodexMcpServer(home, renderedPath);
    actions.push(...act);
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
export function writeGlobalCodexMcpServer(home, renderedPath) {
  const configFile = join(home, '.codex', 'config.toml');
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
