import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const workerSource = readFileSync(join(ROOT, 'worker.cordis.yml'), 'utf8');
const jobsSource = readFileSync(join(ROOT, 'src', 'jobs.mjs'), 'utf8');
// Top-level rows (no leading indent) override base rows; indented rows under
// `- insert:` add Crew-only rows.
const workerIds = [...workerSource.matchAll(/^ *- id: ([A-Za-z0-9_/-]+)/gm)].map((m) => m[1]);
const insertSection = workerSource.slice(workerSource.indexOf('- insert:'));
const insertIds = [...insertSection.matchAll(/^ + *- id: ([A-Za-z0-9_/-]+)/gm)].map((m) => m[1]);
const overrideIds = workerIds.filter((id) => !insertIds.includes(id));

// Fixed alpha.5 sdk-minimal base rows (from the published cordis.patch.yml).
// Any non-insert overlay row must hit one of these, otherwise the patch would
// silently add a second row instead of overriding the base config.
const SDK_MINIMAL_BASE_IDS = new Set([
  'sdk-app-startup',
  'sdk-jsonrpc-server',
  'deepseek-llm-api-extensions',
  'session-log-deepseek',
  'plugin-package-inventory-deepseek',
  'llm-deepseek',
  'sandbox',
  'session-projection',
  'sandbox-policy',
  'subprocess',
  'pty',
  'terminal-bash',
  'terminal-pwsh',
  'fs-local',
  'timer',
  'llm',
  'session',
  'session-title',
  'system-prompt',
  'tools',
  'agent',
  'llm-retry',
  'jobs',
  'invariants',
  'session-invariant',
  'agent-invariant',
  'scope-invariant',
  'agent-loop-invariant',
  'agent-loop',
  'persistent-bash',
  'persistent-pwsh',
  'str-replace-editor',
  'sessions',
]);

test('worker overlay top-level rows all hit sdk-minimal base ids', () => {
  assert.deepEqual(
    [...overrideIds].sort(),
    ['agent-loop', 'fs-local', 'llm-deepseek', 'sandbox-policy', 'sdk-jsonrpc-server', 'sessions', 'system-prompt'],
    'overlay overrides must be exactly the 7 sdk-minimal base rows',
  );
  for (const id of overrideIds) {
    assert.ok(SDK_MINIMAL_BASE_IDS.has(id), `overlay row ${id} has no sdk-minimal base row to override`);
  }
});

test('worker overlay carries no removed-package rows', () => {
  assert.doesNotMatch(workerSource, /agent-spine-demo/);
  assert.doesNotMatch(workerSource, /sdk-jsonrpc-demo/);
  assert.doesNotMatch(workerSource, /client-runtime/);
});

test('worker overlay covers the mandatory agent kernel rows', () => {
  assert.deepEqual(
    [...insertIds].sort(),
    ['compaction-basic', 'fs-observation-policy', 'token-meter', 'tool-fs', 'tool-todo'],
    'overlay inserts must be exactly the 5 Crew-only rows',
  );
});

test('jobs.mjs uses SDK-native launch without explicit dshBin', () => {
  assert.doesNotMatch(jobsSource, /dshBin:\s*\w/);
  assert.doesNotMatch(jobsSource, /AGENT_JS|jsonrpc-demo/);
  assert.match(jobsSource, /profile: 'sdk-minimal'/);
  assert.match(jobsSource, /patches: \[CORDIS\]/);
  assert.match(jobsSource, /dshHome: CREW_DSH_HOME/);
  assert.match(jobsSource, /reasoningEffort: effort/);
});
