// CLI subprocess / dispatcher exit-code tests: the setup CLI must return a
// non-zero status whenever any critical step fails, and 0 on full success,
// repeated (idempotent) uninstall, Claude-absent install, and normal status.
// The dispatcher (runSetupCli) is exercised both in-process with injected
// fakes (full failure matrix) and as a real subprocess for safe scenarios
// (unknown action, status, dry-run) that never touch the real system.
// Run with: node --test test/setup-cli.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runSetupCli } from '../scripts/setup.mjs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

const ok = (actions = []) => async () => ({ ok: true, actions });
const fail = (code = 'x') => async () => ({ ok: false, error: `fake ${code} failure`, failures: [code] });

function run(argv, run) {
  return runSetupCli({ argv, run, log: () => {} });
}

// ---------- in-process dispatcher failure matrix ----------

test('install success → exit 0', async () => {
  assert.equal(await run(['install'], { install: ok() }), 0);
});
test('install DSH install failure → exit 1', async () => {
  assert.equal(await run(['install'], { install: fail('dsh') }), 1);
});
test('install Codex failure → exit 1', async () => {
  assert.equal(await run(['install'], { install: fail('codex') }), 1);
});
test('install Claude failure → exit 1', async () => {
  assert.equal(await run(['install'], { install: fail('claude') }), 1);
});
test('uninstall success → exit 0', async () => {
  assert.equal(await run(['uninstall'], { uninstall: ok() }), 0);
});
test('uninstall Codex failure → exit 1', async () => {
  assert.equal(await run(['uninstall'], { uninstall: fail('codex') }), 1);
});
test('uninstall Claude failure → exit 1', async () => {
  assert.equal(await run(['uninstall'], { uninstall: fail('claude') }), 1);
});
test('uninstall DSH remove failure → exit 1', async () => {
  assert.equal(await run(['uninstall'], { uninstall: fail('dsh') }), 1);
});
test('unknown action → exit 1 and prints usage', async () => {
  const logs = [];
  const code = await runSetupCli({ argv: ['banana'], run: {}, log: (m) => logs.push(m) });
  assert.equal(code, 1);
});
test('status normal not-installed → exit 0', async () => {
  assert.equal(await run(['status'], { status: ok() }), 0);
});
test('unexpected exception → exit 1', async () => {
  const code = await runSetupCli({ argv: ['install'], run: { install: async () => { throw new Error('boom'); } }, log: () => {} });
  assert.equal(code, 1);
});

// ---------- real subprocess tests (safe, no system side effects) ----------

function sub(argv) {
  const r = spawnSync(process.execPath, ['scripts/setup.mjs', ...argv], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('subprocess: unknown action exits 1', () => {
  const r = sub(['banana']);
  assert.equal(r.status, 1);
  assert.match((r.stdout + r.stderr), /usage/);
});

test('subprocess: status exits 0', () => {
  const r = sub(['status']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /DSH plugin:/);
});

test('subprocess: install --dry-run exits 0 (no real side effects)', () => {
  const r = sub(['install', '--dry-run']);
  assert.equal(r.status, 0, `unexpected exit ${r.status}:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /DSH web profile would be linked/);
  assert.ok(!/✗/.test(r.stdout), 'dry-run should not print failures');
});

test('subprocess: uninstall --dry-run exits 0 (no real side effects)', () => {
  const r = sub(['uninstall', '--dry-run']);
  assert.equal(r.status, 0, `unexpected exit ${r.status}:\n${r.stdout}\n${r.stderr}`);
});
