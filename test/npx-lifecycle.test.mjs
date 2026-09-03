// Packaged global-launcher lifecycle tests: durable Crew-owned payload persistence,
// bin dispatch semantics, read-only status, upgrade-aware/idempotent update,
// repair cases, and config-preserving uninstall. All filesystem effects stay
// inside disposable temp homes; Codex/Claude integrations are faked, while the
// Harness profile registration itself runs for real against the temp home.
// Run with: node --test test/npx-lifecycle.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { RUNTIME_VERSION } from '../src/runtime-identity.mjs';
import {
  CREW_APP_DIRNAME,
  crewAppRoot,
  crewReleasesDir,
  currentPointerFile,
  readCurrentPointer,
  runningPackageRoot,
  stageCandidatePayload,
  defaultPayloadSmoke,
  validateInstalledPayload,
  copyProductionDependencyTree,
  npxInstall,
  npxIntegrate,
  npxDetach,
  npxStatus,
  npxUpdate,
  npxUninstall,
  npxInspect,
  npxJobs,
  npxProviders,
  npxCredentials,
  npxReleases,
  npxRollback,
  runNpxCli,
  USAGE,
  compareVersions,
  resolveUpdateCandidate,
  npmCliInvocation,
} from '../src/install/npx-lifecycle.mjs';
import {
  OFFICIAL_BRIDGE_PACKAGE,
  officialWebIntegrationStateFile,
  officialWebIntegrationStatus,
} from '../src/install/official-web.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_NAME = '@ran-sh/dsh-crew';

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-npx-lifecycle-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function isNpmInvocation(command, args) {
  return command.endsWith('npm.cmd') || command === 'npm'
    || (/cmd\.exe$/i.test(command) && /(?:^|\s)npm\.cmd(?:\s|$)/i.test(String(args.at(-1))));
}

function npmPackDestination(args) {
  const index = args.indexOf('--pack-destination');
  if (index >= 0) return args[index + 1];
  return /"--pack-destination" "([^"]+)"/.exec(String(args.at(-1)))?.[1];
}

/** Build a realistic candidate "running instance" (packaged layout). */
function makeCandidate(home, { version = '0.3.3', name = PKG_NAME } = {}) {
  const root = join(home, 'candidate');
  mkdirSync(join(root, 'src', 'hub'), { recursive: true });
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'codex', 'agents'), { recursive: true });
  mkdirSync(join(root, 'codex', 'prompts'), { recursive: true });
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'commands'), { recursive: true });
  mkdirSync(join(root, 'statusline'), { recursive: true });
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'official-web-bridge', 'lib'), { recursive: true });

  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name,
    version,
    type: 'module',
    main: './src/hub/entry.mjs',
    bin: { 'dsh-crew': './bin/dsh-crew.mjs' },
    exports: { '.': './src/hub/entry.mjs' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: {} },
    dependencies: { '@ran-fake/sdk': '^1.0.0', 'fake-zod': '^3.0.0' },
    peerDependencies: { '@ran-fake/host-peer': '^9.0.0' },
    devDependencies: { 'build-tool': '^1.0.0' },
    files: ['bin', 'lib', 'src', 'codex', 'agents', 'commands', 'statusline', 'official-web-bridge',
      '.claude-plugin', '.mcp.json', 'cordis.patch.yml', 'worker.cordis.yml',
      'README.md', 'README.*.md', 'LICENSE'],
  }, null, 2));
  writeFileSync(join(root, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(root, 'worker.cordis.yml'), '[]\n');
  writeFileSync(join(root, '.mcp.json'), '{}\n');
  writeFileSync(join(root, 'src', 'server.mjs'), [
    "import '@ran-fake/sdk';",
    "import '@ran-fake/host-peer';",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  const request = JSON.parse(input.trim());",
    "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { serverInfo: { name: 'dsh-crew' } } }) + '\\n');",
    "});",
    '',
  ].join('\n'));
  writeFileSync(join(root, 'src', 'hub', 'entry.mjs'), 'export const name = \'crew\';\n');
  writeFileSync(join(root, 'lib', 'client.js'), '// client\n');
  writeFileSync(join(root, 'bin', 'dsh-crew.mjs'), "import '../lib/client.js';\n");
  writeFileSync(join(root, 'codex', 'agents', 'ds-worker.toml'), '[agent]\n');
  writeFileSync(join(root, 'codex', 'prompts', 'dsh-config.md'), '# config\n');
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), '{}\n');
  writeFileSync(join(root, 'official-web-bridge', 'entry.mjs'), 'export async function apply() {}\n');
  writeFileSync(join(root, 'official-web-bridge', 'cordis.patch.yml'), `- insert:\n    - id: bridge\n      name: '${OFFICIAL_BRIDGE_PACKAGE}'\n`);
  writeFileSync(join(root, 'official-web-bridge', 'lib', 'client.js'), '// bridge client\n');
  writeFileSync(join(root, 'official-web-bridge', 'package.json'), JSON.stringify({
    name: OFFICIAL_BRIDGE_PACKAGE,
    version,
    type: 'module',
    main: './entry.mjs',
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  }, null, 2));
  writeFileSync(join(root, 'README.md'), '# candidate\n');
  writeFileSync(join(root, 'LICENSE'), 'MIT\n');

  // Dependency tree: sdk -> zod (transitive) to prove closure copying, plus
  // the host-provided peer package vendored like the real cohort would be.
  const nm = join(root, 'node_modules');
  mkdirSync(join(nm, '@ran-fake', 'sdk'), { recursive: true });
  writeFileSync(join(nm, '@ran-fake', 'sdk', 'package.json'), JSON.stringify({
    name: '@ran-fake/sdk',
    version: '1.0.0',
    main: 'index.js',
    dependencies: { 'fake-zod': '^3.0.0' },
    peerDependencies: { '@ran-fake/protocol-peer': '^1.0.0' },
  }));
  writeFileSync(join(nm, '@ran-fake', 'sdk', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(nm, '@ran-fake', 'protocol-peer'), { recursive: true });
  writeFileSync(join(nm, '@ran-fake', 'protocol-peer', 'package.json'), JSON.stringify({
    name: '@ran-fake/protocol-peer', version: '1.0.0', main: 'index.js',
  }));
  writeFileSync(join(nm, '@ran-fake', 'protocol-peer', 'index.js'), 'module.exports = 4;\n');
  mkdirSync(join(nm, 'fake-zod'), { recursive: true });
  writeFileSync(join(nm, 'fake-zod', 'package.json'), JSON.stringify({ name: 'fake-zod', version: '3.0.0', main: 'index.js' }));
  writeFileSync(join(nm, 'fake-zod', 'index.js'), 'module.exports = 2;\n');
  mkdirSync(join(nm, '@ran-fake', 'host-peer'), { recursive: true });
  writeFileSync(join(nm, '@ran-fake', 'host-peer', 'package.json'), JSON.stringify({ name: '@ran-fake/host-peer', version: '9.0.0', main: 'index.js' }));
  writeFileSync(join(nm, '@ran-fake', 'host-peer', 'index.js'), 'module.exports = 3;\n');
  return root;
}

function recordingInstaller() {
  const calls = [];
  return {
    calls,
    installer: {
      installCodex: (o = {}) => { calls.push(['installCodex', o]); return { ok: true, actions: [] }; },
      uninstallCodex: (o = {}) => { calls.push(['uninstallCodex', o]); return { ok: true, actions: [] }; },
      installClaudeCode: async (o = {}) => { calls.push(['installClaudeCode', o]); return { ok: true, actions: [] }; },
      uninstallClaudeCode: async (o = {}) => { calls.push(['uninstallClaudeCode', o]); return { ok: true, actions: [] }; },
      installWindowsStartup: (o = {}) => { calls.push(['installWindowsStartup', o]); return { ok: true, supported: true, changed: true }; },
      uninstallWindowsStartup: (o = {}) => { calls.push(['uninstallWindowsStartup', o]); return { ok: true, supported: true, removed: true }; },
      windowsStartupStatus: () => ({ supported: true, installed: true, ready: true }),
      installStatus: () => ({ claude: { installed: false }, codex: { installed: false } }),
    },
  };
}

const okRuntime = () => async ({ home }) => ({ ok: true, version: '9.9.9-fake', home });
const releaseCount = (home) => readdirSync(crewReleasesDir({ home })).filter((n) => !n.startsWith('.staging')).length;

