import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewTask } from '../src/information-flow.mjs';

test('automatic review receives a bounded evidence capsule, not worker prose or patch', () => {
  const prompt = buildReviewTask('Implement the requested change', {
    outcome: {
      task_status: 'success',
      tests_status: 'PASS',
      changes: ['src/a.mjs — changed'],
      tests: [{ status: 'PASS', command: 'node --test', summary: 'ok' }],
      risks: ['none'],
      delivery: { complete: true },
    },
    candidate: {
      changed_files: ['src/a.mjs'],
      base_revision: 'abc123',
      fingerprint: 'fp-1',
      patch: 'SECRET_PATCH_SENTINEL',
    },
    raw_result: 'SECRET_WORKER_PROSE_SENTINEL',
  });

  assert.match(prompt, /Implement the requested change/);
  assert.match(prompt, /task_status=success/);
  assert.match(prompt, /src\/a\.mjs/);
  assert.match(prompt, /abc123/);
  assert.match(prompt, /inspect the candidate directly/i);
  assert.doesNotMatch(prompt, /SECRET_PATCH_SENTINEL/);
  assert.doesNotMatch(prompt, /SECRET_WORKER_PROSE_SENTINEL/);
});

test('automatic review bounds oversized objectives and evidence lists', () => {
  const prompt = buildReviewTask(`objective-${'x'.repeat(20_000)}`, {
    outcome: {
      task_status: 'success', tests_status: 'PASS', delivery: { complete: true },
      changes: Array.from({ length: 500 }, (_, i) => `change-${i}`),
      tests: [], risks: [],
    },
    candidate: {
      changed_files: Array.from({ length: 500 }, (_, i) => `src/file-${i}.mjs`),
      base_revision: 'abc123', fingerprint: 'fp-1', patch: 'p'.repeat(100_000),
    },
  });

  assert.ok(prompt.length < 12_000, `review prompt should stay bounded, got ${prompt.length}`);
  assert.match(prompt, /truncated/i);
  assert.doesNotMatch(prompt, /src\/file-499\.mjs/);
});

