// Detach the history maintenance runner from the hub's process tree.
//
// The runner must outlive the hub it is maintaining: its transaction stops 3210,
// rewrites the session store while nothing holds it, then starts 3210 again. The
// supervisor stops a service by killing that service's whole tracked process
// tree, and the tree is walked through `ParentProcessId`. A runner spawned
// directly by the hub is therefore inside the tree and is killed by the very stop
// it requested, leaving the transaction stranded in STOPPING with a stale update
// lock and no operator-side way to finish it.
//
// This launcher is the intermediate: it starts the runner, confirms the process
// exists, and exits immediately. The runner's parent is then a process that no
// longer exists, so the supervisor's tree walk cannot reach it and it survives.
//
// Usage: node runner-detach.mjs <runnerPath> [...runnerArgs]
import { spawn } from 'node:child_process';

const [runnerPath, ...runnerArgs] = process.argv.slice(2);
if (!runnerPath) {
  process.stderr.write('runner-detach: missing runner path\n');
  process.exit(2);
}

const child = spawn(process.execPath, [runnerPath, ...runnerArgs], {
  detached: true,
  windowsHide: true,
  stdio: 'ignore',
  env: { ...process.env },
});
child.once('error', () => process.exit(1));
child.once('spawn', () => {
  child.unref();
  process.exit(0);
});
