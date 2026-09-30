// Installer regression tests: the Claude MCP permission allowlist must
// include dsh_worker_config, be idempotent across repeated installs, upgrade
// an old 5-tool list, and uninstall must only remove dsh-crew's own rules.
// Runs against a throwaway home dir — the real ~/.claude is never touched.
// Run with: node --test test/installer.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installClaudeCode, uninstallClaudeCode, claudeIntegrationLine, installStatus, MCP_TOOLS } from '../src/install/install.mjs';

const CREW_PREFIX = 'mcp__plugin_dsh-crew_dsh-crew__';
const rule = (t) => `${CREW_PREFIX}${t}`;

// The integration is gated on the host having the `claude` CLI: registering a
// plugin a machine cannot run leaves Crew's entries in a file Crew cannot
// exercise. Fixtures below that exercise the writer declare that precondition;
// the absent-CLI behavior has its own test.
const claudePresent = () => 'claude.cmd';

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-crew-install-test-'));
}

function readSettings(home) {
  try { return JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')); } catch { return null; }
}

test('MCP_TOOLS export includes dsh_worker_config', () => {
  assert.ok(MCP_TOOLS.includes('dsh_worker_config'));
  assert.equal(MCP_TOOLS.length, 6);
});

test('fresh install writes all 6 permission rules including dsh_worker_config', async () => {
  const home = makeHome();
  try {
    await installClaudeCode({ home, resolveClaude: claudePresent });
    const allow = readSettings(home).permissions.allow;
    for (const t of MCP_TOOLS) assert.ok(allow.includes(rule(t)), `missing rule for ${t}`);
    assert.equal(allow.filter((r) => typeof r === 'string' && r.startsWith(CREW_PREFIX)).length, 6);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('second install does not duplicate permission rules', async () => {
  const home = makeHome();
  try {
    await installClaudeCode({ home, resolveClaude: claudePresent });
    await installClaudeCode({ home, resolveClaude: claudePresent });
    const allow = readSettings(home).permissions.allow;
    for (const t of MCP_TOOLS) {
      assert.equal(allow.filter((r) => r === rule(t)).length, 1, `duplicate rule for ${t}`);
    }
    assert.equal(allow.filter((r) => typeof r === 'string' && r.startsWith(CREW_PREFIX)).length, 6);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('upgrade: an old 5-tool list gains dsh_worker_config exactly once', async () => {
  const home = makeHome();
  try {
    const old = ['dsh_run_worker', 'dsh_spawn_worker', 'dsh_worker_status', 'dsh_worker_result', 'dsh_worker_cancel'];
    const settingsFile = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({
      extraKnownMarketplaces: {}, enabledPlugins: {},
      permissions: { allow: [...old.map(rule), 'mcp__other__tool'] },
    }, null, 2));
    await installClaudeCode({ home, resolveClaude: claudePresent });
    const allow = readSettings(home).permissions.allow;
    assert.ok(allow.includes(rule('dsh_worker_config')), 'dsh_worker_config missing after upgrade');
    assert.equal(allow.filter((r) => r === rule('dsh_worker_config')).length, 1);
    // the other plugin's rule is preserved
    assert.ok(allow.includes('mcp__other__tool'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// A host that cannot run the plugin must not be registered: the settings Crew
// would write exist only to make Crew callable from Claude Code, so on a machine
// without the CLI they are a footprint that reads back as an integration wanting
// something the machine does not have.
test('a host without the claude CLI gets no Claude configuration written', async () => {
  const home = makeHome();
  const fresh = makeHome();
  try {
    const settingsFile = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2) + '\n');
    const before = readFileSync(settingsFile, 'utf8');

    const r = await installClaudeCode({ home, resolveClaude: () => null });
    assert.equal(r.ok, true);
    assert.equal(r.detected, false);
    assert.equal(readFileSync(settingsFile, 'utf8'), before, 'the operator settings file is byte-identical');
    assert.equal(existsSync(join(home, '.claude', 'plugins')), false, 'no plugin cache is produced');
    assert.match(claudeIntegrationLine(r), /nothing written/);

    // A home with no ~/.claude at all stays that way.
    const r2 = await installClaudeCode({ home: fresh, resolveClaude: () => null });
    assert.equal(r2.ok, true);
    assert.equal(existsSync(join(fresh, '.claude')), false, 'no directory is created for a host that cannot use it');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});

// Configured is a settings file that names Crew; callable is the CLI being there.
// The two must stay separate: an operator reading "installed" on a host with no
// Claude Code was reading a footprint, not a working integration.
test('with the CLI present the registration is written, and readiness stays configured-not-callable', async () => {
  const home = makeHome();
  try {
    const r = await installClaudeCode({ home, resolveClaude: claudePresent });
    assert.equal(r.ok, true);
    assert.notEqual(r.detected, false);
    assert.ok(readSettings(home).permissions.allow.includes(rule('dsh_run_worker')), 'registration written when the host can use it');
    assert.ok(r.actions.some((a) => a.startsWith('cli: skipped (non-default home')), 'only the CLI step is skipped for a fixture home');

    const status = installStatus({ home, claudeDetected: false, env: {} });
    assert.equal(status.claude.installed, true, 'the footprint is recorded');
    assert.equal(status.claude.host_detected, false, 'while the host is not there — the two fields a renderer needs');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('uninstall removes every Crew registration, including cache records, and keeps other plugins', async () => {
  const home = makeHome();
  try {
    const plugins = join(home, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    const settingsFile = join(home, '.claude', 'settings.json');
    const marketsFile = join(plugins, 'known_marketplaces.json');
    const installedFile = join(plugins, 'installed_plugins.json');
    // Third-party state this uninstall has no business touching, plus the
    // pre-rename `dsh-workers` identity an upgraded machine still carries.
    writeFileSync(settingsFile, JSON.stringify({
      extraKnownMarketplaces: {
        'other-market': { source: { source: 'directory', path: 'C:/other' } },
        'dsh-workers': { source: { source: 'directory', path: 'C:/old' } },
      },
      enabledPlugins: { 'other@other-market': true, 'dsh-workers@dsh-workers': true },
      permissions: { allow: ['mcp__plugin_other_x__y', 'mcp__plugin_dsh-workers_dsh-workers__dsh_run_worker', 'Edit'] },
      statusLine: { type: 'command', command: 'node C:/tools/mine.js' },
      model: 'opus',
    }, null, 2) + '\n');
    writeFileSync(marketsFile, JSON.stringify({
      'other-market': { source: { source: 'directory', path: 'C:/other' } },
      'dsh-crew': { source: { source: 'directory', path: 'C:/crew' } },
    }, null, 2) + '\n');
    writeFileSync(installedFile, JSON.stringify({
      version: 2,
      plugins: {
        'other@other-market': [{ scope: 'user', installPath: 'C:/other/plugin' }],
        'dsh-crew@dsh-crew': [{ scope: 'user', installPath: 'C:/crew/plugin' }],
      },
    }, null, 2) + '\n');

    await installClaudeCode({ home, resolveClaude: claudePresent });
    const r = uninstallClaudeCode({ home });
    assert.equal(r.ok, true);

    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(Object.keys(settings.extraKnownMarketplaces), ['other-market']);
    assert.deepEqual(Object.keys(settings.enabledPlugins), ['other@other-market']);
    assert.deepEqual(settings.permissions.allow, ['mcp__plugin_other_x__y', 'Edit']);
    assert.deepEqual(settings.statusLine, { type: 'command', command: 'node C:/tools/mine.js' }, 'a status line Crew did not install is not Crews to remove');
    assert.equal(settings.model, 'opus', 'unrelated keys survive');

    const markets = JSON.parse(readFileSync(marketsFile, 'utf8'));
    assert.deepEqual(markets, { 'other-market': { source: { source: 'directory', path: 'C:/other' } } });
    const installed = JSON.parse(readFileSync(installedFile, 'utf8'));
    assert.deepEqual(installed, {
      version: 2,
      plugins: { 'other@other-market': [{ scope: 'user', installPath: 'C:/other/plugin' }] },
    });
    assert.ok(r.actions.some((a) => a.startsWith('marketplace cache: removed')));
    assert.ok(r.actions.some((a) => a.startsWith('plugin cache: removed')));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('uninstall removes only dsh-crew rules, keeps other allow entries', async () => {
  const home = makeHome();
  try {
    await installClaudeCode({ home, resolveClaude: claudePresent });
    const settingsFile = join(home, '.claude', 'settings.json');
    const s = readSettings(home);
    s.permissions.allow.push('mcp__other__tool', 'Edit', 'Bash(foo)');
    writeFileSync(settingsFile, JSON.stringify(s, null, 2));
    await uninstallClaudeCode({ home });
    const after = readSettings(home).permissions.allow ?? [];
    assert.equal(after.filter((r) => String(r).startsWith(CREW_PREFIX)).length, 0);
    assert.ok(after.includes('mcp__other__tool'));
    assert.ok(after.includes('Edit'));
    assert.ok(after.includes('Bash(foo)'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// Ownership is a path Crew wrote, not a phrase it mentions: the words `dsh-crew` and
// `statusline.sh` in a command someone else wrote are not a reason to delete it.
test('a status line is Crew\'s only when it is the one Crew installed', async () => {
  const userHome = makeHome();
  const crewHome = makeHome();
  try {
    // A user status line that happens to name both words survives.
    const userSettings = join(userHome, '.claude', 'settings.json');
    mkdirSync(join(userHome, '.claude'), { recursive: true });
    const userCommand = 'node C:/tools/my-dsh-crew-notes/statusline/statusline.sh';
    writeFileSync(userSettings, JSON.stringify({
      statusLine: { type: 'command', command: userCommand }, enabledPlugins: {}, extraKnownMarketplaces: {},
    }, null, 2) + '\n');
    uninstallClaudeCode({ home: userHome });
    assert.equal(JSON.parse(readFileSync(userSettings, 'utf8')).statusLine.command, userCommand, 'a user status line is not Crew\'s to remove');

    // The exact command `--statusline` writes, in Crew's own directory, is removed.
    const root = join(crewHome, 'payload', 'dsh-crew');
    mkdirSync(join(root, 'statusline'), { recursive: true });
    writeFileSync(join(root, 'statusline', 'statusline.sh'), '#!/bin/sh\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1' }));
    const installed = await installClaudeCode({ home: crewHome, root, statusline: true, resolveClaude: claudePresent });
    assert.equal(installed.ok, true);
    const crewSettings = join(crewHome, '.claude', 'settings.json');
    assert.equal(JSON.parse(readFileSync(crewSettings, 'utf8')).statusLine.command, `bash ${join(root, 'statusline', 'statusline.sh')}`);
    uninstallClaudeCode({ home: crewHome });
    assert.equal(JSON.parse(readFileSync(crewSettings, 'utf8')).statusLine, undefined, 'and it is Crew\'s to remove');
  } finally {
    rmSync(userHome, { recursive: true, force: true });
    rmSync(crewHome, { recursive: true, force: true });
  }
});

// The legacy array shape lists marketplaces as `{ path }` records. Crew wrote its own
// under `dsh-crew` (and, before the rename, `dsh-workers`); everything else in that
// array belongs to another plugin.
test('the legacy array-shaped marketplace list drops only Crew\'s own entries', async () => {
  const home = makeHome();
  try {
    const settingsFile = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({
      extraKnownMarketplaces: [
        { path: 'C:/Users/x/.config/dsh-crew/app/releases/20260929T140611Z-36312-1-2.2.7' },
        { path: 'C:/Users/x/.config/dsh-workers/marketplace' },
        { path: 'C:/tools/other-market' },
      ],
      enabledPlugins: [],
      permissions: { allow: [] },
    }, null, 2) + '\n');
    const r = uninstallClaudeCode({ home });
    assert.equal(r.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')).extraKnownMarketplaces, [{ path: 'C:/tools/other-market' }]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('uninstall is idempotent and does not throw on missing settings', async () => {
  const home = makeHome();
  try {
    const r = await uninstallClaudeCode({ home });
    assert.equal(r.ok, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
