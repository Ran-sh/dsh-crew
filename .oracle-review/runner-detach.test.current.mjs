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
  await exited;
  assert.equal(launcher.exitCode, 0, 'the launcher exits cleanly once the runner exists');

  // How "the launcher has already exited" looks differs by platform, and the
  // assertion has to follow the property rather than one mechanism: Windows
  // keeps the dead launcher's pid as the parent, while POSIX reparents the
  // orphan to init immediately. Asserting the Windows shape fails on Linux for
  // a reason that has nothing to do with the guarantee.
  if (process.platform === 'win32') {
    // The parent link still names the launcher, and that process is gone —
    // which is what stops the supervisor's walk from reaching the runner.
    assert.equal(report.ppid, launcherPid, 'the runner is parented to the intermediate launcher');
    let parentAlive = true;
    try { process.kill(report.ppid, 0); } catch { parentAlive = false; }
    assert.equal(parentAlive, false, 'the runner parent must have exited');
  } else {
    // Reparenting happens when the launcher exits, and the probe may have run
    // just before or just after that, so accept either: init, or the launcher
    // pid. Both mean the same thing — the parent is not a live ancestor of the
    // process that requested the work, so the supervisor's walk cannot reach
    // the runner. Asserting only `1` would flake on that race.
    assert.ok(report.ppid === 1 || report.ppid === launcherPid,
      `unexpected parent ${report.ppid}; expected init (1) or the launcher (${launcherPid})`);
    if (report.ppid === launcherPid) {
      let parentAlive = true;
      try { process.kill(report.ppid, 0); } catch { parentAlive = false; }
      assert.equal(parentAlive, false, 'the launcher must have exited');
    }
  }
});
