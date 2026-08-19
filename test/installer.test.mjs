// Installer regression tests: the Claude MCP permission allowlist must
// include dsh_worker_config, be idempotent across repeated installs, upgrade
// an old 5-tool list, and uninstall must only remove dsh-crew's own rules.
// Runs against a throwaway home dir — the real ~/.claude is never touched.
// Run with: node --test test/installer.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installClaudeCode, uninstallClaudeCode, MCP_TOOLS } from '../src/install/install.mjs';

const CREW_PREFIX = 'mcp__plugin_dsh-crew_dsh-crew__';
const rule = (t) => `${CREW_PREFIX}${t}`;

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
    await installClaudeCode({ home });
    const allow = readSettings(home).permissions.allow;
    for (const t of MCP_TOOLS) assert.ok(allow.includes(rule(t)), `missing rule for ${t}`);
    assert.equal(allow.filter((r) => typeof r === 'string' && r.startsWith(CREW_PREFIX)).length, 6);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('second install does not duplicate permission rules', async () => {
  const home = makeHome();
  try {
    await installClaudeCode({ home });
    await installClaudeCode({ home });
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
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({
      extraKnownMarketplaces: {}, enabledPlugins: {},
      permissions: { allow: [...old.map(rule), 'mcp__other__tool'] },
    }, null, 2));
    await installClaudeCode({ home });
    const allow = readSettings(home).permissions.allow;
    assert.ok(allow.includes(rule('dsh_worker_config')), 'dsh_worker_config missing after upgrade');
    assert.equal(allow.filter((r) => r === rule('dsh_worker_config')).length, 1);
    // the other plugin's rule is preserved
    assert.ok(allow.includes('mcp__other__tool'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('uninstall removes only dsh-crew rules, keeps other allow entries', async () => {
  const home = makeHome();
  try {
    await installClaudeCode({ home });
    const settingsFile = join(home, '.claude', 'settings.json');
    const s = readSettings(home);
    s.permissions.allow.push('mcp__other__tool', 'Edit', 'Bash(foo)');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(settingsFile, JSON.stringify(s, null, 2));
    await uninstallClaudeCode({ home });
    const after = readSettings(home).permissions.allow ?? [];
    assert.equal(after.filter((r) => String(r).startsWith(CREW_PREFIX)).length, 0);
    assert.ok(after.includes('mcp__other__tool'));
    assert.ok(after.includes('Edit'));
    assert.ok(after.includes('Bash(foo)'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('uninstall is idempotent and does not throw on missing settings', async () => {
  const home = makeHome();
  try {
    const r = await uninstallClaudeCode({ home });
    assert.equal(r.ok, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