function makeOfficialWebProfile(home) {
  const root = join(home, '.dsh', 'profiles', 'web');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { '@deepseek-ai/dsh-web-app': '0.1.1', 'keep-me': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'keep-me'] } },
  }, null, 2));
  return root;
}

// ---------- package identity ----------

test('package exposes exactly one natural CLI executable backed by an existing script', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const bins = Object.entries(manifest.bin ?? {});
  assert.equal(bins.length, 1);
  const [name, script] = bins[0];
  assert.equal(name, 'dsh-crew');
  assert.equal(existsSync(join(REPO_ROOT, script)), true, `${script} must exist`);
  assert.ok((manifest.files ?? []).includes('bin'), 'files must ship bin/');
});

test('package, runtime identity, and changelog identify candidate 1.0.3', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.3');
  assert.equal(RUNTIME_VERSION, '1.0.3');
  const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, new RegExp(`^## ${manifest.version.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')} —`, 'm'));
});

test('packaged lifecycle invokes npm on Windows without shell mode', () => {
  assert.deepEqual(
    npmCliInvocation(
      ['pack', '@ran-sh/dsh-crew@latest', '--pack-destination', 'C:\\Users\\Test User\\Crew'],
      { platform: 'win32', environment: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } },
    ),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd "pack" "@ran-sh/dsh-crew@latest" "--pack-destination" "C:\\Users\\Test User\\Crew"'],
      windowsVerbatimArguments: true,
    },
  );
  assert.deepEqual(npmCliInvocation(['pack', '@ran-sh/dsh-crew@latest'], { platform: 'linux' }), {
    command: 'npm', args: ['pack', '@ran-sh/dsh-crew@latest'],
  });
  assert.throws(
    () => npmCliInvocation(['pack', 'safe&whoami'], { platform: 'win32', environment: { ComSpec: 'cmd.exe' } }),
    /unsafe npm argument/,
  );
});

test('packaged Windows npm invocation executes with a space-bearing prefix', { skip: process.platform !== 'win32' }, () => {
  const t = tempHome();
  try {
    const prefix = join(t.dir, 'prefix with spaces');
    const invocation = npmCliInvocation(['prefix', '--prefix', prefix], {
      platform: 'win32', environment: process.env,
    });
    const result = spawnSync(invocation.command, invocation.args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      windowsHide: true, timeout: 60_000,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(resolve(result.stdout.trim()), resolve(prefix));
  } finally { t.cleanup(); }
});

// ---------- dependency closure ----------

test('copyProductionDependencyTree replicates transitive dependencies and required peers', () => {
  const t = tempHome();
  try {
    const sourceRoot = makeCandidate(t.dir);
    const toRoot = join(t.dir, 'stage');
    mkdirSync(toRoot, { recursive: true });
    const { copied, missing } = copyProductionDependencyTree({
      fromRoot: sourceRoot, toRoot, names: ['@ran-fake/sdk', 'fake-zod'],
    });
    assert.deepEqual(missing, []);
    assert.deepEqual([...copied.keys()].sort(), ['@ran-fake/protocol-peer', '@ran-fake/sdk', 'fake-zod']);
    assert.equal(existsSync(join(toRoot, 'node_modules', '@ran-fake', 'sdk', 'index.js')), true);
    assert.equal(existsSync(join(toRoot, 'node_modules', '@ran-fake', 'protocol-peer', 'index.js')), true);
    assert.equal(existsSync(join(toRoot, 'node_modules', 'fake-zod', 'index.js')), true);
  } finally { t.cleanup(); }
});

test('copyProductionDependencyTree reports unresolved roots as missing', () => {
  const t = tempHome();
  try {
    const sourceRoot = makeCandidate(t.dir);
    const toRoot = join(t.dir, 'stage');
    mkdirSync(toRoot, { recursive: true });
    rmSync(join(sourceRoot, 'node_modules', 'fake-zod'), { recursive: true, force: true });
    const { missing } = copyProductionDependencyTree({ fromRoot: sourceRoot, toRoot, names: ['fake-zod'] });
    assert.deepEqual(missing, ['fake-zod']);
  } finally { t.cleanup(); }
});

// ---------- staging / validation ----------

test('staged payload strips peer/dev declarations, ships files, and validates from its own location', () => {
  const t = tempHome();
  try {
    const sourceRoot = makeCandidate(t.dir);
    const staged = stageCandidatePayload({ sourceRoot, home: t.dir });
    assert.equal(staged.ok, true, `staging failed: ${JSON.stringify(staged)}`);
    const stageManifest = JSON.parse(readFileSync(join(staged.stageDir, 'package.json'), 'utf8'));
    assert.equal(stageManifest.name, PKG_NAME);
    assert.equal(stageManifest.version, '0.3.3');
    assert.equal(stageManifest.peerDependencies, undefined);
    assert.equal(stageManifest.devDependencies, undefined);
    assert.deepEqual(Object.keys(stageManifest.dependencies ?? {}).sort(), ['@ran-fake/host-peer', '@ran-fake/sdk', 'fake-zod']);
    for (const rel of ['cordis.patch.yml', 'src/server.mjs', 'src/hub/entry.mjs', 'lib/client.js', 'bin/dsh-crew.mjs', 'codex/agents/ds-worker.toml', '.claude-plugin/marketplace.json']) {
      assert.equal(existsSync(join(staged.stageDir, rel)), true, `${rel} must be staged`);
    }
    assert.ok(!existsSync(join(staged.stageDir, 'package.json.bak')));
    // Staging happens under Crew-owned state, never under the candidate root.
    assert.ok(staged.stageDir.startsWith(crewReleasesDir({ home: t.dir })));
    assert.ok(!staged.stageDir.startsWith(sourceRoot));
    // Pre-commit staging still carries the incompleteness marker; validating
    // it in pre-commit mode proves the payload is complete and self-contained.
    const validated = validateInstalledPayload(staged.stageDir, { expectedName: PKG_NAME, expectedVersion: '0.3.3', allowIncomplete: true });
    assert.deepEqual(validated.errors, []);
    assert.equal(existsSync(join(staged.stageDir, 'node_modules', '@ran-fake', 'protocol-peer', 'index.js')), true,
      'transitive runtime peers must be persisted with the installed payload');
    // The same validation without the pre-commit flag fails closed.
    const strict = validateInstalledPayload(staged.stageDir, { expectedName: PKG_NAME, expectedVersion: '0.3.3' });
    assert.ok(strict.errors.some((e) => e.includes('incomplete')));
    rmSync(staged.stageDir, { recursive: true, force: true });
  } finally { t.cleanup(); }
});

test('staging falls back to npm for locally missing dependencies and validates the result', () => {
  const t = tempHome();
  try {
    const sourceRoot = makeCandidate(t.dir);
    // The host-peer cohort is absent from the running instance (as under npx).
    rmSync(join(sourceRoot, 'node_modules', '@ran-fake', 'host-peer'), { recursive: true, force: true });
    const npmCalls = [];
    const npmInstaller = (stageRoot) => {
      npmCalls.push(stageRoot);
      mkdirSync(join(stageRoot, 'node_modules', '@ran-fake', 'host-peer'), { recursive: true });
      writeFileSync(join(stageRoot, 'node_modules', '@ran-fake', 'host-peer', 'package.json'),
        JSON.stringify({ name: '@ran-fake/host-peer', version: '9.0.0', main: 'index.js' }));
      writeFileSync(join(stageRoot, 'node_modules', '@ran-fake', 'host-peer', 'index.js'), 'module.exports=3;\n');
      return true;
    };
    const staged = stageCandidatePayload({ sourceRoot, home: t.dir, npmInstaller });
    assert.equal(staged.ok, true, `staging failed: ${JSON.stringify(staged)}`);
    assert.equal(npmCalls.length, 1);
    assert.equal(npmCalls[0], staged.stageDir);
    rmSync(staged.stageDir, { recursive: true, force: true });
  } finally { t.cleanup(); }
});

test('a failed boot smoke aborts staging without leaving a release behind', () => {
  const t = tempHome();
  try {
    const sourceRoot = makeCandidate(t.dir);
    const staged = stageCandidatePayload({
      sourceRoot, home: t.dir,
      smoke: () => ({ ok: false, detail: 'simulated boot failure' }),
    });
    assert.equal(staged.ok, false);
    assert.equal(staged.code, 'STAGE_SMOKE_FAILED');
    assert.equal(releaseCount(t.dir), 0);
  } finally { t.cleanup(); }
});

test('payload smoke performs a real MCP initialize handshake after launcher help', () => {
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.at(-1) === '--help') return { status: 0, stdout: 'Usage: dsh-crew\n', stderr: '' };
    return {
      status: 0,
      stdout: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'dsh-crew' } } }) + '\n',
      stderr: '',
    };
  };

  const result = defaultPayloadSmoke(join('C:', 'staged-payload'), { nodePath: 'node', runner });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2, 'smoke must verify both launcher and MCP server startup');
  assert.equal(calls[1].args.at(-1), join('C:', 'staged-payload', 'src', 'server.mjs'));
  const initialize = JSON.parse(calls[1].options.input.trim());
  assert.equal(initialize.method, 'initialize');
  assert.equal(initialize.params.clientInfo.name, 'dsh-crew-payload-smoke');
});

