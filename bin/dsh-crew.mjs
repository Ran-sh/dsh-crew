#!/usr/bin/env node
// dsh-crew CLI entry for the packaged npm payload.
//
//   npx @ran-sh/dsh-crew@latest install|status|update|uninstall
//   npm exec --package=@ran-sh/dsh-crew@latest -- dsh-crew status
//
// The lifecycle implementation lives in src/install/npx-lifecycle.mjs so the
// commands are testable in-process; this wrapper only dispatches.

import { runNpxCli } from '../src/install/npx-lifecycle.mjs';

if (process.argv[2] === 'history' && process.argv[3] === 'recover') {
  const { runProductionHistory } = await import('../src/history/runner.mjs');
  try { await runProductionHistory({ recover: true }); console.log('History maintenance recovered.'); }
  catch { console.error('HISTORY_RECOVERY_REQUIRED: recovery did not complete; data and maintenance evidence were retained.'); process.exitCode = 1; }
} else process.exitCode = await runNpxCli();
