// Point a test process at a disposable home.
//
// The Hub records session provenance in `~/.config/dsh-crew/session-origins.jsonl`
// when it dispatches a job, and the path is resolved from the home directory at
// call time. A test that reaches that dispatch path therefore appends to the
// operator's real Crew state — and, because the history service hashes that
// ledger into its plan revision, it also invalidates a concurrent cleanup plan,
// which is how it surfaced: as an intermittent HISTORY_PREVIEW_CHANGED under
// parallel CI load rather than as an obvious write to the wrong place.
//
// `node --test` gives each test file its own process, so redirecting the home
// here cannot leak into another file. Import this before the modules under test.
//
// This is the same failure the CODEX_HOME guard covers for the host
// integrations: a test that resolves ambient state writes to a real machine.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-crew-test-home-'));

// Both spellings: Node reads $HOME on POSIX and %USERPROFILE% on Windows.
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

process.once('exit', () => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});