test('validateInstalledPayload fails closed on identity, artifact, or dependency gaps', () => {
  const t = tempHome();
  try {
    const sourceRoot = makeCandidate(t.dir);
    const staged = stageCandidatePayload({ sourceRoot, home: t.dir });
    assert.equal(staged.ok, true);
    assert.match(validateInstalledPayload(staged.stageDir, { expectedName: PKG_NAME, expectedVersion: '9.9.9' }).errors.join(), /version mismatch/);

    rmSync(join(staged.stageDir, 'lib', 'client.js'));
    let errors = validateInstalledPayload(staged.stageDir, { expectedName: PKG_NAME, expectedVersion: '0.3.3' }).errors;
    assert.ok(errors.some((e) => e.includes('lib/client.js')));

    cpSync(staged.stageDir, join(t.dir, 'copy'), { recursive: true });
    rmSync(join(t.dir, 'copy', 'node_modules'), { recursive: true, force: true });
    errors = validateInstalledPayload(join(t.dir, 'copy'), { expectedName: PKG_NAME, expectedVersion: '0.3.3', allowIncomplete: true }).errors;
    assert.ok(errors.some((e) => e.includes('vendored dependency missing')), JSON.stringify(errors));
    assert.ok(errors.some((e) => e.includes('import target not resolvable')), JSON.stringify(errors));

    assert.equal(validateInstalledPayload(join(t.dir, 'missing-dir')).ok, false);
    rmSync(staged.stageDir, { recursive: true, force: true });
  } finally { t.cleanup(); }
});

// ---------- install ----------

