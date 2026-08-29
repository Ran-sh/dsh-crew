import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('all Worker host adapters mark explicitly read-only jobs as verified no-change workflows', () => {
  for (const path of [
    '../agents/ds-worker.md',
    '../codex/agents/ds-worker.toml',
    '../zcode/agents/ds-worker.md',
  ]) {
    const dispatcher = read(path);
    assert.match(dispatcher, /allow_no_changes:\s*true/, path);
    assert.match(dispatcher, /explicit(?:ly)?[^\n]*read-only/i, path);
  }
});
