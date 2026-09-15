// Codex installer regression tests — Codex Desktop support without the CLI.
// The installer only writes shared config (~/.codex/...), never spawns codex,
// so a missing CLI must not block install. Also covers: preserving unrelated
// MCP servers / agents, idempotency, precise uninstall, and valid TOML on
// Windows (forward-slash paths, no backslash escapes).
// Run with: node --test test/codex-install.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CODEX_LEGACY_POLICY_HASHES, MCP_TOOLS, claudeCliInvocation, claudeIntegrationLine, claudeSnapshotSettleMs, codexHomeDir, codexLegacyPolicyDigest, installClaudeCode, installCodex, installStatus, managedClaudeFileManifest, pickClaudeCommand, runClaudeStep, stripKnownLegacyCodexPolicy, uninstallCodex, writeGlobalCodexMcpServer } from '../src/install/install.mjs';

// Paths must arrive as arguments. `JSON.stringify` quotes for JSON, not for a
// command processor, so a path containing `%NAME%` was expanded by the shell
// before the CLI ever saw it — the install reported success and acted on a
// different directory.
test('the Claude CLI is invoked with an argument array, and refuses a path the shell would rewrite', () => {
  assert.deepEqual(
    claudeCliInvocation(['plugin', 'install', 'dsh-crew@dsh-crew', '--scope', 'user'], { platform: 'linux' }),
    { command: 'claude', args: ['plugin', 'install', 'dsh-crew@dsh-crew', '--scope', 'user'] },
    'a POSIX host runs the executable directly, with no shell in between',
  );

  const windows = claudeCliInvocation(['plugin', 'marketplace', 'add', 'C:\\plain\\payload'], {
    platform: 'win32', environment: { ComSpec: 'cmd.exe' },
  });
  assert.equal(windows.command, 'cmd.exe');
  assert.equal(windows.windowsVerbatimArguments, true);
  assert.ok(windows.args.at(-1).includes('"C:\\plain\\payload"'), 'the path travels as a quoted argument');

  assert.throws(
    () => claudeCliInvocation(['plugin', 'marketplace', 'add', 'C:\\%CREW_REVIEW_PATH%\\payload'], { platform: 'win32' }),
    /unsafe claude CLI argument/,
    'a path the processor would rewrite is refused rather than escaped',
  );
});

