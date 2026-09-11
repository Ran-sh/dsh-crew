import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DSH_CLI_PACKAGE,
  TARGET_DSH_SPEC,
  TARGET_DSH_VERSION,
  crewDshRuntimeModule,
  crewDshRuntimeRoot,
  resolveDshCli,
  ensureCrewDshRuntime,
  ensureCrewPluginRegistration,
  removeCrewPluginRegistration,
  reconcileProfileBundleCohort,
  resolveNearestBundleVersion,
  buildDshInvocation,
  runResolvedDsh,
  quoteWindowsArg,
} from '../src/dsh-cli-runtime.mjs';

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-runtime-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function pluginRoot(home, name = '@ran-test/dsh-crew', version = '0.3.2-test') {
  const root = join(home, 'checkout');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.js'), 'module.exports = {}\n');
  writeFileSync(join(root, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name,
    version,
    main: './index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2));
  return root;
}

test('Crew-owned reusable runtime wins over global dsh and npx', () => {
  const t = tempHome();
  try {
    const entry = crewDshRuntimeModule({ home: t.dir });
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, '// test entry\n');
    writeFileSync(join(entry, '..', '..', 'package.json'), JSON.stringify({ name: DSH_CLI_PACKAGE, version: '9.9.9-test' }));
    const cli = resolveDshCli({
      home: t.dir,
      env: {},
      findCommand: (name) => name === 'dsh' ? 'global-dsh' : 'global-npx',
    });
    assert.equal(cli.kind, 'crew-runtime');
    assert.equal(cli.version, '9.9.9-test');
    assert.equal(cli.command, process.execPath);
    assert.equal(cli.source, 'crew-runtime');
  } finally { t.cleanup(); }
});

test('explicit CLI path wins and does not inspect official profile state', () => {
  const t = tempHome();
  try {
    const explicit = join(t.dir, 'bin', 'dsh.js');
    mkdirSync(join(t.dir, 'bin'), { recursive: true });
    writeFileSync(explicit, '');
    const cli = resolveDshCli({ home: t.dir, env: { DSH_CREW_DSH_CLI: explicit }, findCommand: () => { throw new Error('fallback used'); } });
    assert.equal(cli.kind, 'explicit-node');
    assert.deepEqual(cli.args, [explicit]);
  } finally { t.cleanup(); }
});

test('resolution never invokes a network probe', () => {
  const calls = [];
  const cli = resolveDshCli({
    env: {},
    exists: () => false,
    findCommand: (name) => { calls.push(name); return name === 'npx' ? 'npx' : null; },
    allowDownload: false,
  });
  assert.equal(cli.kind, 'npx-local');
  assert.deepEqual(cli.args, ['--no-install', DSH_CLI_PACKAGE]);
  assert.deepEqual(calls, ['dsh', 'npx']);
});

test('ensureCrewDshRuntime installs only under the Crew home and is reusable', () => {
  const t = tempHome();
  try {
    let invocation;
    const result = ensureCrewDshRuntime({
      home: t.dir,
      findCommand: (name) => name === 'npm' ? 'npm' : null,
      runner: (command, args, options) => {
        invocation = { command, args, options };
        const entry = crewDshRuntimeModule({ home: t.dir });
        mkdirSync(join(entry, '..'), { recursive: true });
        writeFileSync(entry, '// test entry\n');
        writeFileSync(join(entry, '..', '..', 'package.json'), JSON.stringify({ name: DSH_CLI_PACKAGE, version: TARGET_DSH_VERSION }));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.cli.kind, 'crew-runtime');
    assert.equal(result.version, TARGET_DSH_VERSION);
    assert.equal(invocation.args.includes(crewDshRuntimeRoot({ home: t.dir })), true);
    assert.equal(invocation.args.at(-1), TARGET_DSH_SPEC);
    assert.equal(invocation.options.env.DSH_HOME, undefined);
    assert.equal(existsSync(crewDshRuntimeRoot({ home: t.dir })), true);
  } finally { t.cleanup(); }
});

test('ensureCrewDshRuntime refuses to reuse a stale-cohort runtime in place', () => {
  const t = tempHome();
  try {
    const entry = crewDshRuntimeModule({ home: t.dir });
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, '// test entry\n');
    writeFileSync(join(entry, '..', '..', 'package.json'), JSON.stringify({ name: DSH_CLI_PACKAGE, version: '0.1.1-rc.2' }));
    let ran = false;
    const result = ensureCrewDshRuntime({
      home: t.dir,
      findCommand: (name) => name === 'npm' ? 'npm' : null,
      runner: () => { ran = true; return { status: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DSH_RUNTIME_COHORT_MISMATCH');
    assert.equal(ran, false);
  } finally { t.cleanup(); }
});

test('Windows .cmd invocation quotes paths and arguments deterministically', () => {
  const cli = { command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['--yes'] };
  const invocation = buildDshInvocation(cli, ['plugin', '--profile', 'dsh-crew', 'link:C:\\Users\\A B\\repo'], {
    platform: 'win32',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
  });
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 2), ['/d', '/s']);
  assert.ok(invocation.args[3].includes('"C:\\Program Files\\nodejs\\npx.cmd"'));
  assert.ok(invocation.args[3].includes('"link:C:\\Users\\A B\\repo"'));
  assert.equal(quoteWindowsArg('plain'), 'plain');
  assert.equal(quoteWindowsArg('A B'), '"A B"');
});

test('runResolvedDsh always injects Crew DSH_HOME and never targets official web', () => {
  const t = tempHome();
  try {
    let call;
    const result = runResolvedDsh({ command: process.execPath, args: ['fake-entry.js'] }, ['plugin', '--profile', 'dsh-crew'], {
      home: t.dir,
      runner: (command, args, options) => { call = { command, args, options }; return { status: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(result.ok, true);
    assert.equal(call.options.env.DSH_HOME, join(t.dir, '.config', 'dsh-crew', 'harness'));
    assert.ok(call.args.includes('dsh-crew'));
    assert.ok(!call.args.includes('web'));
  } finally { t.cleanup(); }
});

test('offline Crew registration is loader-visible and idempotent', () => {
  const t = tempHome();
  try {
    const root = pluginRoot(t.dir);
    const first = ensureCrewPluginRegistration({ home: t.dir, root });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.changed, true);
    assert.equal(realpathSync(first.linkPath), realpathSync(root));
    assert.equal(realpathSync(first.resolvedEntry), realpathSync(join(root, 'index.js')));
    const profile = JSON.parse(readFileSync(first.profileManifest, 'utf8'));
    assert.deepEqual(profile.dsh.profile.bundles.slice(0, 2), [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ]);
    assert.equal(profile.dependencies['@ran-test/dsh-crew'], `link:${root.replace(/\\/g, '/')}`);
    assert.equal(profile.dsh.profile.bundles.filter((name) => name === '@ran-test/dsh-crew').length, 1);

    const second = ensureCrewPluginRegistration({ home: t.dir, root });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.changed, false);
    assert.equal(realpathSync(second.linkPath), realpathSync(root));
  } finally { t.cleanup(); }
});

test('offline Crew registration replaces a stale link while preserving unrelated profile state', () => {
  const t = tempHome();
  try {
    const firstRoot = pluginRoot(join(t.dir, 'first'));
    const secondRoot = pluginRoot(join(t.dir, 'second'));
    const profileDir = join(t.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-dsh-crew',
      private: true,
      dependencies: { '@deepseek-ai/dsh-base': '9.8.7-preserve-me', '@ran-test/other': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@ran-test/other'] } },
    }, null, 2));
    const first = ensureCrewPluginRegistration({ home: t.dir, root: firstRoot });
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = ensureCrewPluginRegistration({ home: t.dir, root: secondRoot });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(realpathSync(second.linkPath), realpathSync(secondRoot));
    const profile = JSON.parse(readFileSync(second.profileManifest, 'utf8'));
    assert.equal(profile.dependencies['@deepseek-ai/dsh-base'], '9.8.7-preserve-me');
    assert.equal(profile.dependencies['@ran-test/other'], '1.0.0');
    assert.deepEqual(profile.dsh.profile.bundles.slice(0, 2), ['@deepseek-ai/dsh-base', '@ran-test/other']);
    assert.equal(profile.dsh.profile.bundles.filter((name) => name === '@ran-test/dsh-crew').length, 1);
  } finally { t.cleanup(); }
});

test('Crew registration reconciles tombstoned provider declarations before profile use', () => {
  const t = tempHome();
  try {
    const root = pluginRoot(t.dir);
    const first = ensureCrewPluginRegistration({ home: t.dir, root });
    assert.equal(first.ok, true, JSON.stringify(first));
    writeFileSync(join(first.profileRoot, 'cordis.patch.yml'), `- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        displayName: OpenCode Go\n      openrouter:\n        displayName: openrouter\n`);
    writeFileSync(join(t.dir, '.config', 'dsh-crew', 'provider-lifecycle.json'), JSON.stringify({ tombstones: { 'opencode-go': 'absent' } }));
    const repaired = ensureCrewPluginRegistration({ home: t.dir, root });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(repaired.changed, true);
    const patch = readFileSync(join(first.profileRoot, 'cordis.patch.yml'), 'utf8');
    assert.equal(patch.includes('opencode-go:'), false);
    assert.equal(patch.includes('openrouter:'), true);
    const secondRepair = ensureCrewPluginRegistration({ home: t.dir, root });
    assert.equal(secondRepair.ok, true, JSON.stringify(secondRepair));
    const patchAfterSecondRepair = readFileSync(join(first.profileRoot, 'cordis.patch.yml'), 'utf8');
    assert.equal(patchAfterSecondRepair.includes('opencode-go:'), false);
  } finally { t.cleanup(); }
});

test('tombstoned providers stay absent across repeated restarts and update repair activation', () => {
  const t = tempHome();
  try {
    const root = pluginRoot(t.dir);
    const first = ensureCrewPluginRegistration({ home: t.dir, root });
    assert.equal(first.ok, true, JSON.stringify(first));
    const patchFile = join(first.profileRoot, 'cordis.patch.yml');
    const declared = `- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        displayName: OpenCode Go\n        apiKeyEnv: OPENCODE_GO_API_KEY\n      openrouter:\n        displayName: openrouter\n`;
    writeFileSync(patchFile, declared);
    writeFileSync(join(t.dir, '.config', 'dsh-crew', 'provider-lifecycle.json'), JSON.stringify({
      schema_version: 1, tombstones: { 'opencode-go': 'absent' }, transactions: {}, last_verified_revision: {},
    }));

    const assertAbsent = () => {
      const text = readFileSync(patchFile, 'utf8');
      assert.equal(text.includes('opencode-go:'), false);
      assert.equal(text.includes('openrouter:'), true);
      const lifecycle = JSON.parse(readFileSync(join(t.dir, '.config', 'dsh-crew', 'provider-lifecycle.json'), 'utf8'));
      assert.equal(lifecycle.tombstones['opencode-go'], 'absent');
    };

    // Restart #1: the registration path must reconcile before the profile is used.
    assert.equal(ensureCrewPluginRegistration({ home: t.dir, root }).ok, true);
    assertAbsent();
    // Restart #2: absence and tombstone must remain stable.
    assert.equal(ensureCrewPluginRegistration({ home: t.dir, root }).ok, true);
    assertAbsent();
    // Update/repair activation may reintroduce shipped declarations; reconciliation
    // must remove the tombstoned provider again without touching retained providers.
    writeFileSync(patchFile, declared);
    assert.equal(ensureCrewPluginRegistration({ home: t.dir, root }).ok, true);
    assertAbsent();
    writeFileSync(patchFile, declared);
    assert.equal(ensureCrewPluginRegistration({ home: t.dir, root }).ok, true);
    assertAbsent();
  } finally { t.cleanup(); }
});

test('offline Crew registration fails closed on malformed metadata and link conflicts', () => {
  const malformed = tempHome();
  try {
    const root = pluginRoot(malformed.dir);
    const profileDir = join(malformed.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: [] }));
    const result = ensureCrewPluginRegistration({ home: malformed.dir, root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CREW_PROFILE_METADATA_INVALID');
  } finally { malformed.cleanup(); }

  const conflict = tempHome();
  try {
    const root = pluginRoot(conflict.dir);
    const profileDir = join(conflict.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew');
    const linkDir = join(profileDir, 'node_modules', '@ran-test', 'dsh-crew');
    mkdirSync(linkDir, { recursive: true });
    writeFileSync(join(linkDir, 'do-not-delete.txt'), 'user-owned\n');
    const result = ensureCrewPluginRegistration({ home: conflict.dir, root });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CREW_PLUGIN_LINK_CONFLICT');
    assert.equal(existsSync(join(linkDir, 'do-not-delete.txt')), true);
  } finally { conflict.cleanup(); }
});

// A profile first created against a source checkout records its bundles as
// links into that checkout. Switching the CLI to another cohort leaves those
// links behind, and they shadow the cohort installed beside the profile — the
// host then composes the web app of one cohort while the client plugin table
// comes from another, and the mismatched plugin dies at require time.
function seedBundle(dir, name, version) {
  const moduleDir = join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({ name, version }, null, 2));
  return moduleDir;
}

test('a foreign-cohort profile bundle is unshadowed so the CLI cohort resolves', () => {
  const t = tempHome();
  try {
    const profileDir = join(t.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew');
    mkdirSync(profileDir, { recursive: true });
    // Stale shadow recorded by the source cohort.
    const stale = seedBundle(profileDir, '@deepseek-ai/dsh-web-app', '0.1.3-alpha.1');
    // Correct cohort installed beside the profile, as the runtime tree provides.
    seedBundle(dirname(profileDir), '@deepseek-ai/dsh-web-app', TARGET_DSH_VERSION);
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-dsh-crew',
      private: true,
      dependencies: { '@deepseek-ai/dsh-web-app': 'workspace:*' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, null, 2));

    const result = reconcileProfileBundleCohort({ home: t.dir, profileRoot: profileDir });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.changed, true);
    assert.deepEqual(result.unshadowed, [{ bundle: '@deepseek-ai/dsh-web-app', shadowed: '0.1.3-alpha.1' }]);
    assert.equal(existsSync(stale), false, 'the foreign-cohort shadow must be gone');
    // The cohort beside the profile is now what a require resolves.
    assert.equal(
      resolveNearestBundleVersion(dirname(profileDir), '@deepseek-ai/dsh-web-app'),
      TARGET_DSH_VERSION,
    );
  } finally { t.cleanup(); }
});

test('a profile bundle already on the target cohort is left untouched', () => {
  const t = tempHome();
  try {
    const profileDir = join(t.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew');
    const current = seedBundle(profileDir, '@deepseek-ai/dsh-base', TARGET_DSH_VERSION);
    const result = reconcileProfileBundleCohort({ home: t.dir, profileRoot: profileDir });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.changed, false);
    assert.deepEqual(result.unshadowed, []);
    assert.equal(existsSync(current), true);
  } finally { t.cleanup(); }
});

// A profile deliberately tracking another cohort keeps its links: removing them
// without a proven target-cohort fallthrough would silently change what runs.
test('a foreign-cohort bundle without a target fallthrough is skipped, never removed', () => {
  const t = tempHome();
  try {
    const profileDir = join(t.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew');
    const deliberate = seedBundle(profileDir, '@deepseek-ai/dsh-base', '9.9.9-pinned-on-purpose');
    const result = reconcileProfileBundleCohort({ home: t.dir, profileRoot: profileDir });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.changed, false);
    assert.deepEqual(result.unshadowed, []);
    assert.deepEqual(result.skipped, [{
      bundle: '@deepseek-ai/dsh-base',
      shadowed: '9.9.9-pinned-on-purpose',
      fallthrough: null,
    }]);
    assert.equal(existsSync(deliberate), true, 'a deliberate cohort pin must survive');
  } finally { t.cleanup(); }
});

test('an unshadow that cannot be verified after removal fails closed', () => {
  const t = tempHome();
  try {
    const profileDir = join(t.dir, '.config', 'dsh-crew', 'harness', 'profiles', 'dsh-crew');
    seedBundle(profileDir, '@deepseek-ai/dsh-base', '0.0.1-other');
    seedBundle(dirname(profileDir), '@deepseek-ai/dsh-base', TARGET_DSH_VERSION);
    const result = reconcileProfileBundleCohort({
      home: t.dir,
      profileRoot: profileDir,
      remove: () => {}, // pretend the deletion silently did nothing
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PROFILE_BUNDLE_UNSHADOW_FAILED');
  } finally { t.cleanup(); }
});

test('offline Crew registration removal is symmetric, safe, and idempotent', () => {
  const t = tempHome();
  try {
    const root = pluginRoot(t.dir);
    const first = ensureCrewPluginRegistration({ home: t.dir, root });
    assert.equal(first.ok, true, JSON.stringify(first));
    const profileBefore = JSON.parse(readFileSync(first.profileManifest, 'utf8'));
    profileBefore.dependencies['@ran-test/other'] = '1.0.0';
    profileBefore.dsh.profile.bundles.unshift('@ran-test/other');
    writeFileSync(first.profileManifest, JSON.stringify(profileBefore, null, 2));

    const removed = removeCrewPluginRegistration({ home: t.dir, name: '@ran-test/dsh-crew' });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    assert.equal(removed.removed, true);
    assert.equal(existsSync(first.linkPath), false);
    const profileAfter = JSON.parse(readFileSync(first.profileManifest, 'utf8'));
    assert.equal(profileAfter.dependencies['@ran-test/dsh-crew'], undefined);
    assert.equal(profileAfter.dependencies['@ran-test/other'], '1.0.0');
    assert.deepEqual(profileAfter.dsh.profile.bundles, [
      '@ran-test/other',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ]);
    const second = removeCrewPluginRegistration({ home: t.dir, name: '@ran-test/dsh-crew' });
    assert.deepEqual(second, { ok: true, removed: false });
  } finally { t.cleanup(); }
});