test('install persists the payload under Crew-owned state and registers that path', async () => {
  const t = tempHome();
  try {
    const sourceRoot = makeCandidate(t.dir);
    const { installer, calls } = recordingInstaller();
    const logs = [];
    const r = await npxInstall({
      home: t.dir, sourceRoot, installer, log: (m) => logs.push(m),
      ensureRuntime: okRuntime(),
    });
    assert.equal(r.ok, true, `install failed: ${logs.join('\n')}`);

    const pointer = readCurrentPointer({ home: t.dir });
    assert.equal(pointer.version, '0.3.3');
    assert.equal(pointer.path, r.path);
    assert.ok(pointer.path.startsWith(crewAppRoot({ home: t.dir })), 'installed payload must live under Crew-owned state');
    assert.ok(!pointer.path.startsWith(sourceRoot), 'must not register the transient candidate location');

    // Real Harness registration ran: profile metadata + junction point at the release.
    const profilePkg = JSON.parse(readFileSync(join(t.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew', 'package.json'), 'utf8'));
    assert.equal(profilePkg.dependencies?.[PKG_NAME], `link:${pointer.path.replace(/\\/g, '/')}`);
    assert.ok(profilePkg.dsh.profile.bundles.includes(PKG_NAME));
    assert.ok(existsSync(join(t.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew', 'node_modules', '@ran-sh', 'dsh-crew', 'package.json')));

    // Integrations rendered against the persisted release, not the candidate.
    const codexCall = calls.find(([name]) => name === 'installCodex');
    assert.equal(codexCall[1].root, pointer.path);
    const claudeCall = calls.find(([name]) => name === 'installClaudeCode');
    assert.equal(claudeCall[1].root, pointer.path);
    const startupCall = calls.find(([name]) => name === 'installWindowsStartup');
    assert.equal(startupCall[1].root, pointer.path);

    // The release is runnable standalone: its own bin exists and deps resolve locally.
    assert.equal(existsSync(join(pointer.path, 'bin', 'dsh-crew.mjs')), true);
    assert.equal(releaseCount(t.dir), 1);
  } finally { t.cleanup(); }
});

test('same-version reinstall is a repairing no-op that does not add releases', async () => {
  const t = tempHome();
  try {
    const sourceRoot = makeCandidate(t.dir);
    const { installer } = recordingInstaller();
    const first = await npxInstall({ home: t.dir, sourceRoot, installer, log: () => {}, ensureRuntime: okRuntime() });
    assert.equal(first.ok, true);
    const second = await npxInstall({ home: t.dir, sourceRoot, installer, log: () => {}, ensureRuntime: okRuntime() });
    assert.equal(second.ok, true);
    assert.equal(second.repaired, true);
    assert.equal(second.path, first.path);
    assert.equal(releaseCount(t.dir), 1);
  } finally { t.cleanup(); }
});

test('install fails closed without mutating anything when the candidate cannot be staged', async () => {
  const t = tempHome();
  try {
    const sourceRoot = makeCandidate(t.dir);
    rmSync(join(sourceRoot, 'node_modules'), { recursive: true, force: true });
    const rec = recordingInstaller();
    const r = await npxInstall({
      home: t.dir, sourceRoot, installer: rec.installer, log: () => {},
      ensureRuntime: okRuntime(),
      npmInstaller: () => false, // fallback disabled: replication gap becomes fatal
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /staging failed/);
    assert.equal(existsSync(currentPointerFile({ home: t.dir })), false);
    assert.equal(releaseCount(t.dir), 0, 'failed staging must leave no release behind');
    assert.deepEqual(rec.calls.filter(([n]) => n === 'installCodex'), []);
  } finally { t.cleanup(); }
});

// ---------- status ----------

test('status is read-only and reports candidate/installed versions plus integration state', async () => {
  const t = tempHome();
  try {
    const logsBefore = [];
    const before = await npxStatus({ home: t.dir, sourceRoot: makeCandidate(t.dir), log: (m) => logsBefore.push(m) });
    assert.equal(before.ok, true);
    assert.equal(before.installedVersion, null);
    assert.match(logsBefore.join('\n'), /DSH plugin: not installed/);
    assert.match(logsBefore.join('\n'), /Official 3080 UI bridge: disabled/);

    const { installer } = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: join(t.dir, 'candidate'), installer, log: () => {}, ensureRuntime: okRuntime() });

    // installStatus now reports integrations installed (as the real module would).
    const st = recordingInstaller();
    st.installer.installStatus = () => ({ claude: { installed: true }, codex: { installed: true } });
    const logsAfter = [];
    const after = await npxStatus({ home: t.dir, sourceRoot: join(t.dir, 'candidate'), installer: st.installer, log: (m) => logsAfter.push(m) });
    assert.equal(after.candidateVersion, '0.3.3');
    assert.equal(after.installedVersion, '0.3.3');
    assert.equal(after.dshPlugin, 'installed');
    assert.equal(after.codex, 'installed');
    assert.equal(after.claude, 'installed');
    const joined = logsAfter.join('\n');
    assert.match(joined, /Installed DSH Crew payload: 0\.3\.3 \(/);
    assert.ok(!/key|token|secret/i.test(joined), 'status must not leak secrets');
  } finally { t.cleanup(); }
});

test('status reports unverifiable payloads instead of pretending success', async () => {
  const t = tempHome();
  try {
    const { installer } = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: makeCandidate(t.dir), installer, log: () => {}, ensureRuntime: okRuntime() });
    const pointer = readCurrentPointer({ home: t.dir });
    rmSync(join(pointer.path, 'lib', 'client.js'));
    const logs = [];
    const st = await npxStatus({ home: t.dir, sourceRoot: join(t.dir, 'candidate'), installer, log: (m) => logs.push(m) });
    assert.equal(st.installedVersion, '0.3.3');
    assert.match(logs.join('\n'), /unverifiable\/damaged/);
  } finally { t.cleanup(); }
});

// ---------- update ----------

test('update is idempotent when already current and healthy', async () => {
  const t = tempHome();
  try {
    const rec = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: makeCandidate(t.dir), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    const before = readCurrentPointer({ home: t.dir });
    const callsBefore = rec.calls.length;
    const r = await npxUpdate({ home: t.dir, sourceRoot: join(t.dir, 'candidate'), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    assert.equal(r.ok, true);
    assert.equal(r.idempotent, true);
    assert.equal(r.path, before.path);
    assert.equal(releaseCount(t.dir), 1);
    assert.ok(rec.calls.length > callsBefore, 'idempotent update still re-verifies integrations');
  } finally { t.cleanup(); }
});

test('integrate refuses to write the read-only official web profile', async () => {
  const t = tempHome();
  try {
    makeOfficialWebProfile(t.dir);
    const before = readFileSync(join(t.dir, '.dsh', 'profiles', 'web', 'package.json'), 'utf8');
    const rec = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: makeCandidate(t.dir), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    const integrated = await npxIntegrate({ home: t.dir, log: () => {} });
    assert.equal(integrated.ok, false);
    assert.equal(integrated.error, 'OFFICIAL_WEB_PROFILE_READ_ONLY');
    const after = readFileSync(join(t.dir, '.dsh', 'profiles', 'web', 'package.json'), 'utf8');
    assert.equal(after, before);
  } finally { t.cleanup(); }
});

test('detach refuses to write the read-only official web profile', async () => {
  const t = tempHome();
  try {
    makeOfficialWebProfile(t.dir);
    const before = readFileSync(join(t.dir, '.dsh', 'profiles', 'web', 'package.json'), 'utf8');
    const rec = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: makeCandidate(t.dir), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    assert.equal((await npxDetach({ home: t.dir, log: () => {} })).ok, false);
    assert.equal((await npxDetach({ home: t.dir, log: () => {} })).error, 'OFFICIAL_WEB_PROFILE_READ_ONLY');
    const after = readFileSync(join(t.dir, '.dsh', 'profiles', 'web', 'package.json'), 'utf8');
    assert.equal(after, before);
  } finally { t.cleanup(); }
});

test('update restores the prior pointer when activation fails', async () => {
  const t = tempHome();
  try {
    const rec = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: makeCandidate(t.dir), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    const prior = readCurrentPointer({ home: t.dir });

    const failingInstaller = { ...rec.installer, installCodex: () => ({ ok: false, actions: ['boom'] }) };
    const r = await npxUpdate({ home: t.dir, sourceRoot: join(t.dir, 'candidate'), installer: failingInstaller, log: () => {}, ensureRuntime: okRuntime() });
    assert.equal(r.ok, false);
    const restored = readCurrentPointer({ home: t.dir });
    assert.equal(restored.path, prior.path);
    assert.equal(restored.version, prior.version);
  } finally { t.cleanup(); }
});

test('update refuses to commit when the runtime cohort gate fails', async () => {
  const t = tempHome();
  try {
    const rec = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: makeCandidate(t.dir), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    const prior = readCurrentPointer({ home: t.dir });
    const before = releaseCount(t.dir);

    const badRuntime = async () => ({ ok: false, error: 'DSH_RUNTIME_COHORT_MISMATCH' });
    const r = await npxUpdate({ home: t.dir, sourceRoot: join(t.dir, 'candidate'), installer: rec.installer, log: () => {}, ensureRuntime: badRuntime });
    assert.equal(r.ok, false);
    const kept = readCurrentPointer({ home: t.dir });
    assert.equal(kept.path, prior.path);
    assert.equal(releaseCount(t.dir), before);
  } finally { t.cleanup(); }
});

test('update upgrades an older installation through staged validation before switching', async () => {
  const t = tempHome();
  try {
    const sourceRoot = makeCandidate(t.dir);
    const { installer } = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot, installer, log: () => {}, ensureRuntime: okRuntime() });

    // Candidate moves to 0.4.0 (upgrade).
    const manifestFile = join(sourceRoot, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.version = '0.4.0';
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const nm = join(sourceRoot, 'node_modules');
    writeFileSync(join(nm, '@ran-fake', 'sdk', 'package.json'), JSON.parse(readFileSync(join(nm, '@ran-fake', 'sdk', 'package.json'), 'utf8')) && readFileSync(join(nm, '@ran-fake', 'sdk', 'package.json'), 'utf8'));

    const r = await npxUpdate({ home: t.dir, sourceRoot, installer, log: () => {}, ensureRuntime: okRuntime() });
    assert.equal(r.ok, true);
    assert.equal(r.updated, true);
    assert.equal(r.version, '0.4.0');
    const pointer = readCurrentPointer({ home: t.dir });
    assert.equal(pointer.version, '0.4.0');
    assert.notEqual(pointer.path, undefined);
    assert.equal(JSON.parse(readFileSync(join(pointer.path, 'package.json'), 'utf8')).version, '0.4.0');
    // Old usable release retained (keep policy), current switched safely.
    assert.equal(releaseCount(t.dir), 2);
  } finally { t.cleanup(); }
});

test('update repairs stale/incomplete payloads and registrations while preserving config and credentials', async () => {
  const t = tempHome();
  try {
    const configDir = join(t.dir, '.config', 'dsh-crew');
    mkdirSync(configDir, { recursive: true });
    const configFile = join(configDir, 'config.json');
    const envFile = join(configDir, '.env');
    writeFileSync(configFile, '{"hub_url":"http://127.0.0.1:3210"}');
    writeFileSync(envFile, 'TEST_ONLY=1');

    const { installer } = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: makeCandidate(t.dir), installer, log: () => {}, ensureRuntime: okRuntime() });
    const original = readCurrentPointer({ home: t.dir });

    // Corrupt the installed payload AND remove the Harness registration link.
    rmSync(join(original.path, 'src', 'server.mjs'));
    rmSync(join(configDir, 'harness', 'profiles', 'dsh-crew', 'node_modules', '@ran-sh'), { recursive: true, force: true });
    rmSync(join(original.path, 'node_modules', '@ran-fake'), { recursive: true, force: true });

    const logs = [];
    const r = await npxUpdate({ home: t.dir, sourceRoot: join(t.dir, 'candidate'), installer, log: (m) => logs.push(m), ensureRuntime: okRuntime() });
    assert.match(logs.join('\n'), /stale or incomplete/);
    assert.equal(r.ok, true, `repair failed: ${logs.join('\n')}`);
    assert.equal(r.updated, true);

    const repaired = readCurrentPointer({ home: t.dir });
    assert.notEqual(repaired.path, original.path, 'repair must switch to a fresh validated release');
    assert.equal(validateInstalledPayload(repaired.path, { expectedName: PKG_NAME, expectedVersion: '0.3.3' }).ok, true);
    const profilePkg = JSON.parse(readFileSync(join(configDir, 'harness', 'profiles', 'dsh-crew', 'package.json'), 'utf8'));
    assert.equal(profilePkg.dependencies?.[PKG_NAME], `link:${repaired.path.replace(/\\/g, '/')}`);

    // Config/credentials byte-identical; nothing outside app/ + registration was touched.
    assert.equal(readFileSync(configFile, 'utf8'), '{"hub_url":"http://127.0.0.1:3210"}');
    assert.equal(readFileSync(envFile, 'utf8'), 'TEST_ONLY=1');
  } finally { t.cleanup(); }
});

// ---------- uninstall ----------

test('uninstall removes payload, registration, and integrations but preserves config/backups', async () => {
  const t = tempHome();
  try {
    const configDir = join(t.dir, '.config', 'dsh-crew');
    mkdirSync(join(configDir, 'harness'), { recursive: true });
    const configFile = join(configDir, 'config.json');
    writeFileSync(configFile, '{}');
    writeFileSync(join(configDir, '.env'), 'KEEP=1');

    const rec = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: makeCandidate(t.dir), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });

    const logs = [];
    const r = await npxUninstall({ home: t.dir, installer: rec.installer, log: (m) => logs.push(m) });
    assert.equal(r.ok, true, `uninstall failed: ${logs.join('\n')}`);
    assert.equal(existsSync(crewAppRoot({ home: t.dir })), false, 'Crew-managed payload removed');
    assert.equal(existsSync(currentPointerFile({ home: t.dir })), false);
    assert.equal(existsSync(configFile), true, 'config preserved by default');
    assert.equal(readFileSync(join(configDir, '.env'), 'utf8'), 'KEEP=1');
    const profilePkg = JSON.parse(readFileSync(join(configDir, 'harness', 'profiles', 'dsh-crew', 'package.json'), 'utf8'));
    assert.equal(profilePkg.dependencies?.[PKG_NAME], undefined);
    assert.ok(!profilePkg.dsh.profile.bundles.includes(PKG_NAME));
    assert.ok(rec.calls.some(([n]) => n === 'uninstallCodex'));
    assert.ok(rec.calls.some(([n]) => n === 'uninstallClaudeCode'));

    // Idempotent repeat.
    const again = await npxUninstall({ home: t.dir, installer: rec.installer, log: () => {} });
    assert.equal(again.ok, true);
    assert.equal(existsSync(configFile), true);
  } finally { t.cleanup(); }
});

test('uninstall leaves the read-only official profile byte-identical', async () => {
  const t = tempHome();
  try {
    const profileRoot = makeOfficialWebProfile(t.dir);
    const before = readFileSync(join(profileRoot, 'package.json'), 'utf8');
    const rec = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: makeCandidate(t.dir), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    await npxUninstall({ home: t.dir, installer: rec.installer, log: () => {} });
    const after = readFileSync(join(profileRoot, 'package.json'), 'utf8');
    assert.equal(after, before);
  } finally { t.cleanup(); }
});

test('uninstall --purge explicitly removes the whole Crew directory', async () => {
  const t = tempHome();
  try {
    const rec = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: makeCandidate(t.dir), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    const r = await npxUninstall({ home: t.dir, purge: true, installer: rec.installer, log: () => {} });
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(t.dir, '.config', 'dsh-crew')), false);
  } finally { t.cleanup(); }
});