// Present but unparseable is not "no settings yet". Rebuilding it as an empty
// configuration is how an operator's settings disappear, leaving them a backup to
// restore by hand.
test('a corrupt settings file is reported and left alone, not rebuilt empty', async () => {
  const home = makeHome();
  try {
    const root = join(home, 'payload');
    makeClaudePluginRoot(root, 'same');
    const settingsFile = join(home, '.claude', 'settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsFile, '{ "enabledPlugins": ');
    const before = readFileSync(settingsFile, 'utf8');
    const r = await installClaudeCode({ home, root });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CLAUDE_SETTINGS_UNREADABLE');
    assert.equal(readFileSync(settingsFile, 'utf8'), before, 'the operator\'s file is untouched');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// The compared files can all be present while the server Claude Code launches
// cannot start: it imports its runtime dependencies by bare specifier, so a copy
// interrupted between `src/` and `node_modules/` used to read as ready.
test('a snapshot whose entry cannot import its dependencies is not ready', async () => {
  const home = makeHome();
  try {
    const root = join(home, 'payload');
    const snapshot = join(home, 'snapshot');
    makeClaudePluginRoot(root, 'same');
    makeClaudePluginRoot(snapshot, 'same');
    // What has to be present is what the launched entry imports, so the entry has
    // to import something before this check has anything to prove. The package's
    // own dependency list is not a substitute: it names twenty-eight of them,
    // including meta-packages the server never imports from here, and requiring all
    // of those to resolve read this working machine as broken.
    for (const base of [root, snapshot]) writeFileSync(join(base, 'src', 'server.mjs'), "import 'zod';\nexport {};\n");
    const plugins = join(home, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, 'known_marketplaces.json'), JSON.stringify({ 'dsh-crew': {
      source: { source: 'directory', path: root }, installLocation: root,
    } }));
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: {
      'dsh-crew@dsh-crew': [{ scope: 'user', installPath: snapshot }],
    } }));
    const snapshotReady = () => installStatus({ home, root, env: {} }).claude.components.snapshot;

    assert.equal(snapshotReady(), false, 'the files match but the import resolves nowhere');

    mkdirSync(join(snapshot, 'node_modules', 'zod'), { recursive: true });
    writeFileSync(join(snapshot, 'node_modules', 'zod', 'package.json'), JSON.stringify({ name: 'zod', version: '3.24.0', main: 'index.js' }));
    writeFileSync(join(snapshot, 'node_modules', 'zod', 'index.js'), 'module.exports = {};\n');
    assert.equal(snapshotReady(), true, 'and it is ready once the import resolves from the snapshot itself');

    // A manifest without the module it names is the shape a copy interrupted
    // partway through a package leaves: resolving the manifest is not loading it.
    // `index.js` goes too — CommonJS falls back to it when `main` does not exist,
    // so leaving it in place would resolve after all.
    writeFileSync(join(snapshot, 'node_modules', 'zod', 'package.json'), JSON.stringify({ name: 'zod', version: '3.24.0', main: 'missing.js' }));
    rmSync(join(snapshot, 'node_modules', 'zod', 'index.js'), { force: true });
    assert.equal(snapshotReady(), false, 'a manifest whose entry is absent is not importable');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// The walk is bounded before it reads, and by more than bytes. Note the size bound
// is a resource property, not an observable one: reading first and rejecting after
// returns the same `null`, it just loads the file to find out.
// The bounds have to be exercised with a root the walk will actually enter. The
// earlier version of this test built trees with no `.claude-plugin/plugin.json`,
// so the manifest returned null at its first `add` and never reached the walk —
// it asserted the right answer for the wrong reason. The bounds are passed
// explicitly here so the fixtures stay small enough to be honest about.
test('the snapshot walk is bounded by depth, entry count and directory count', () => {
  const home = makeHome();
  try {
    const okRoot = join(home, 'ok');
    makeClaudePluginRoot(okRoot, 'same');
    const baseline = managedClaudeFileManifest(okRoot);
    assert.ok(Array.isArray(baseline) && baseline.length > 0, 'a normal tree produces a manifest at all');

    const deepRoot = join(home, 'deep');
    makeClaudePluginRoot(deepRoot, 'same');
    let nested = join(deepRoot, 'src');
    for (let i = 0; i < 5; i += 1) { nested = join(nested, `d${i}`); mkdirSync(nested); }
    writeFileSync(join(nested, 'leaf.mjs'), 'export {};\n');
    assert.equal(managedClaudeFileManifest(deepRoot, { maxDepth: 2 }), null, 'deeper than the bound is rejected');

    const wideRoot = join(home, 'wide');
    makeClaudePluginRoot(wideRoot, 'same');
    const wide = join(wideRoot, 'src');
    for (let i = 0; i < 8; i += 1) mkdirSync(join(wide, `d${i}`));
    assert.equal(managedClaudeFileManifest(wideRoot, { maxDirectories: 3 }), null, 'more directories than the bound is rejected');
    assert.ok(Array.isArray(managedClaudeFileManifest(wideRoot, { maxDirectories: 32 })), 'and the same tree is fine under a wider bound');

    const manyRoot = join(home, 'many');
    makeClaudePluginRoot(manyRoot, 'same');
    for (let i = 0; i < 20; i += 1) writeFileSync(join(manyRoot, 'src', `f${i}.mjs`), 'export {};\n');
    assert.equal(managedClaudeFileManifest(manyRoot, { maxEntries: 10 }), null, 'more entries than the bound is rejected');
    assert.ok(Array.isArray(managedClaudeFileManifest(manyRoot, { maxEntries: 512 })), 'and the same tree is fine under a wider bound');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// `where claude` reports the extensionless shim, the `.cmd`, and the native binary
// on the same machine. Detection and execution are different questions: execution
// hardcoded `.cmd`, so a host shipping only `claude.exe` was detected and then
// could not be run.
test('the Claude CLI is chosen from what the machine actually has', () => {
  assert.equal(pickClaudeCommand(['C:\\npm\\claude', 'C:\\npm\\claude.cmd'], { platform: 'win32' }), 'C:\\npm\\claude.cmd');
  assert.equal(pickClaudeCommand(['C:\\npm\\claude.cmd', 'C:\\native\\claude.exe'], { platform: 'win32' }), 'C:\\native\\claude.exe');
  assert.equal(pickClaudeCommand(['C:\\native\\claude.exe'], { platform: 'win32' }), 'C:\\native\\claude.exe');
  assert.equal(pickClaudeCommand([], { platform: 'win32' }), null);
  assert.equal(pickClaudeCommand(['/usr/local/bin/claude'], { platform: 'linux' }), '/usr/local/bin/claude');

  assert.deepEqual(
    claudeCliInvocation(['plugin', 'install'], { platform: 'win32', executable: 'C:\\native\\claude.exe' }),
    { command: 'C:\\native\\claude.exe', args: ['plugin', 'install'] },
    'a native executable starts directly, with no command processor to quote for',
  );
});

// A step whose output nobody reads blocks on its own pipe once the buffer fills —
// 64 KiB is enough — and is then killed at the ceiling for being talkative rather
// than for being stuck. 2 MiB stands in for any step that prints a lot.
test('a step that prints more than a pipe buffer is drained, not deadlocked', async () => {
  const result = await runClaudeStep(['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'], {
    executable: process.execPath, timeoutMs: 30_000,
  });
  assert.equal(result.timedOut, false, 'the step finished on its own');
  assert.equal(result.ok, true, String(result.detail).slice(0, 200));
});

// The step has to end even when the child will not: a termination that never lands
// must resolve and say so, not wait forever for a close that is not coming.
test('a step that will not finish ends, and reports whether its tree is gone', async () => {
  const result = await runClaudeStep(['-e', 'setTimeout(() => {}, 60_000)'], {
    executable: process.execPath, timeoutMs: 1_500,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.terminated, true, 'the kill lands and the close confirms it');
  assert.equal(result.error?.code, 'ETIMEDOUT');
});

// The case the step was pending on: a termination that reports failure. Nothing
// will close the child, so the step has to give up on it and say the tree is
// unconfirmed rather than wait for a close that is not coming. The child exits on
// its own shortly after; `terminate` and the grace are injected so this does not
// depend on coaxing a real unkillable process out of the machine.
test('a termination that does not land still ends the step, unconfirmed', async () => {
  const failed = await runClaudeStep(['-e', 'setTimeout(() => {}, 3_000)'], {
    executable: process.execPath, timeoutMs: 300, killGraceMs: 300, terminate: async () => false,
  });
  assert.equal(failed.timedOut, true);
  assert.equal(failed.terminated, false, 'a kill that reports failure leaves the tree unconfirmed');
  assert.equal(failed.ok, false);

  // And a kill that reports success still has to be confirmed by the close: the
  // claim is not the evidence.
  const claimed = await runClaudeStep(['-e', 'setTimeout(() => {}, 3_000)'], {
    executable: process.execPath, timeoutMs: 300, killGraceMs: 300, terminate: async () => true,
  });
  assert.equal(claimed.timedOut, true);
  assert.equal(claimed.terminated, false, 'a successful kill is only confirmed once the child closes');
});

// A fast path that skipped the dependency check answered "already current" for a
// snapshot the status surface reads as not ready - the same snapshot, two
// different answers from the same machine.
test('the already-current fast path requires the snapshot to resolve too', async () => {
  const home = makeHome();
  try {
    const root = join(home, 'payload');
    const snapshot = join(home, 'snapshot');
    makeClaudePluginRoot(root, 'same');
    makeClaudePluginRoot(snapshot, 'same');
    // Same snapshot, two entry points: the fast path answered "already current"
    // while the status surface read the same tree as not ready, because only one
    // of them asked whether the entry's imports resolve.
    for (const base of [root, snapshot]) writeFileSync(join(base, 'src', 'server.mjs'), "import 'zod';\nexport {};\n");
    const plugins = join(home, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, 'known_marketplaces.json'), JSON.stringify({ 'dsh-crew': {
      source: { source: 'directory', path: root }, installLocation: root,
    } }));
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: {
      'dsh-crew@dsh-crew': [{ scope: 'user', installPath: snapshot }],
    } }));
    const r = await installClaudeCode({ home, root });
    assert.ok(!r.actions.includes('cli: skipped (registered marketplace and snapshot already current)'),
      'a snapshot the status surface reads as not ready is not "already current"');
    assert.equal(installStatus({ home, root, env: {} }).claude.components.snapshot, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// Only a timeout can leave a copy running past the shell's ceiling, so only a
// timeout is worth waiting out. The error shapes are Node's, measured rather than
// assumed: a timeout is `code: ETIMEDOUT, signal: SIGTERM, status: null`, while a
// `claude` that is not installed is `status: 1` and a CLI that failed on its own
// terms is its own non-zero status — neither with a code or a signal.
test('the plugin snapshot is only waited for after a timed-out CLI attempt', () => {
  const timedOut = Object.assign(new Error('spawnSync C:\\WINDOWS\\system32\\cmd.exe ETIMEDOUT'), {
    code: 'ETIMEDOUT', signal: 'SIGTERM', status: null,
  });
  assert.ok(claudeSnapshotSettleMs(timedOut) > 0, 'a timed-out install may still be writing the snapshot');

  // ENOBUFS (output over maxBuffer) reports SIGTERM too, and that child has
  // already stopped; matching the signal alone spent the whole window on nothing.
  const overflowed = Object.assign(new Error('spawnSync C:\\WINDOWS\\system32\\cmd.exe ENOBUFS'), {
    code: 'ENOBUFS', signal: 'SIGTERM',
  });
  assert.equal(claudeSnapshotSettleMs(overflowed), 0, 'a buffer overflow is not a copy that is still running');

  const notInstalled = Object.assign(new Error("Command failed: claude plugin install\n'claude' is not recognized"), { status: 1 });
  assert.equal(claudeSnapshotSettleMs(notInstalled), 0, 'a CLI that does not exist never started a copy to wait for');

  const failed = Object.assign(new Error('Command failed: claude plugin install'), { status: 2 });
  assert.equal(claudeSnapshotSettleMs(failed), 0, 'a non-zero exit left no writer behind');

  assert.equal(claudeSnapshotSettleMs(null), 0, 'an install that simply is not current has nothing to wait for');
});

// This installer writes user scope, so only a user-scope record means the
// integration is installed. A project-scope record that happens to match used to
// stand in for a missing user-scope snapshot, which made a failed install read as
// a current one and let the installer skip the CLI step it still needed.
test('a project-scope plugin record does not stand in for the user-scope install', async () => {
  const home = makeHome();
  try {
    const root = join(home, 'payload');
    const snapshot = join(home, 'snapshot');
    makeClaudePluginRoot(root, 'same');
    makeClaudePluginRoot(snapshot, 'same');
    const plugins = join(home, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, 'known_marketplaces.json'), JSON.stringify({ 'dsh-crew': {
      source: { source: 'directory', path: root }, installLocation: root,
    } }));
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: {
      'dsh-crew@dsh-crew': [{ scope: 'project', installPath: snapshot }],
    } }));
    const status = installStatus({ home, root, env: {} }).claude;
    assert.equal(status.components.snapshot, false, 'a project-scope record is not this installer\'s install');
    assert.equal(status.ready, false);
    const r = await installClaudeCode({ home, root });
    assert.ok(!r.actions.includes('cli: skipped (registered marketplace and snapshot already current)'),
      'the installer must not treat a project-scope record as an install it can skip');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// Both install entries branch on `ok === false` for this integration, and neither
// could ever see it: a settings path that could not be written threw out of both
// of them. The producer now exists, so the ✗ the entries render is reachable.
test('an unwritable settings path fails the integration instead of throwing', async () => {
  const home = makeHome();
  try {
    const root = join(home, 'payload');
    makeClaudePluginRoot(root, 'same');
    // `.claude` exists as a FILE, so the settings path under it cannot be created
    writeFileSync(join(home, '.claude'), 'not a directory\n');
    const r = await installClaudeCode({ home, root });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CLAUDE_SETTINGS_UNWRITABLE');
    assert.match(claudeIntegrationLine(r), /^✗ /, 'and the entries render it as the failure it is');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// The comparison has to cover what the plugin loads, not only what names it.
// `worker.cordis.yml` is required before any dispatch (`src/jobs.mjs` throws
// without it), so a snapshot missing it is not this release even when the manifest
// that named it is byte-identical — which is how a stale snapshot read as current.
test('the snapshot comparison covers files the plugin loads, not just its manifest', async () => {
  const home = makeHome();
  try {
    const root = join(home, 'payload');
    const snapshot = join(home, 'snapshot');
    makeClaudePluginRoot(root, 'same');
    makeClaudePluginRoot(snapshot, 'same');
    writeFileSync(join(root, 'worker.cordis.yml'), 'worker overlay\n');
    const plugins = join(home, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, 'known_marketplaces.json'), JSON.stringify({ 'dsh-crew': {
      source: { source: 'directory', path: root }, installLocation: root,
    } }));
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: {
      'dsh-crew@dsh-crew': [{ scope: 'user', installPath: snapshot }],
    } }));

    const missing = installStatus({ home, root, env: {} }).claude;
    assert.equal(missing.components.snapshot, false, 'the snapshot lacks a file the plugin requires');

    writeFileSync(join(snapshot, 'worker.cordis.yml'), 'worker overlay\n');
    const complete = installStatus({ home, root, env: {} }).claude;
    assert.equal(complete.components.snapshot, true, 'and it is current once it carries the same files');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-crew-codex-test-'));
}
function read(path) { return readFileSync(path, 'utf8'); }

function makeIntegrationRoot(home, name, marker = '') {
  const root = join(home, name);
  cpSync(join(ROOT, 'codex'), join(root, 'codex'), { recursive: true });
  // The skill template ships in the payload too, so the fixture must carry it
  // or an install from this root fails with CREW_SKILL_TEMPLATE_MISSING.
  cpSync(join(ROOT, 'skills'), join(root, 'skills'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'server.mjs'), `export const payload = ${JSON.stringify(name)};\n`);
  if (marker) {
    for (const relative of [
      ['codex', 'agents', 'ds-worker.toml'],
      ['codex', 'agents', 'ds-reviewer.toml'],
      ['codex', 'prompts', 'dsh-config.md'],
      ['codex', 'prompts', 'dsh-status.md'],
      ['skills', 'dsh-crew', 'SKILL.md'],
    ]) {
      const file = join(root, ...relative);
      writeFileSync(file, `${read(file).trimEnd()}\n${marker}\n`);
    }
  }
  return root;
}

function makeClaudePluginRoot(root, marker) {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    version: '1.0.0',
    marker,
    mcpServers: { 'dsh-crew': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/src/server.mjs'] } },
  }));
  writeFileSync(join(root, 'src', 'server.mjs'), `export const marker = ${JSON.stringify(marker)};\n`);
}

test('Claude reinstall skips CLI only for matching registered marketplace and snapshot', async () => {
  const home = makeHome();
  try {
    const root = join(home, 'payload');
    const snapshot = join(home, 'snapshot');
    makeClaudePluginRoot(root, 'same');
    makeClaudePluginRoot(snapshot, 'same');
    const plugins = join(home, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    const registry = join(plugins, 'known_marketplaces.json');
    const writeRegistry = (path) => writeFileSync(registry, JSON.stringify({ 'dsh-crew': {
      source: { source: 'directory', path }, installLocation: path,
    } }));
    writeRegistry(root);
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: {
      'dsh-crew@dsh-crew': [{ scope: 'user', installPath: snapshot }],
    } }));
    const ready = await installClaudeCode({ home, root });
    assert.ok(ready.actions.includes('cli: skipped (registered marketplace and snapshot already current)'));
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: {
      'dsh-crew@dsh-crew': [{ scope: 'project', installPath: snapshot }],
    } }));
    const projectOnly = await installClaudeCode({ home, root });
    assert.ok(projectOnly.actions.includes('cli: skipped (non-default home; test mode)'));
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: {
      'dsh-crew@dsh-crew': [{ scope: 'user', installPath: snapshot }],
    } }));
    writeRegistry(join(home, 'other'));
    const staleRegistry = await installClaudeCode({ home, root });
    assert.ok(staleRegistry.actions.includes('cli: skipped (non-default home; test mode)'));
    writeRegistry(root);
    writeFileSync(join(snapshot, 'src', 'server.mjs'), 'changed');
    const staleSnapshot = await installClaudeCode({ home, root });
    assert.ok(staleSnapshot.actions.includes('cli: skipped (non-default home; test mode)'));
    rmSync(registry);
    const missing = await installClaudeCode({ home, root });
    assert.ok(missing.actions.includes('cli: skipped (non-default home; test mode)'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// An earlier release wrote agents/worker.toml before the roles were renamed to
// ds-worker/ds-reviewer. Nothing removed it, so every Codex start logged
// "Ignoring malformed agent role definition" about a file of Crew's own that
// Codex cannot use. Repairing it must not touch a role the operator wrote.
test('install removes the abandoned pre-rename role stubs and nothing else', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-crew-codex-legacy-'));
  try {
    const agents = join(home, '.codex', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'worker.toml'), 'name = "worker"\n');
    writeFileSync(join(agents, 'reviewer.toml'), '# a comment\nname = "reviewer"\n');
    // The operator's own role of the same name: Codex requires
    // developer_instructions, so this is not Crew's stub and must survive.
    writeFileSync(join(agents, 'worker-keep.toml'), 'name = "keep"\ndeveloper_instructions = "mine"\n');
    writeFileSync(join(agents, 'worker.toml.bak'), 'name = "worker"\n');

    const result = installCodex({ home, env: {} });
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(agents, 'worker.toml')), false, 'the abandoned stub is gone');
    assert.equal(existsSync(join(agents, 'reviewer.toml')), false, 'its comment does not hide it');
    assert.equal(existsSync(join(agents, 'worker-keep.toml')), true, 'an operator role is untouched');
    assert.equal(existsSync(join(agents, 'worker.toml.bak')), true, 'unrelated files are untouched');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a user role named worker that Codex can actually load is never removed', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-crew-codex-user-'));
  try {
    const agents = join(home, '.codex', 'agents');
    mkdirSync(agents, { recursive: true });
    const mine = 'name = "worker"\ndeveloper_instructions = "my own worker role"\n';
    writeFileSync(join(agents, 'worker.toml'), mine);
    installCodex({ home, env: {} });
    assert.equal(readFileSync(join(agents, 'worker.toml'), 'utf8'), mine);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Case 1: install succeeds with ~/.codex available and no codex CLI (no spawn)', async () => {
  const home = makeHome();
  try {
    const r = installCodex({ home , env: {} });
    assert.equal(r.ok, true);
    assert.ok(existsSync(join(home, '.codex', 'agents', 'ds-flash.toml')));
    assert.ok(existsSync(join(home, '.codex', 'agents', 'ds-pro.toml')));
    assert.ok(existsSync(join(home, '.codex', 'prompts', 'dsh-config.md')));
    assert.ok(existsSync(join(home, '.codex', 'prompts', 'dsh-status.md')));
    // No delegating policy is written into the host instruction file any more.
    assert.equal(existsSync(join(home, '.codex', 'AGENTS.md')), false);
    assert.equal(existsSync(join(home, '.codex', 'skills', 'dsh-crew', 'SKILL.md')), true,
      'the guidance is installed as an on-demand skill instead');
    const status = installStatus({ home , env: {} });
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
      skill: true,
    });
    // installCodex never tries to execute the codex CLI (its body is pure file I/O).
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex readiness distinguishes a partial legacy install from a complete integration', () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, '.codex', 'agents'), { recursive: true });
    writeFileSync(join(home, '.codex', 'agents', 'ds-flash.toml'), '[agent]\n');
    const status = installStatus({ home , env: {} }).codex;
    assert.equal(status.installed, true);
    assert.equal(status.ready, false);
    assert.deepEqual(status.missing, ['worker_role', 'reviewer_role', 'config_prompt', 'status_prompt', 'mcp', 'target_alignment', 'skill']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex readiness fails closed when config.toml is unreadable', () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, '.codex', 'config.toml'), { recursive: true });
    const status = installStatus({ home , env: {} }).codex;
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
    assert.equal(installStatus({ home , env: {} }).codex.components.mcp, false);

    writeFileSync(join(configDir, 'config.toml'), '[mcp_servers]\ndsh-crew = { command = "node", args = ["D:/missing/server.mjs"] }\n');
    assert.equal(installStatus({ home , env: {} }).codex.components.mcp, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex readiness rejects a stale managed role target', () => {
  const home = makeHome();
  try {
    installCodex({ home , env: {} });
    writeFileSync(join(home, '.codex', 'agents', 'ds-worker.toml'), '[mcp_servers.dsh-crew]\ncommand = "node"\nargs = ["D:/missing/server.mjs"]\n');
    const status = installStatus({ home , env: {} }).codex;
    assert.equal(status.components.worker_role, false);
    assert.equal(status.ready, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex readiness requires Worker, Reviewer, and global MCP to use one server target', () => {
  const home = makeHome();
  try {
    installCodex({ home , env: {} });
    const alternate = join(home, 'older-release', 'src', 'server.mjs');
    mkdirSync(join(home, 'older-release', 'src'), { recursive: true });
    writeFileSync(alternate, 'export {};\n');
    writeFileSync(join(home, '.codex', 'config.toml'), `[mcp_servers]\ndsh-crew = { command = "node", args = ["${alternate.replace(/\\/g, '/')}"] }\n`);
    const status = installStatus({ home , env: {} }).codex;
    assert.equal(status.components.worker_role, true);
    assert.equal(status.components.reviewer_role, true);
    assert.equal(status.components.mcp, false);
    assert.equal(status.components.target_alignment, false);
    assert.equal(status.ready, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex readiness rejects targets, templates, and policy installed from an older payload root', () => {
  const home = makeHome();
  try {
    const oldRoot = makeIntegrationRoot(home, 'old-payload');
    const newRoot = makeIntegrationRoot(home, 'new-payload', '# payload revision: new');
    installCodex({ home, root: oldRoot , env: {} });

    const status = installStatus({ home, root: newRoot , env: {} }).codex;
    assert.equal(status.installed, true);
    assert.equal(status.ready, false);
    assert.equal(status.components.worker_role, false);
    assert.equal(status.components.reviewer_role, false);
    assert.equal(status.components.config_prompt, false);
    assert.equal(status.components.status_prompt, false);
    assert.equal(status.components.mcp, false);
    assert.equal(status.components.skill, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex readiness rejects modified but nonempty managed role and prompt files', () => {
  const home = makeHome();
  try {
    installCodex({ home, root: ROOT , env: {} });
    const worker = join(home, '.codex', 'agents', 'ds-worker.toml');
    const prompt = join(home, '.codex', 'prompts', 'dsh-config.md');
    writeFileSync(worker, `${read(worker).trimEnd()}\n# local drift\n`);
    writeFileSync(prompt, '# still nonempty, but no longer the managed prompt\n');

    const status = installStatus({ home, root: ROOT , env: {} }).codex;
    assert.equal(status.components.worker_role, false);
    assert.equal(status.components.config_prompt, false);
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
    const status = installStatus({ home , env: {} }).claude;
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
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
        version: '1.0.0',
        mcpServers: { 'dsh-crew': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/src/server.mjs'] } },
      }) + '\n');
      writeFileSync(join(root, 'src', 'server.mjs'), 'export {};\n');
    }
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'dsh-crew@dsh-crew': { scope: 'user', installPath: snapshot } },
    }));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'dsh-crew@dsh-crew': true },
      extraKnownMarketplaces: { 'dsh-crew': { source: { source: 'directory', path: marketplace } } },
      permissions: { allow: MCP_TOOLS.map((tool) => `mcp__plugin_dsh-crew_dsh-crew__${tool}`) },
    }));
    const status = installStatus({ home, root: marketplace , env: {} }).claude;
    assert.equal(status.installed, true);
    assert.equal(status.ready, true);
    assert.deepEqual(status.missing, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Claude readiness rejects a marketplace and cached snapshot from an older payload root', () => {
  const home = makeHome();
  try {
    const oldRoot = join(home, 'old-payload');
    const newRoot = join(home, 'new-payload');
    const oldSnapshot = join(home, '.claude', 'plugins', 'cache', 'dsh-crew', 'dsh-crew', 'old');
    makeClaudePluginRoot(oldRoot, 'old');
    makeClaudePluginRoot(newRoot, 'new');
    makeClaudePluginRoot(oldSnapshot, 'old');
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'dsh-crew@dsh-crew': { scope: 'user', installPath: oldSnapshot } },
    }));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'dsh-crew@dsh-crew': true },
      extraKnownMarketplaces: { 'dsh-crew': { source: { source: 'directory', path: oldRoot } } },
      permissions: { allow: MCP_TOOLS.map((tool) => `mcp__plugin_dsh-crew_dsh-crew__${tool}`) },
    }));

    const status = installStatus({ home, root: newRoot , env: {} }).claude;
    assert.equal(status.installed, true);
    assert.equal(status.components.marketplace, false);
    assert.equal(status.components.snapshot, false);
    assert.equal(status.ready, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Case 4: installed role files render the local server.mjs path', async () => {
  const home = makeHome();
  try {
    installCodex({ home , env: {} });
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
    installCodex({ home , env: {} });
    installCodex({ home , env: {} });
    const agents = readdirSync(join(home, '.codex', 'agents'));
    assert.equal(agents.filter((a) => a.startsWith('ds-') && a.endsWith('.toml')).length, 4);
    const prompts = readdirSync(join(home, '.codex', 'prompts'));
    assert.equal(prompts.filter((p) => p.startsWith('dsh-')).length, 2);
    // Repeating the install must not duplicate or rewrite the skill.
    assert.equal(existsSync(join(home, '.codex', 'skills', 'dsh-crew', 'SKILL.md')), true);
    assert.equal(existsSync(join(home, '.codex', 'AGENTS.md')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Case 3: existing user agents are preserved', async () => {
  const home = makeHome();
  try {
    const agentsDir = join(home, '.codex', 'agents');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'my-reviewer.toml'), 'name = "my-reviewer"\n');
    installCodex({ home , env: {} });
    assert.ok(existsSync(join(agentsDir, 'my-reviewer.toml')), 'user agent must survive');
    assert.ok(existsSync(join(agentsDir, 'ds-flash.toml')));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('installing the skill leaves user-authored AGENTS instructions untouched and removes an old policy block', () => {
  const home = makeHome();
  try {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'AGENTS.md'), '# My rules\n\nKeep this sentence.\n');
    installCodex({ home , env: {} });
    const installed = read(join(home, '.codex', 'AGENTS.md'));
    assert.match(installed, /# My rules/);
    assert.match(installed, /Keep this sentence/);
    assert.doesNotMatch(installed, /DSH CREW MANAGED POLICY/);

    uninstallCodex({ home , env: {} });
    const removed = read(join(home, '.codex', 'AGENTS.md'));
    assert.match(removed, /# My rules/);
    assert.match(removed, /Keep this sentence/);
    assert.doesNotMatch(removed, /DSH CREW MANAGED POLICY/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('known unmarked Codex policy is removed by exact hash while modified text is preserved', () => {
  const legacy = '# Legacy DSH policy\nExact historical content.\n';
  const block = '<!-- DSH CREW MANAGED POLICY:START -->\ncurrent\n<!-- DSH CREW MANAGED POLICY:END -->';
  const digest = codexLegacyPolicyDigest(legacy);
  const cleaned = stripKnownLegacyCodexPolicy(`${legacy}\n${block}\n`, { knownHashes: [digest] });
  assert.equal(cleaned.trim(), block);

  const modified = `${legacy.trimEnd()} modified\n`;
  const preserved = stripKnownLegacyCodexPolicy(`${modified}\n${block}\n`, { knownHashes: [digest] });
  assert.match(preserved, /modified/);
  assert.match(preserved, /DSH CREW MANAGED POLICY:START/);
  assert.ok(CODEX_LEGACY_POLICY_HASHES.includes('2d6f3839bb3df4bda90f481726281292b1a4b4585298b1cf9ec56215295b5c78'));
});

test('Case 2: existing other MCP servers in config.toml are preserved', async () => {
  const home = makeHome();
  try {
    const cfgDir = join(home, '.codex');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'config.toml'), 'model = "gpt-x"\n[mcp_servers]\nother = { command = "other", args = ["-m"] }\n[desktop]\nfoo = 1\n');
    installCodex({ home , env: {} });
    const s = read(join(cfgDir, 'config.toml'));
    assert.match(s, /other = \{ command = "other"/, 'other MCP server must survive');
    assert.match(s, /dsh-crew = \{ command = "node"/, 'dsh-crew MCP entry must be added');
    assert.match(s, /\[desktop\]/, 'unrelated sections must survive');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Case 7: Windows absolute path renders valid TOML (forward slashes, no backslash escapes)', async () => {
  const home = makeHome();
  try {
    installCodex({ home , env: {} });
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
    installCodex({ home , env: {} });
    const u = uninstallCodex({ home , env: {} });
    assert.equal(u.ok, true);
    assert.ok(!existsSync(join(cfgDir, 'agents', 'ds-flash.toml')));
    assert.ok(!existsSync(join(cfgDir, 'prompts', 'dsh-config.md')));
    assert.ok(!existsSync(join(cfgDir, 'AGENTS.md')), 'installer-owned empty policy file removed');
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
    writeGlobalCodexMcpServer(home, 'D:/proj/dsh-crew/src/server.mjs', {});
    writeGlobalCodexMcpServer(home, 'D:/proj/dsh-crew/src/server.mjs', {});
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
    writeGlobalCodexMcpServer(home, 'D:/proj/dsh-crew/src/server.mjs', {});
    const s = read(join(home, '.codex', 'config.toml'));
    assert.match(s, /\[mcp_servers\]\n\s*dsh-crew = \{ command = "node"/);
    assert.match(s, /model = "gpt-x"/, 'existing content preserved');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// Codex honours CODEX_HOME and falls back to ~/.codex. Writing only to the
// latter silently does nothing for a user who set it: the install reports
// success because the file it wrote really did change, while Codex keeps reading
// a registration frozen on whatever release was current when CODEX_HOME was set.
test('CODEX_HOME decides where the registration is written', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-crew-codex-home-'));
  const custom = mkdtempSync(join(tmpdir(), 'dsh-crew-codex-custom-'));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(custom, { recursive: true, force: true }); });

  // installCodex renders the target from root; match what it will actually write.
  const target = join(ROOT, 'src', 'server.mjs').split(sep).join('/');
  const env = { CODEX_HOME: custom };
  assert.equal(installCodex({ home, root: ROOT, env }).ok, true);

  const customConfig = readFileSync(join(custom, 'config.toml'), 'utf8');
  assert.match(customConfig, /dsh-crew = \{ command = "node"/, 'the override directory receives the registration');
  assert.ok(customConfig.includes(target), `the override directory registers the real payload path (${target})`);
  assert.equal(existsSync(join(home, '.codex', 'config.toml')), false, 'the default directory must not be written');
  assert.equal(existsSync(join(custom, 'agents', 'ds-worker.toml')), true, 'role files follow the override too');

  // Readiness must look in the same place, or a correct install reads as missing.
  assert.equal(installStatus({ home, root: ROOT, env }).codex.components.mcp, true);

  uninstallCodex({ home, env });
  assert.doesNotMatch(readFileSync(join(custom, 'config.toml'), 'utf8'), /dsh-crew = \{/, 'uninstall clears the override directory');
});

test('an unset or blank CODEX_HOME falls back to ~/.codex', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-crew-codex-fallback-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  for (const env of [{}, { CODEX_HOME: '' }, { CODEX_HOME: '   ' }]) {
    assert.equal(codexHomeDir(home, env), join(home, '.codex'), `env=${JSON.stringify(env)}`);
  }
  installCodex({ home, root: ROOT, env: {} });
  assert.equal(existsSync(join(home, '.codex', 'config.toml')), true);
  assert.equal(installStatus({ home, root: ROOT, env: {} }).codex.components.mcp, true);
});


test('snapshot readiness follows local imports, re-exports and cycles without executing them', () => {
  const home = makeHome();
  try {
    const root = join(home, 'payload');
    const snapshot = join(home, 'snapshot');
    for (const directory of [root, snapshot]) {
      makeClaudePluginRoot(directory, 'same');
      writeFileSync(join(directory, 'src', 'server.mjs'), "// import 'not-a-dependency';\nconst note = \"import 'also-not-a-dependency'\";\nimport './helper.mjs';\n");
      writeFileSync(join(directory, 'src', 'helper.mjs'), "export * from './nested.mjs';\n");
      writeFileSync(join(directory, 'src', 'nested.mjs'), "import './helper.mjs'; import 'crew-fixture-dependency'; throw new Error('must not execute');\n");
    }
    const plugins = join(home, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: {
      'dsh-crew@dsh-crew': [{ scope: 'user', installPath: snapshot }],
    } }));
    const ready = () => installStatus({ home, root, env: {} }).claude.components.snapshot;
    assert.equal(ready(), false, 'a missing indirect package fails readiness');
    const dependency = join(snapshot, 'node_modules', 'crew-fixture-dependency');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'crew-fixture-dependency', main: 'index.js' }));
    writeFileSync(join(dependency, 'index.js'), 'module.exports = {};');
    assert.equal(ready(), true, 'cycles terminate and installed indirect dependencies pass without executing code');
    for (const directory of [root, snapshot]) rmSync(join(directory, 'src', 'nested.mjs'));
    assert.equal(ready(), false, 'matching snapshots with a missing imported local file still fail');
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('snapshot readiness checks commented dynamic imports and CommonJS dependencies', () => {
  const home = makeHome();
  try {
    const root = join(home, 'payload');
    const snapshot = join(home, 'snapshot');
    for (const directory of [root, snapshot]) {
      makeClaudePluginRoot(directory, 'same');
      writeFileSync(join(directory, 'src', 'server.mjs'), "import(/* local */ './helper.cjs');\n");
      writeFileSync(join(directory, 'src', 'helper.cjs'), "require('fs'); require('node:path'); require(/* package */ 'crew-fixture-commonjs');\n");
    }
    const plugins = join(home, '.claude', 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: {
      'dsh-crew@dsh-crew': [{ scope: 'user', installPath: snapshot }],
    } }));
    const ready = () => installStatus({ home, root, env: {} }).claude.components.snapshot;
    assert.equal(ready(), false);
    const dependency = join(snapshot, 'node_modules', 'crew-fixture-commonjs');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'index.js'), 'module.exports = {};');
    assert.equal(ready(), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
