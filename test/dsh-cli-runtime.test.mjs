import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DSH_CLI_PACKAGE,
  crewDshRuntimeModule,
  crewDshRuntimeRoot,
  resolveDshCli,
  ensureCrewDshRuntime,
  buildDshInvocation,
  runResolvedDsh,
  quoteWindowsArg,
} from '../src/dsh-cli-runtime.mjs';

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-runtime-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
        writeFileSync(join(entry, '..', '..', 'package.json'), JSON.stringify({ name: DSH_CLI_PACKAGE, version: '1.2.3-test' }));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.cli.kind, 'crew-runtime');
    assert.equal(result.version, '1.2.3-test');
    assert.equal(invocation.args.includes(crewDshRuntimeRoot({ home: t.dir })), true);
    assert.equal(invocation.args.at(-1), DSH_CLI_PACKAGE);
    assert.equal(invocation.options.env.DSH_HOME, undefined);
    assert.equal(existsSync(crewDshRuntimeRoot({ home: t.dir })), true);
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
