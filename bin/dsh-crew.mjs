#!/usr/bin/env node
// dsh-crew CLI entry for the packaged npm payload.
//
//   npx @ran-sh/dsh-crew@latest install|status|update|uninstall
//   npm exec --package=@ran-sh/dsh-crew@latest -- dsh-crew status
//
// The lifecycle implementation lives in src/install/npx-lifecycle.mjs so the
// commands are testable in-process; this wrapper only dispatches.

import { runNpxCli } from '../src/install/npx-lifecycle.mjs';

process.exitCode = await runNpxCli();
