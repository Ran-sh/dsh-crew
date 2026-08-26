// Codex installer regression tests — Codex Desktop support without the CLI.
// The installer only writes shared config (~/.codex/...), never spawns codex,
// so a missing CLI must not block install. Also covers: preserving unrelated
// MCP servers / agents, idempotency, precise uninstall, and valid TOML on
// Windows (forward-slash paths, no backslash escapes).
// Run with: node --test test/codex-install.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MCP_TOOLS, installCodex, installStatus, uninstallCodex, writeGlobalCodexMcpServer } from '../src/install/install.mjs';

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-crew-codex-test-'));
}
function read(path) { return readFileSync(path, 'utf8'); }

test('Case 1: install succeeds with ~/.codex available and no codex CLI (no spawn)', async () => {
  const home = makeHome();
  try {
    const r = installCodex({ home });
    assert.equal(r.ok, true);
    assert.ok(existsSync(join(home, '.codex', 'agents', 'ds-flash.toml')));
    assert.ok(existsSync(join(home, '.codex', 'agents', 'ds-pro.toml')));
    assert.ok(existsSync(join(home, '.codex', 'prompts', 'dsh-config.md')));
    assert.ok(existsSync(join(home, '.codex', 'prompts', 'dsh-status.md')));
    const status = installStatus({ home });
    assert.equal(status.codex.installed, true);
    assert.equal(status.codex.ready, true);
    assert.deepEqual(status.codex.missing, []);
    assert.deepEqual(status.codex.components, {
      worker_role: true,
      reviewer_role: true,
      config_prompt: true,
      status_prompt: true,
      mcp: true,
      target_alignment: true,
    });
    // installCodex never tries to execute the codex CLI (its body is pure file I/O).
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex readiness distinguishes a partial legacy install from a complete integration', () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, '.codex', 'agents'), { recursive: true });
    writeFileSync(join(home, '.codex', 'agents', 'ds-flash.toml'), '[agent]\n');
    const status = installStatus({ home }).codex;
    assert.equal(status.installed, true);
    assert.equal(status.ready, false);
    assert.deepEqual(status.missing, ['worker_role', 'reviewer_role', 'config_prompt', 'status_prompt', 'mcp', 'target_alignment']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex readiness fails closed when config.toml is unreadable', () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, '.codex', 'config.toml'), { recursive: true });
    const status = installStatus({ home }).codex;
    assert.equal(status.ready, false);
    assert.equal(status.components.mcp, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex readiness rejects an unrelated TOML section and a missing MCP target', () => {
  const home = makeHome();
  try {
    const configDir = join(home, '.codex');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.toml'), '[unrelated]\ndsh-crew = { command = "node", args = ["D:/missing/server.mjs"] }\n');
    assert.equal(installStatus({ home }).codex.components.mcp, false);

    writeFileSync(join(configDir, 'config.toml'), '[mcp_servers]\ndsh-crew = { command = "node", args = ["D:/missing/server.mjs"] }\n');
    assert.equal(installStatus({ home }).codex.components.mcp, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex readiness rejects a stale managed role target', () => {
  const home = makeHome();
  try {
    installCodex({ home });
    writeFileSync(join(home, '.codex', 'agents', 'ds-worker.toml'), '[mcp_servers.dsh-crew]\ncommand = "node"\nargs = ["D:/missing/server.mjs"]\n');
    const status = installStatus({ home }).codex;
    assert.equal(status.components.worker_role, false);
    assert.equal(status.ready, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex readiness requires Worker, Reviewer, and global MCP to use one server target', () => {
  const home = makeHome();
  try {
    installCodex({ home });
    const alternate = join(home, 'older-release', 'src', 'server.mjs');
    mkdirSync(join(home, 'older-release', 'src'), { recursive: true });
    writeFileSync(alternate, 'export {};\n');
    writeFileSync(join(home, '.codex', 'config.toml'), `[mcp_servers]\ndsh-crew = { command = "node", args = ["${alternate.replace(/\\/g, '/')}"] }\n`);
    const status = installStatus({ home }).codex;
    assert.equal(status.components.worker_role, true);
    assert.equal(status.components.reviewer_role, true);
    assert.equal(status.components.mcp, true);
    assert.equal(status.components.target_alignment, false);
    assert.equal(status.ready, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Claude readiness does not equate an enabled setting with a callable plugin', () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'dsh-crew@dsh-crew': true },
    }));
    const status = installStatus({ home }).claude;
    assert.equal(status.installed, true);
    assert.equal(status.ready, false);
    assert.deepEqual(status.missing, ['marketplace', 'snapshot', 'permissions']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Claude readiness validates marketplace, installed snapshot, and tool permissions', () => {
  const home = makeHome();
  try {
    const marketplace = join(home, 'payload');
    const snapshot = join(home, '.claude', 'plugins', 'cache', 'dsh-crew', 'dsh-crew', '0.1.0');
    for (const root of [marketplace, snapshot]) {
      mkdirSync(join(root, '.claude-plugin'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{}\n');
      writeFileSync(join(root, '.mcp.json'), '{}\n');
      writeFileSync(join(root, 'src', 'server.mjs'), 'export {};\n');
    }
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'dsh-crew@dsh-crew': { installPath: snapshot } },
    }));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'dsh-crew@dsh-crew': true },
      extraKnownMarketplaces: { 'dsh-crew': { source: { source: 'directory', path: marketplace } } },
      permissions: { allow: MCP_TOOLS.map((tool) => `mcp__plugin_dsh-crew_dsh-crew__${tool}`) },
    }));
    const status = installStatus({ home }).claude;
    assert.equal(status.installed, true);
    assert.equal(status.ready, true);
    assert.deepEqual(status.missing, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Case 4: installed role files render the local server.mjs path', async () => {
  const home = makeHome();
  try {
    installCodex({ home });
    const flash = read(join(home, '.codex', 'agents', 'ds-flash.toml'));
    const pro = read(join(home, '.codex', 'agents', 'ds-pro.toml'));
    for (const toml of [flash, pro]) {
      assert.match(toml, /server\.mjs/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Case 5: repeat install is idempotent', async () => {
  const home = makeHome();
  try {
    installCodex({ home });
    installCodex({ home });
    const agents = readdirSync(join(home, '.codex', 'agents'));
    assert.equal(agents.filter((a) => a.startsWith('ds-') && a.endsWith('.toml')).length, 4);
    const prompts = readdirSync(join(home, '.codex', 'prompts'));
    assert.equal(prompts.filter((p) => p.startsWith('dsh-')).length, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Case 3: existing user agents are preserved', async () => {
  const home = makeHome();
  try {
    const agentsDir = join(home, '.codex', 'agents');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'my-reviewer.toml'), 'name = "my-reviewer"\n');
    installCodex({ home });
    assert.ok(existsSync(join(agentsDir, 'my-reviewer.toml')), 'user agent must survive');
    assert.ok(existsSync(join(agentsDir, 'ds-flash.toml')));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Case 2: existing other MCP servers in config.toml are preserved', async () => {
  const home = makeHome();
  try {
    const cfgDir = join(home, '.codex');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'config.toml'), 'model = "gpt-x"\n[mcp_servers]\nother = { command = "other", args = ["-m"] }\n[desktop]\nfoo = 1\n');
    installCodex({ home });
    const s = read(join(cfgDir, 'config.toml'));
    assert.match(s, /other = \{ command = "other"/, 'other MCP server must survive');
    assert.match(s, /dsh-crew = \{ command = "node"/, 'dsh-crew MCP entry must be added');
    assert.match(s, /\[desktop\]/, 'unrelated sections must survive');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Case 7: Windows absolute path renders valid TOML (forward slashes, no backslash escapes)', async () => {
  const home = makeHome();
  try {
    installCodex({ home });
    const toml = read(join(home, '.codex', 'agents', 'ds-flash.toml'));
    const m = toml.match(/args = \["([^"]*server\.mjs)"\]/);
    assert.ok(m, 'args line must exist');
    const p = m[1];
    assert.ok(!/\\\\/.test(p) && !/\\[A-Za-z]/.test(p), `no raw backslash escape in TOML string: ${p}`);
    assert.match(p, /\//, 'path should use forward slashes so TOML basic strings are valid');
    // The same rendered path must be what writeGlobalCodexMcpServer writes.
    const cfg = join(home, '.codex', 'config.toml');
    assert.match(read(cfg), new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Case 6: uninstall removes only dsh-crew artifacts', async () => {
  const home = makeHome();
  try {
    const { mkdirSync } = await import('node:fs');
    const cfgDir = join(home, '.codex');
    mkdirSync(join(cfgDir, 'agents'), { recursive: true });
    mkdirSync(join(cfgDir, 'prompts'), { recursive: true });
    writeFileSync(join(cfgDir, 'agents', 'my-reviewer.toml'), 'name = "my-reviewer"\n');
    writeFileSync(join(cfgDir, 'config.toml'), 'model = "gpt-x"\n[mcp_servers]\nother = { command = "other" }\ndsh-crew = { command = "node", args = ["D:/x/server.mjs"] }\n[desktop]\nfoo = 1\n');
    installCodex({ home });
    const u = uninstallCodex({ home });
    assert.equal(u.ok, true);
    assert.ok(!existsSync(join(cfgDir, 'agents', 'ds-flash.toml')));
    assert.ok(!existsSync(join(cfgDir, 'prompts', 'dsh-config.md')));
    assert.ok(existsSync(join(cfgDir, 'agents', 'my-reviewer.toml')), 'user agent must survive uninstall');
    const cfg = read(join(cfgDir, 'config.toml'));
    assert.ok(!/dsh-crew/.test(cfg), 'dsh-crew MCP entry must be removed');
    assert.match(cfg, /other = \{ command = "other"/, 'other MCP server must survive uninstall');
    assert.match(cfg, /\[desktop\]/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('writeGlobalCodexMcpServer is idempotent (no duplicate entries)', async () => {
  const home = makeHome();
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeGlobalCodexMcpServer(home, 'D:/proj/dsh-crew/src/server.mjs');
    writeGlobalCodexMcpServer(home, 'D:/proj/dsh-crew/src/server.mjs');
    const s = read(join(home, '.codex', 'config.toml'));
    assert.equal((s.match(/dsh-crew = \{/g) || []).length, 1, 'only one dsh-crew entry');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('writeGlobalCodexMcpServer appends a fresh [mcp_servers] when the file has none', async () => {
  const home = makeHome();
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-x"\n');
    writeGlobalCodexMcpServer(home, 'D:/proj/dsh-crew/src/server.mjs');
    const s = read(join(home, '.codex', 'config.toml'));
    assert.match(s, /\[mcp_servers\]\n\s*dsh-crew = \{ command = "node"/);
    assert.match(s, /model = "gpt-x"/, 'existing content preserved');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
