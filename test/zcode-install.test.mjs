import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  ZCODE_MCP_TOOLS,
  installZCode,
  uninstallZCode,
  zcodeStatus,
  resolveZCodeMcpTarget,
} from '../src/install/zcode.mjs';
import { installStatus } from '../src/install/install.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const makeHome = () => mkdtempSync(join(tmpdir(), 'dsh-crew-zcode-test-'));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('ZCode install writes managed policy, exact-tool agents, commands and native MCP config', () => {
  const home = makeHome();
  try {
    const result = installZCode({ home, root: ROOT });
    assert.equal(result.ok, true);
    assert.ok(existsSync(join(home, '.zcode', 'AGENTS.md')));
    assert.ok(existsSync(join(home, '.zcode', 'agents', 'ds-worker.md')));
    assert.ok(existsSync(join(home, '.zcode', 'agents', 'ds-reviewer.md')));
    assert.ok(existsSync(join(home, '.zcode', 'commands', 'dsh-config.md')));
    assert.ok(existsSync(join(home, '.zcode', 'commands', 'dsh-status.md')));
    const worker = readFileSync(join(home, '.zcode', 'agents', 'ds-worker.md'), 'utf8');
    const reviewer = readFileSync(join(home, '.zcode', 'agents', 'ds-reviewer.md'), 'utf8');
    const policy = readFileSync(join(home, '.zcode', 'AGENTS.md'), 'utf8');
    assert.match(worker, /mcpServers:\s*\n\s*- dsh-crew/);
    for (const tool of ZCODE_MCP_TOOLS) assert.match(worker, new RegExp(`mcp__dsh-crew__${tool}`));
    for (const dispatcher of [worker, reviewer]) {
      assert.match(dispatcher, /dsh_spawn_worker/);
      assert.match(dispatcher, /dsh_worker_result/);
      assert.match(dispatcher, /wait_seconds[^\n]*1[05]/);
      assert.match(dispatcher, /workflow ID[^\n]*(?:host|structured|result)/i);
      assert.match(dispatcher, /do not forward[^\n]*(?:workflow ID|provider|model)/i);
      assert.doesNotMatch(dispatcher, /pass the .* (?:task|request).*verbatim/i);
    }
    assert.match(worker, /allow_no_changes:\s*true/);
    assert.match(policy, /asynchronous.*dsh_spawn_worker/i);
    assert.match(policy, /never start a duplicate/i);
    const cfg = readJson(join(home, '.zcode', 'cli', 'config.json'));
    assert.equal(cfg.mcp.servers['dsh-crew'].command, 'node');
    assert.equal(cfg.mcp.servers['dsh-crew'].args[0].toLowerCase(), join(ROOT, 'src', 'server.mjs').toLowerCase());
    assert.equal(resolveZCodeMcpTarget({ home }).toLowerCase(), join(ROOT, 'src', 'server.mjs').toLowerCase());
    const ownership = readJson(join(home, '.config', 'dsh-crew', 'integrations', 'zcode.json'));
    assert.equal(ownership.host, 'zcode');
    assert.equal(ownership.config_file, join(home, '.zcode', 'cli', 'config.json'));
    assert.ok(!JSON.stringify(ownership).match(/token|key|secret/i));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('ZCode installer prefers native config when it has servers and falls back to shared .agents MCP', () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, '.zcode', 'cli'), { recursive: true });
    mkdirSync(join(home, '.agents'), { recursive: true });
    writeFileSync(join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({ mcp: { servers: { native: { command: 'node', args: ['native.mjs'] } } } }));
    writeFileSync(join(home, '.agents', 'mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'node', args: ['shared.mjs'] } } }));
    const result = installZCode({ home, root: ROOT });
    assert.equal(result.ok, true);
    assert.equal(result.config_file, join(home, '.zcode', 'cli', 'config.json'));
    assert.ok(readJson(join(home, '.zcode', 'cli', 'config.json')).mcp.servers['dsh-crew']);
    assert.equal(readJson(join(home, '.agents', 'mcp.json')).mcpServers['dsh-crew'], undefined);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('ZCode installer uses .agents fallback when native config is absent/empty', () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, '.zcode', 'cli'), { recursive: true });
    mkdirSync(join(home, '.agents'), { recursive: true });
    writeFileSync(join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({ mcp: { servers: {} } }));
    writeFileSync(join(home, '.agents', 'mcp.json'), JSON.stringify({ mcpServers: { shared: { command: 'node', args: ['shared.mjs'] } } }));
    const result = installZCode({ home, root: ROOT });
    assert.equal(result.ok, true);
    assert.equal(result.config_file, join(home, '.agents', 'mcp.json'));
    assert.ok(readJson(join(home, '.agents', 'mcp.json')).mcpServers['dsh-crew']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('ZCode shared-to-native update removes stale shared Crew MCP and uninstall cleans both sources', () => {
  const home = makeHome();
  try {
    const nativeFile = join(home, '.zcode', 'cli', 'config.json');
    const sharedFile = join(home, '.agents', 'mcp.json');
    mkdirSync(join(home, '.zcode', 'cli'), { recursive: true });
    mkdirSync(join(home, '.agents'), { recursive: true });
    writeFileSync(nativeFile, JSON.stringify({ mcp: { servers: {} } }));
    writeFileSync(sharedFile, JSON.stringify({ mcpServers: { shared: { command: 'node', args: ['shared.mjs'] } } }));

    assert.equal(installZCode({ home, root: ROOT }).ok, true);
    assert.ok(readJson(sharedFile).mcpServers['dsh-crew']);

    // User adds a native MCP server, so ZCode now prefers native config.
    writeFileSync(nativeFile, JSON.stringify({
      mcp: { servers: { native: { command: 'node', args: ['native.mjs'] } } },
    }));
    assert.equal(installZCode({ home, root: ROOT }).ok, true);

    let native = readJson(nativeFile);
    let shared = readJson(sharedFile);
    assert.ok(native.mcp.servers['dsh-crew'], 'native source should get the Crew MCP entry');
    assert.equal(shared.mcpServers['dsh-crew'], undefined, 'prior shared Crew entry must not remain');
    assert.ok(shared.mcpServers['shared'], 'unrelated shared server must be preserved');
    assert.ok(native.mcp.servers['native'], 'unrelated native server must be preserved');

    assert.equal(uninstallZCode({ home }).ok, true);
    native = readJson(nativeFile);
    shared = readJson(sharedFile);
    assert.equal(native.mcp.servers['dsh-crew'], undefined);
    assert.ok(native.mcp.servers['native']);
    assert.equal(shared.mcpServers['dsh-crew'], undefined);
    assert.ok(shared.mcpServers['shared']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('ZCode native-to-shared update tracks prior native source so uninstall removes stale native Crew MCP', () => {
  const home = makeHome();
  try {
    const nativeFile = join(home, '.zcode', 'cli', 'config.json');
    const sharedFile = join(home, '.agents', 'mcp.json');
    mkdirSync(join(home, '.zcode', 'cli'), { recursive: true });
    mkdirSync(join(home, '.agents'), { recursive: true });
    writeFileSync(nativeFile, JSON.stringify({
      mcp: { servers: { native: { command: 'node', args: ['native.mjs'] } } },
    }));
    writeFileSync(sharedFile, JSON.stringify({ mcpServers: { shared: { command: 'node', args: ['shared.mjs'] } } }));

    assert.equal(installZCode({ home, root: ROOT }).ok, true);
    assert.ok(readJson(nativeFile).mcp.servers['dsh-crew']);

    // Switch to shared by clearing the active native list; keep the prior
    // native source tracked so a stale Crew entry can still be uninstalled.
    writeFileSync(nativeFile, JSON.stringify({ mcp: { servers: {} } }));
    const updated = installZCode({ home, root: ROOT });
    assert.equal(updated.ok, true);
    assert.equal(updated.config_kind, 'shared');
    assert.equal(readJson(sharedFile).mcpServers['dsh-crew'] ? true : false, true);

    // Simulate a stale native Crew entry left behind by the transition.
    writeFileSync(nativeFile, JSON.stringify({
      mcp: { servers: {
        native: { command: 'node', args: ['native.mjs'] },
        'dsh-crew': { command: 'node', args: [join(ROOT, 'src', 'server.mjs')] },
      } },
    }));
    assert.equal(uninstallZCode({ home }).ok, true);

    const native = readJson(nativeFile);
    const shared = readJson(sharedFile);
    assert.equal(native.mcp.servers['dsh-crew'], undefined, 'stale native Crew entry must be removed by uninstall');
    assert.ok(native.mcp.servers['native'], 'unrelated native server must be preserved');
    assert.equal(shared.mcpServers['dsh-crew'], undefined);
    assert.ok(shared.mcpServers['shared'], 'unrelated shared server must be preserved');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('ZCode install fails closed on an unowned MCP collision and preserves files', () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, '.zcode', 'cli'), { recursive: true });
    const file = join(home, '.zcode', 'cli', 'config.json');
    const before = { mcp: { servers: { 'dsh-crew': { command: 'other', args: ['other.mjs'] } } } };
    writeFileSync(file, JSON.stringify(before));
    const result = installZCode({ home, root: ROOT });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ZCODE_MCP_COLLISION');
    assert.deepEqual(readJson(file), before);
    assert.equal(existsSync(join(home, '.zcode', 'AGENTS.md')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('ZCode uninstall removes only owned artifacts and keeps user content', () => {
  const home = makeHome();
  try {
    installZCode({ home, root: ROOT });
    writeFileSync(join(home, '.zcode', 'AGENTS.md'), `${readFileSync(join(home, '.zcode', 'AGENTS.md'), 'utf8')}\n# user rule\n`);
    mkdirSync(join(home, '.zcode', 'agents'), { recursive: true });
    writeFileSync(join(home, '.zcode', 'agents', 'my-agent.md'), 'user agent\n');
    mkdirSync(join(home, '.zcode', 'cli'), { recursive: true });
    const result = uninstallZCode({ home, root: ROOT });
    assert.equal(result.ok, true);
    assert.match(readFileSync(join(home, '.zcode', 'AGENTS.md'), 'utf8'), /# user rule/);
    assert.ok(existsSync(join(home, '.zcode', 'agents', 'my-agent.md')));
    assert.equal(existsSync(join(home, '.zcode', 'agents', 'ds-worker.md')), false);
    assert.equal(existsSync(join(home, '.zcode', 'commands', 'dsh-status.md')), false);
    assert.equal(resolveZCodeMcpTarget({ home }), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('ZCode uninstall restores a pre-existing same-name agent instead of deleting it', () => {
  const home = makeHome();
  try {
    const file = join(home, '.zcode', 'agents', 'ds-worker.md');
    mkdirSync(join(home, '.zcode', 'agents'), { recursive: true });
    writeFileSync(file, '# personal worker\n');
    assert.equal(installZCode({ home, root: ROOT }).ok, true);
    assert.notEqual(readFileSync(file, 'utf8'), '# personal worker\n');
    assert.equal(uninstallZCode({ home }).ok, true);
    assert.equal(readFileSync(file, 'utf8'), '# personal worker\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('installStatus exposes ZCode independently of Codex and Claude', () => {
  const home = makeHome();
  try {
    installZCode({ home, root: ROOT });
    const status = installStatus({ home });
    assert.equal(status.zcode.installed, true);
    assert.equal(status.zcode.ready, true);
    assert.deepEqual(status.zcode.missing, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