// ---------- CLI dispatch ----------

async function cli(argv, streams = {}) {
  const out = [];
  const err = [];
  const code = await runNpxCli({
    argv,
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    commands: streams.commands,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

await test('CLI dispatch: help, unknown command, and no command follow the contract', async () => {
  assert.equal((await cli(['--help'])).code, 0);
  assert.match((await cli(['--help'])).out, /usage: dsh-crew/);
  const unknown = await cli(['banana']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown command: banana/);
  assert.match(unknown.err, /usage: dsh-crew/);
  const none = await cli([]);
  assert.equal(none.code, 1);
  assert.match(none.err, /usage: dsh-crew/);
});

await test('CLI dispatch routes commands and forwards flags', async () => {
  const routed = [];
  const commands = {
    install: async ({ log }) => { routed.push(['install']); log('installed'); return { ok: true }; },
    status: async ({ log }) => { routed.push(['status']); log('status'); return { ok: true }; },
    update: async ({ log }) => { routed.push(['update']); log('updated'); return { ok: true }; },
    uninstall: async ({ purge, log }) => { routed.push(['uninstall', purge]); log('removed'); return { ok: true }; },
    integrate: async ({ log }) => { routed.push(['integrate']); log('integrated'); return { ok: true }; },
    detach: async ({ log }) => { routed.push(['detach']); log('detached'); return { ok: true }; },
    inspect: async ({ log }) => { routed.push(['inspect']); log('{"kind":"dsh-crew-extension"}'); return { ok: true }; },
  };
  assert.equal((await cli(['status'], { commands })).out, 'status');
  assert.equal((await cli(['update'], { commands })).out, 'updated');
  assert.equal((await cli(['install'], { commands })).out, 'installed');
  assert.equal((await cli(['integrate'], { commands })).out, 'integrated');
  assert.equal((await cli(['detach'], { commands })).out, 'detached');
  assert.match((await cli(['inspect'], { commands })).out, /dsh-crew-extension/);
  const purged = await cli(['uninstall', '--purge'], { commands });
  assert.equal(purged.code, 0);
  assert.deepEqual(routed.at(-1), ['uninstall', true]);
  const failing = await cli(['install'], { commands: { install: async () => ({ ok: false }) } });
  assert.equal(failing.code, 1);
  const throwing = await cli(['status'], { commands: { status: async () => { throw new Error('boom'); } } });
  assert.equal(throwing.code, 1);
  assert.match(throwing.err, /boom/);
});

test('CLI dispatch forwards provider lifecycle flags without interpreting them as positional args', async () => {
  let received;
  const result = await cli([
    'providers', 'delete', 'opencode-go', '--plan', 'plan-1', '--expected-revision', 'a'.repeat(64), '--confirm',
  ], {
    commands: {
      providers: async (options) => { received = options; return { ok: true }; },
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(received.args, ['delete', 'opencode-go']);
  assert.equal(received.planId, 'plan-1');
  assert.equal(received.expectedRevision, 'a'.repeat(64));
  assert.equal(received.confirm, true);
});

test('inspect prints the machine-readable extension contract from the isolated Hub', async () => {
  const lines = [];
  const result = await npxInspect({
    log: (line) => lines.push(line),
    readConfig: () => ({ hub_url: 'http://127.0.0.1:3210' }),
    fetchImpl: async (url) => url.endsWith('/runtime')
      ? { ok: true, json: async () => ({ ok: true, service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1', capabilities: ['extension-contract', 'evidence', 'runtime-provenance-v1'] }) }
      : { ok: true, json: async () => ({ ok: true, extension: { schema_version: 1, kind: 'dsh-crew-extension', source: url } }) },
  });
  assert.equal(result.ok, true);
  assert.match(lines.join('\n'), /"kind": "dsh-crew-extension"/);
  assert.match(lines.join('\n'), /127\.0\.0\.1:3210/);
});

test('jobs CLI projects list, contract watch, cancel and JSON request submission', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([url, init]);
    if (url.endsWith('/runtime')) return { ok: true, json: async () => ({ ok: true, service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1', capabilities: ['jobs', 'jobs-wait', 'jobs-cancel', 'roles', 'attempt-index', 'model-policy'] }) };
    return { ok: true, json: async () => ({ ok: true, job: { id: 'hub-1' }, jobs: [] }) };
  };
  const common = { log: () => {}, readConfig: () => ({ hub_url: 'http://127.0.0.1:3210' }), fetchImpl };
  assert.equal((await npxJobs({ ...common, args: ['list'] })).ok, true);
  await npxJobs({ ...common, args: ['watch', 'hub-1'], after: 7, detail: 'compact' });
  assert.match(calls.at(-1)[0], /jobs\/hub-1\/contract\?detail=compact&after=7$/);
  await npxJobs({ ...common, args: ['cancel', 'hub-1'] });
  assert.equal(calls.at(-1)[1].method, 'POST');
  const home = tempHome();
  try {
    const request = join(home.dir, 'job.json');
    writeFileSync(request, JSON.stringify({ objective: 'test', workspace: { repo_root: home.dir } }));
    await npxJobs({ ...common, args: ['submit'], request });
    assert.equal(calls.at(-1)[1].method, 'POST');
    assert.match(calls.at(-1)[1].body, /"objective":"test"/);
  } finally { home.cleanup(); }
});

test('inspect and jobs CLI reject non-3210 configured targets before any request', async () => {
  for (const hubUrl of ['http://127.0.0.1:3080', 'http://127.0.0.1:45678', 'not-a-url']) {
    let calls = 0;
    const common = { readConfig: () => ({ hub_url: hubUrl }), fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({}) }; }, log: () => {} };
    await assert.rejects(() => npxInspect(common), /3210 Crew Hub/);
    await assert.rejects(() => npxJobs({ ...common, args: ['list'] }), /3210 Crew Hub/);
    assert.equal(calls, 0, hubUrl);
  }
});

test('jobs submit and cancel stop at the runtime capability gate', async () => {
  const badRuntimes = [
    { service: 'other-service' },
    { service: 'dsh-crew-hub', execution_plane: 'standalone', profile: 'legacy', listen_port: 3080 },
    { service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'wrong', listen_port: 3210 },
    { service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3080 },
    { service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, capabilities: ['jobs'] },
  ];
  for (const runtime of badRuntimes) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push([url, init]);
      return { ok: true, json: async () => ({ ok: true, ...runtime }) };
    };
    const common = { readConfig: () => ({ hub_url: 'http://127.0.0.1:3210' }), fetchImpl, log: () => {} };
    await assert.rejects(() => npxJobs({ ...common, args: ['cancel', 'job-1'] }), /3210 Crew Hub|missing job capability/i);
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /3210\/_dsh\/dsh-crew\/runtime$/);
    const home = tempHome();
    try {
      const request = join(home.dir, 'job.json');
      writeFileSync(request, JSON.stringify({ objective: 'test', workspace: { repo_root: home.dir } }));
      calls.length = 0;
      await assert.rejects(() => npxJobs({ ...common, args: ['submit'], request }), /3210 Crew Hub|missing job capability/i);
      assert.equal(calls.length, 1);
    } finally { home.cleanup(); }
  }
});

test('release rollback switches to a validated retained payload and restarts the owned runtime', async () => {
  const t = tempHome();
  try {
    const releases = crewReleasesDir({ home: t.dir });
    const oldDir = join(releases, 'old-0.5.6');
    const currentDir = join(releases, 'current-0.5.7');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(oldDir, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.5.6' }));
    writeFileSync(join(currentDir, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.5.7' }));
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: PKG_NAME, version: '0.5.7', path: currentDir }));
    const calls = [];
    const result = await npxRollback({
      home: t.dir, version: '0.5.6', log: () => {}, validatePayload: () => ({ ok: true }),
      activate: async ({ releaseDir }) => { calls.push(['activate', releaseDir]); return true; },
      restart: async () => { calls.push(['restart']); return { ok: true }; },
      verifyRuntime: async (version) => { calls.push(['verify', version]); return { ok: true, runtime_version: version }; },
    });
    assert.equal(result.ok, true);
    assert.equal(readCurrentPointer({ home: t.dir }).version, '0.5.6');
    assert.deepEqual(calls, [['activate', oldDir], ['restart'], ['verify', '0.5.6']]);
  } finally { t.cleanup(); }
});

test('release rollback restores the previous pointer when activation fails', async () => {
  const t = tempHome();
  try {
    const releases = crewReleasesDir({ home: t.dir });
    const oldDir = join(releases, 'old-0.5.6');
    const currentDir = join(releases, 'current-0.5.7');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(oldDir, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.5.6' }));
    writeFileSync(join(currentDir, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.5.7' }));
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: PKG_NAME, version: '0.5.7', path: currentDir }));
    const result = await npxRollback({
      home: t.dir, version: '0.5.6', log: () => {}, validatePayload: () => ({ ok: true }),
      activate: async () => false, restart: async () => ({ ok: true }),
      verifyRuntime: async () => ({ ok: true, runtime_version: '0.5.6' }),
    });
    assert.equal(result.ok, false);
    assert.equal(readCurrentPointer({ home: t.dir }).version, '0.5.7');
  } finally { t.cleanup(); }
});

test('release rollback reports compensation failure instead of claiming restored', async () => {
  const cases = ['prior activation', 'prior restart', 'prior verification'];
  for (const label of cases) {
    const t = tempHome();
    try {
      const releases = crewReleasesDir({ home: t.dir });
      const oldDir = join(releases, 'old-0.5.6');
      const currentDir = join(releases, 'current-0.5.7');
      mkdirSync(oldDir, { recursive: true });
      mkdirSync(currentDir, { recursive: true });
      writeFileSync(join(oldDir, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.5.6' }));
      writeFileSync(join(currentDir, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.5.7' }));
      writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: PKG_NAME, version: '0.5.7', path: currentDir }));
      const result = await npxRollback({
        home: t.dir, version: '0.5.6', log: () => {}, validatePayload: () => ({ ok: true }),
        activate: async ({ releaseDir }) => releaseDir === oldDir || label !== 'prior activation',
        restart: async (version) => version === '0.5.6'
          ? { ok: false, code: 'TARGET_RESTART_FAILED' }
          : label === 'prior restart' ? { ok: false, code: 'PRIOR_RESTART_FAILED' } : { ok: true },
        verifyRuntime: async (version) => version === '0.5.7' && label === 'prior verification'
          ? { ok: false, code: 'PRIOR_VERIFY_FAILED' } : { ok: true, runtime_version: version },
      });
      assert.equal(result.ok, false, label);
      assert.equal(result.restored, false, label);
      assert.equal(result.recovery?.ok, false, label);
      assert.equal(readCurrentPointer({ home: t.dir }).version, '0.5.7', label);
    } finally { t.cleanup(); }
  }
});

test('release rollback reports restored only after complete compensation', async () => {
  const t = tempHome();
  try {
    const releases = crewReleasesDir({ home: t.dir });
    const oldDir = join(releases, 'old-0.5.6');
    const currentDir = join(releases, 'current-0.5.7');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(oldDir, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.5.6' }));
    writeFileSync(join(currentDir, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.5.7' }));
    writeFileSync(currentPointerFile({ home: t.dir }), JSON.stringify({ name: PKG_NAME, version: '0.5.7', path: currentDir }));
    const result = await npxRollback({
      home: t.dir, version: '0.5.6', log: () => {}, validatePayload: () => ({ ok: true }),
      activate: async () => true,
      restart: async (version) => version === '0.5.6' ? { ok: false, code: 'TARGET_RESTART_FAILED' } : { ok: true },
      verifyRuntime: async (version) => version === '0.5.7' ? { ok: true, runtime_version: version } : { ok: false, code: 'TARGET_VERIFY_FAILED' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.restored, true);
    assert.equal(result.recovery?.ok, true);
    assert.equal(readCurrentPointer({ home: t.dir }).version, '0.5.7');
  } finally { t.cleanup(); }
});

test('CLI dispatch exposes release inventory and rollback commands', async () => {
  const seen = [];
  const commands = {
    releases: async ({ args }) => { seen.push(['releases', args]); return { ok: true }; },
    rollback: async ({ version }) => { seen.push(['rollback', version]); return { ok: true }; },
  };
  assert.equal(await runNpxCli({ argv: ['releases', 'list'], commands, log: () => {}, error: () => {} }), 0);
  assert.equal(await runNpxCli({ argv: ['rollback', '0.5.6'], commands, log: () => {}, error: () => {} }), 0);
  assert.deepEqual(seen, [['releases', ['list']], ['rollback', '0.5.6']]);
});

test('providers CLI stays on the 3210 lifecycle API and binds destructive flags', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([url, init]);
    if (url.endsWith('/runtime')) return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1',
        capabilities: ['provider-inventory', 'provider-lifecycle-v1', 'provider-health-v1', 'provider-probe-stream-v1'] }),
    };
    return { ok: true, json: async () => ({ ok: true, records: [], plan: { plan_id: 'plan-1' } }) };
  };
  const common = { log: () => {}, readConfig: () => ({ hub_url: 'http://127.0.0.1:3210' }), fetchImpl };
  await npxProviders({ ...common, args: ['list'] });
  assert.equal(calls.at(-1)[0], 'http://127.0.0.1:3210/_dsh/dsh-crew/providers');
  await npxProviders({ ...common, args: ['migration-status'] });
  assert.equal(calls.at(-1)[0], 'http://127.0.0.1:3210/_dsh/dsh-crew/providers/migration-status');
  assert.equal(calls.at(-1)[1].method, undefined);
  await npxProviders({ ...common, args: ['delete-plan', 'opencode-go'], replacementDefault: 'openrouter' });
  assert.equal(calls.at(-1)[1].method, 'POST');
  assert.match(calls.at(-1)[1].body, /"replacement_default":"openrouter"/);
  await npxProviders({ ...common, args: ['probe', 'opencode-go'] });
  assert.equal(calls.at(-1)[1].method, 'POST');
  assert.match(calls.at(-1)[0], /providers\/opencode-go\/probe$/);
  await npxProviders({ ...common, args: ['rollback', 'opencode-go'], planId: 'plan-1', confirm: true });
  assert.equal(calls.at(-1)[1].method, 'POST');
  assert.match(calls.at(-1)[0], /providers\/opencode-go\/rollback$/);
  await npxProviders({ ...common, args: ['delete', 'opencode-go'], planId: 'plan-1', expectedRevision: 'a'.repeat(64), confirm: true });
  assert.equal(calls.at(-1)[1].method, 'DELETE');
  assert.match(calls.at(-1)[1].body, /"confirm":true/);
  assert.match(calls.at(-1)[0], /providers\/opencode-go$/);
  await assert.rejects(
    () => npxProviders({ ...common, readConfig: () => ({ hub_url: 'http://127.0.0.1:3080' }), args: ['list'] }),
    /isolated 3210 Crew Hub/,
  );
  await assert.rejects(
    () => npxProviders({ ...common, args: ['delete', 'opencode-go'], planId: 'plan-1', expectedRevision: 'a'.repeat(64), confirm: true, purgeOrphanCredentials: true }),
    /separate explicit confirmation/,
  );
});

test('providers CLI exposes explicit layer migration actions on 3210', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([url, init]);
    if (url.endsWith('/runtime')) return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1', capabilities: ['provider-inventory', 'provider-layer-migration-v1'] }),
    };
    return { ok: true, json: async () => (url.includes('rollback-migration')
      ? { ok: true, state: 'ROLLBACK_RESTART_PENDING', restart_required: true, plan: { plan_id: 'migration-1' } }
      : { ok: true, plan: { plan_id: 'migration-1' }, restart_required: true, result: { state: 'RESTART_PENDING' } }) };
  };
  const common = { log: () => {}, readConfig: () => ({ hub_url: 'http://127.0.0.1:3210' }), fetchImpl };
  await npxProviders({ ...common, args: ['migrate-plan', 'custom'] });
  assert.match(calls.at(-1)[0], /providers\/custom\/migrate-plan$/);
  await npxProviders({ ...common, args: ['migrate', 'custom'], planId: 'migration-1', confirm: true });
  assert.equal(calls.some(([url]) => url.endsWith('/providers/custom/migrate')), true);
  assert.equal(calls.some(([url]) => url.includes('3080/_dsh/dsh-crew/supervisor/restart')), true);
  await npxProviders({ ...common, args: ['rollback-migration', 'custom'], planId: 'migration-1', confirm: true });
  assert.equal(calls.some(([url]) => url.endsWith('/providers/custom/verify-rollback-migration')), true);
});

test('providers CLI fails closed before mutation when the 3210 capability handshake is incomplete', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        service: 'dsh-crew-hub',
        execution_plane: 'hub-3210',
        profile: 'dsh-crew',
        listen_port: 3210,
        runtime_id: 'runtime-1',
        capabilities: ['provider-inventory'],
      }),
    };
  };
  await assert.rejects(
    () => npxProviders({
      args: ['delete-plan', 'opencode-go'],
      log: () => {},
      readConfig: () => ({ hub_url: 'http://127.0.0.1:3210' }),
      fetchImpl,
    }),
    /missing provider lifecycle capability/i,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /127\.0\.0\.1:3210\/_dsh\/dsh-crew\/runtime$/);
});

