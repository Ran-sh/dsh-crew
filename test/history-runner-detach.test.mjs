import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHER = fileURLToPath(new URL('../src/history/runner-detach.mjs', import.meta.url));

// The maintenance runner stops 3210, rewrites the session store, then starts it
// again, so it has to outlive the hub. The supervisor stops a service by killing
// its whole tracked process tree, and that tree is walked through
// ParentProcessId — so a runner spawned directly by the hub is killed by the very
// stop it requested and the transaction strands in STOPPING. This pins the
// property that keeps the runner out of that tree: it is parented to a launcher
// that has already exited, and never to the process that asked for it.
test('the maintenance runner is not parented to the process that launched it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-detach-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = join(dir, 'probe.mjs');
  const out = join(dir, 'out.json');
  writeFileSync(probe, 'import { writeFileSync } from \'node:fs\';\n'
    + 'writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, ppid: process.ppid }));\n');

  const launcher = spawn(process.execPath, [LAUNCHER, probe, out], { stdio: 'ignore' });
  const launcherPid = launcher.pid;
  const exited = new Promise((resolve) => launcher.once('exit', resolve));

  const deadline = Date.now() + 20000;
  while (!existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(out), 'the detached runner never ran');
  const report = JSON.parse(readFileSync(out, 'utf8'));

  assert.notEqual(report.pid, launcherPid, 'the runner must be its own process');
  assert.notEqual(report.ppid, process.pid, 'the runner must not be parented to its launcher');
  assert.equal(report.ppid, launcherPid, 'the runner is parented to the intermediate launcher');
  await exited;
  assert.equal(launcher.exitCode, 0, 'the launcher exits cleanly once the runner exists');

  // The parent being gone is what removes the runner from the supervisor's
  // process-tree walk; a live parent would put it back in the kill set.
  let parentAlive = true;
  try { process.kill(report.ppid, 0); } catch { parentAlive = false; }
  assert.equal(parentAlive, false, 'the runner parent must have exited');
});