test('providers CLI completes the deferred delete through the owned 3080 supervisor and 3210 verify', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([url, init]);
    if (url.endsWith('/runtime')) return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1',
        capabilities: ['provider-inventory', 'provider-lifecycle-v1'] }),
    };
    if (url.endsWith('/providers/opencode-go')) return { ok: true, status: 202, json: async () => ({ ok: true, restart_required: true, result: { state: 'RESTART_PENDING', transaction_id: 'plan-1' } }) };
    if (url.includes('/supervisor/restart')) return { ok: true, status: 200, json: async () => ({ ok: true, restarted: true, mode: 'official-3080-isolated-3210', execution_plane: 'hub-3210', listen_port: 3210 }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, state: 'VERIFIED' }) };
  };
  const result = await npxProviders({
    args: ['delete', 'opencode-go'], planId: 'plan-1', expectedRevision: 'a'.repeat(64), confirm: true,
    log: () => {}, readConfig: () => ({ hub_url: 'http://127.0.0.1:3210' }), fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 4);
  assert.match(calls[2][0], /127\.0\.0\.1:3080\/\_dsh\/dsh-crew\/supervisor\/restart/);
  assert.match(calls[3][0], /providers\/opencode-go\/verify-delete/);
});

test('providers CLI completes the deferred rollback through the owned 3080 supervisor', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([url, init]);
    if (url.endsWith('/runtime')) return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1',
        capabilities: ['provider-inventory', 'provider-lifecycle-v1'] }),
    };
    if (url.endsWith('/providers/opencode-go/rollback')) return { ok: true, status: 202, json: async () => ({ ok: true, restart_required: true, state: 'ROLLBACK_PENDING', transaction_id: 'plan-1' }) };
    if (url.includes('/supervisor/restart')) return { ok: true, status: 200, json: async () => ({ ok: true, restarted: true }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, state: 'ROLLED_BACK' }) };
  };
  const result = await npxProviders({
    args: ['rollback', 'opencode-go'], planId: 'plan-1', confirm: true,
    log: () => {}, readConfig: () => ({ hub_url: 'http://127.0.0.1:3210' }), fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 4);
  assert.match(calls[3][0], /providers\/opencode-go\/verify-rollback/);
});

test('credentials CLI exposes an independent plan-and-confirm purge flow', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([url, init]);
    if (url.endsWith('/runtime')) return {
      ok: true,
      json: async () => ({ ok: true, service: 'dsh-crew-hub', execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'runtime-1', capabilities: ['credential-reference-inventory-v1', 'credential-purge-v1'] }),
    };
    return { ok: true, json: async () => ({ ok: true, records: [], plan: { plan_id: 'purge-1', expected_revision: 'a'.repeat(64) }, state: 'VERIFIED' }) };
  };
  const common = { log: () => {}, readConfig: () => ({ hub_url: 'http://127.0.0.1:3210' }), fetchImpl };
  await npxCredentials({ ...common, args: ['list'] });
  assert.match(calls.at(-1)[0], /credential-references$/);
  await npxCredentials({ ...common, args: ['purge-plan', 'env:OLD_KEY'] });
  assert.match(calls.at(-1)[0], /credential-references\/env%3AOLD_KEY\/purge-plan$/);
  await npxCredentials({ ...common, args: ['purge', 'env:OLD_KEY'], planId: 'purge-1', expectedRevision: 'a'.repeat(64), confirm: true });
  assert.equal(calls.at(-1)[1].method, 'DELETE');
  assert.match(calls.at(-1)[1].body, /"confirm":true/);
});

test('real bin subprocess: unknown command exits 1 with usage; --help exits 0', () => {
  const bin = join(REPO_ROOT, 'bin', 'dsh-crew.mjs');
  const bad = spawnSync(process.execPath, [bin, 'banana'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown command: banana/);
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: dsh-crew/);
});

test('runningPackageRoot points at the repository checkout during tests', () => {
  assert.equal(runningPackageRoot(), REPO_ROOT);
  assert.equal(CREW_APP_DIRNAME, 'app');
});

// ---------- update candidate resolution and v0.3.5 migration recovery ----------

test('compareVersions orders dotted numeric versions deterministically', () => {
  assert.equal(compareVersions('0.3.10', '0.3.9'), 1);
  assert.equal(compareVersions('0.3.3', '0.3.3'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.3.4', '0.3.4-rc.1') > 0, true);
});

function makeCandidateDir(home, version) {
  return makeCandidate(home, { version });
}

test('resolveUpdateCandidate accepts a payload directory override', () => {
  const t = tempHome();
  try {
    const dir = makeCandidateDir(t.dir, '9.8.7');
    const r = resolveUpdateCandidate({ candidate: dir, home: t.dir });
    assert.equal(r.ok, true);
    assert.equal(r.version, '9.8.7');
    assert.equal(r.sourceRoot, dir);
    assert.equal(r.cleanup, null);
  } finally { t.cleanup(); }
});

test('resolveUpdateCandidate extracts and validates a packed .tgz override', () => {
  const t = tempHome();
  try {
    const stage = join(t.dir, 'packsrc', 'package');
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '7.7.7' }));
    writeFileSync(join(stage, 'index.js'), 'module.exports=1;\n');
    const tgz = join(t.dir, 'candidate.tgz');
    // Relative paths only: GNU tar interprets a `C:\...` argument as a remote
    // rsh host ("Cannot connect to C:"), so anchor the invocation at t.dir
    // instead of passing drive-letter paths.
    execFileSync('tar', ['-czf', 'candidate.tgz', '-C', 'packsrc', 'package'], { cwd: t.dir });
    const r = resolveUpdateCandidate({ candidate: tgz, home: t.dir });
    assert.equal(r.ok, true, `unexpected failure: ${JSON.stringify(r)}`);
    assert.equal(r.version, '7.7.7');
    assert.match(r.sourceRoot, /package$/);
    r.cleanup();
    assert.ok(!existsSync(r.sourceRoot), 'cleanup removes the extracted temp tree');
  } finally { t.cleanup(); }
});

test('resolveUpdateCandidate registry mode packs via npm and verifies identity', () => {
  const t = tempHome();
  try {
    const runner = (command, args) => {
      if (isNpmInvocation(command, args)) {
        const dest = npmPackDestination(args);
        const pkg = join(dest, 'x', 'package');
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '5.5.5' }));
        writeFileSync(join(dest, 'ran-sh-dsh-crew-5.5.5.tgz'), 'fake');
        return { status: 0, stdout: JSON.stringify([{ filename: 'ran-sh-dsh-crew-5.5.5.tgz', name: PKG_NAME, version: '5.5.5' }]), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' }; // tar extract succeeds against the pre-created root
    };
    const logs = [];
    const r = resolveUpdateCandidate({ home: t.dir, log: (m) => logs.push(m), runner });
    assert.equal(r.ok, true, `unexpected failure: ${JSON.stringify(r)}`);
    assert.equal(r.version, '5.5.5');
    assert.match(logs.join('\n'), /configured npm registry/);
    r.cleanup();
  } finally { t.cleanup(); }
});

test('resolveUpdateCandidate fails closed on registry pack failure and identity mismatch', () => {
  const t = tempHome();
  try {
    const failRunner = () => ({ status: 1, stdout: '', stderr: 'E404 nope' });
    const failed = resolveUpdateCandidate({ home: t.dir, runner: failRunner });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'REGISTRY_PACK_FAILED');
    assert.match(failed.detail, /E404/);

    const mismatchRunner = (command, args, opts = {}) => {
      if (isNpmInvocation(command, args)) {
        const dest = npmPackDestination(args);
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, 'x.tgz'), 'fake');
        return { status: 0, stdout: JSON.stringify([{ filename: 'x.tgz', name: PKG_NAME, version: '1.0.0' }]), stderr: '' };
      }
      // tar "extracts" a manifest whose version disagrees with the pack output
      const root = join(opts.cwd, 'package');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '2.0.0' }));
      return { status: 0, stdout: '', stderr: '' };
    };
    const mismatch = resolveUpdateCandidate({ home: t.dir, runner: mismatchRunner });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'CANDIDATE_IDENTITY_MISMATCH');

    const missing = resolveUpdateCandidate({ candidate: join(t.dir, 'nope'), home: t.dir });
    assert.equal(missing.code, 'CANDIDATE_NOT_FOUND');
  } finally { t.cleanup(); }
});

test('update applies an explicit newer candidate directory without a source checkout', async () => {
  const t = tempHome();
  try {
    const rec = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: makeCandidateDir(t.dir, '0.3.4-base'), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    const before = readCurrentPointer({ home: t.dir });

    const newer = makeCandidateDir(join(t.dir, 'override'), '9.9.0');
    const logs = [];
    const r = await npxUpdate({
      home: t.dir, candidate: newer, installer: rec.installer, log: (m) => logs.push(m), ensureRuntime: okRuntime(),
    });
    assert.equal(r.ok, true, `update failed: ${logs.join('\n')}`);
    const after = readCurrentPointer({ home: t.dir });
    assert.equal(after.version, '9.9.0');
    assert.notEqual(after.path, before.path);
    assert.equal(JSON.parse(readFileSync(join(after.path, 'package.json'), 'utf8')).version, '9.9.0');
    assert.equal(releaseCount(t.dir), 2, 'prior usable release retained through activation');
    assert.match(logs.join('\n'), /updating managed payload 0\.3\.4-base -> 9\.9\.0/);
    // The running repo launcher diverges from the fixture payload → direction-aware refresh notice.
    assert.match(logs.join('\n'), /managed payload 9\.9\.0 is newer than the global launcher .*; the payload remains authoritative/);
    assert.match(logs.join('\n'), /npm install -g @ran-sh\/dsh-crew@9\.9\.0/);
  } finally { t.cleanup(); }
});

test('a newer running launcher converges an older payload before registry resolution', async () => {
  const t = tempHome();
  try {
    const rec = recordingInstaller();
    await npxInstall({
      home: t.dir,
      sourceRoot: makeCandidateDir(t.dir, '0.3.3'),
      installer: rec.installer,
      log: () => {},
      ensureRuntime: okRuntime(),
    });
    const before = readCurrentPointer({ home: t.dir });
    let registryCalls = 0;
    const runner = () => {
      registryCalls += 1;
      return { status: 1, stdout: '', stderr: 'registry must not be consulted first' };
    };
    const logs = [];
    const result = await npxUpdate({
      home: t.dir,
      installer: rec.installer,
      log: (message) => logs.push(message),
      ensureRuntime: okRuntime(),
      runner,
    });

    assert.equal(result.ok, true, logs.join('\n'));
    assert.equal(result.version, RUNTIME_VERSION);
    assert.equal(registryCalls, 0, 'the validated running launcher is the first convergence candidate');
    const after = readCurrentPointer({ home: t.dir });
    assert.equal(after.version, RUNTIME_VERSION);
    assert.notEqual(after.path, before.path);
    assert.equal(existsSync(before.path), true, 'prior usable release remains through activation');
    assert.match(logs.join('\n'), /newer launcher .* converging managed payload .* before registry resolution/i);
  } finally { t.cleanup(); }
});

test('status guidance is direction-aware and equal versions are quiet', async () => {
  const older = tempHome();
  const newer = tempHome();
  const equal = tempHome();
  try {
    const rec = recordingInstaller();
    await npxInstall({ home: older.dir, sourceRoot: makeCandidateDir(older.dir, '0.3.3'), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    const olderLogs = [];
    npxStatus({ home: older.dir, installer: rec.installer, log: (message) => olderLogs.push(message) });
    assert.match(olderLogs.join('\n'), /launcher .* is newer than the managed payload/i);
    assert.match(olderLogs.join('\n'), /Run: dsh-crew update/);
    assert.doesNotMatch(olderLogs.join('\n'), /npm install -g @ran-sh\/dsh-crew@0\.3\.3/);

    await npxInstall({ home: newer.dir, sourceRoot: makeCandidateDir(newer.dir, '9.9.0'), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    const newerLogs = [];
    npxStatus({ home: newer.dir, installer: rec.installer, log: (message) => newerLogs.push(message) });
    assert.match(newerLogs.join('\n'), /managed payload .* is newer than the launcher/i);
    assert.match(newerLogs.join('\n'), /npm install -g @ran-sh\/dsh-crew@9\.9\.0/);
    assert.doesNotMatch(newerLogs.join('\n'), /Run: dsh-crew update/);

    await npxInstall({ home: equal.dir, sourceRoot: makeCandidateDir(equal.dir, RUNTIME_VERSION), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    const equalLogs = [];
    npxStatus({ home: equal.dir, sourceRoot: makeCandidateDir(join(equal.dir, 'status'), RUNTIME_VERSION), installer: rec.installer, log: (message) => equalLogs.push(message) });
    assert.doesNotMatch(equalLogs.join('\n'), /differ|newer than|Refresh the launcher|Run: dsh-crew update/i);
  } finally {
    older.cleanup();
    newer.cleanup();
    equal.cleanup();
  }
});

test('registry mode never downgrades a newer managed payload', async () => {
  const t = tempHome();
  try {
    const rec = recordingInstaller();
    await npxInstall({ home: t.dir, sourceRoot: makeCandidateDir(t.dir, '2.0.0'), installer: rec.installer, log: () => {}, ensureRuntime: okRuntime() });
    const before = readCurrentPointer({ home: t.dir });
    const callsBefore = rec.calls.length;

    const runner = (command, args, opts = {}) => {
      if (isNpmInvocation(command, args)) {
        const dest = npmPackDestination(args);
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, 'old.tgz'), 'fake');
        return { status: 0, stdout: JSON.stringify([{ filename: 'old.tgz', name: PKG_NAME, version: '0.0.1' }]), stderr: '' };
      }
      const root = join(opts.cwd, 'package');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: PKG_NAME, version: '0.0.1' }));
      return { status: 0, stdout: '', stderr: '' };
    };
    const logs = [];
    const r = await npxUpdate({ home: t.dir, installer: rec.installer, log: (m) => logs.push(m), ensureRuntime: okRuntime(), runner });
    assert.equal(r.ok, true);
    assert.equal(r.idempotent, true);
    assert.equal(readCurrentPointer({ home: t.dir }).path, before.path, 'pointer must not move on a non-downgrade');
    assert.equal(releaseCount(t.dir), 1, 'no new release staged for an older registry candidate');
    assert.match(logs.join('\n'), /not newer than the installed payload \(2\.0\.0\)/);
    assert.equal(rec.calls.length > callsBefore, true, 'idempotent path still re-verifies integrations');
  } finally { t.cleanup(); }
});

test('CLI forwards --candidate to update in both value forms', async () => {
  const seen = [];
  const commands = { update: async ({ candidate }) => { seen.push(candidate); return { ok: true }; } };
  await runNpxCli({ argv: ['update', '--candidate', 'X:\\dir'], log: () => {}, error: () => {}, commands });
  await runNpxCli({ argv: ['update', '--candidate=Y:\\tgz.tgz'], log: () => {}, error: () => {}, commands });
  assert.deepEqual(seen, ['X:\\dir', 'Y:\\tgz.tgz']);
});
