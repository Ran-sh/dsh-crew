// Pure unit tests for the auditable worker delivery contract (src/delivery.mjs):
// the shared instruction builder, the idempotent prompt appender, and the
// parse / validate / format pipeline. No DSH, no worker runtime, no I/O.
//
// Run with: node --test test/delivery.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeliveryInstructions,
  appendDeliveryInstructions,
  parseDeliveryReport,
  validateDeliveryReport,
  formatDeliveryMetadata,
  DELIVERY_SECTIONS,
  OPTIONAL_DELIVERY_SECTIONS,
  REVIEW_SECTIONS,
  DELIVERY_MARKER,
} from '../src/delivery.mjs';
import { jobView } from '../src/jobs.mjs';
import { WorkerRegistry } from '../src/hub/index.mjs';

// ---------- buildDeliveryInstructions ----------

test('coding instructions mandate Diff / Tests / Risks and omit Unverified as mandatory', () => {
  const t = buildDeliveryInstructions({ tier: 'flash' });
  assert.match(t, /## Diff/);
  assert.match(t, /## Tests/);
  assert.match(t, /## Risks/);
  assert.match(t, /\(Optional/);
  assert.match(t, /FLASH/);
  assert.doesNotMatch(t, /Review Findings/);
});

test('review instructions use the review contract, not Diff/Tests', () => {
  const t = buildDeliveryInstructions({ tier: 'pro', isReview: true });
  assert.match(t, /## Review Findings/);
  assert.match(t, /## Evidence/);
  assert.match(t, /## Verdict/);
  assert.match(t, /## Risks/);
  assert.doesNotMatch(t, /## Diff/);
  assert.doesNotMatch(t, /## Tests/);
});

test('tier is stamped into the coding header', () => {
  assert.match(buildDeliveryInstructions({ tier: 'pro' }), /PRO/);
  assert.match(buildDeliveryInstructions({ tier: 'flash' }), /FLASH/);
});

// ---------- appendDeliveryInstructions ----------

test('appendDeliveryInstructions adds the contract to a plain task', () => {
  const out = appendDeliveryInstructions('implement X', { tier: 'flash' });
  assert.ok(out.startsWith('implement X'));
  assert.match(out, /# Delivery report/);
});

test('appendDeliveryInstructions is idempotent (no doubling on re-dispatch)', () => {
  const first = appendDeliveryInstructions('implement X', { tier: 'flash' });
  const second = appendDeliveryInstructions(first, { tier: 'flash' });
  assert.equal(second, first);
});

test('appendDeliveryInstructions appends the review contract for review tasks', () => {
  const out = appendDeliveryInstructions('review the diff', { tier: 'pro', isReview: true });
  assert.match(out, /## Review Findings/);
});

test('appendDeliveryInstructions leaves non-strings untouched', () => {
  assert.equal(appendDeliveryInstructions(undefined), undefined);
  assert.equal(appendDeliveryInstructions(null), null);
});

// ---------- parseDeliveryReport ----------

function codingReport() {
  return [
    'did the work',
    '',
    '## Diff',
    'src/a.mjs — fixed the bug',
    '',
    '## Tests',
    'PASS — node --test — passed',
    '',
    '## Risks',
    'none',
    '',
    '## Unverified',
    'not tested on Windows',
  ].join('\n');
}

test('coding report parses complete with all mandatory sections', () => {
  const r = parseDeliveryReport(codingReport());
  assert.equal(r.format, 'coding');
  assert.equal(r.complete, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.sections.Diff, 'src/a.mjs — fixed the bug');
  assert.deepEqual(r.sections.Unverified, 'not tested on Windows');
});

test('missing mandatory sections → complete false and named in missing', () => {
  const text = ['## Diff', 'x', '', '## Tests', ''].join('\n');
  const r = parseDeliveryReport(text);
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, ['Tests', 'Risks']);
  assert.equal(r.sections.Tests, '');
});

test('Flash coding prompt returns control to Main without automatic Pro work', () => {
  const instructions = buildDeliveryInstructions({ tier: 'flash' });
  assert.match(instructions, /Implement only the delegated coding scope/);
  assert.match(instructions, /stop and return control to the Main Agent/);
  assert.doesNotMatch(instructions, /automatic Pro review/i);
});

test('coding headings are case-insensitive and canonicalized', () => {
  const r = parseDeliveryReport('## diff\na.mjs\n## TESTS\nPASS — node --test — passed\n## risks\nnone');
  assert.equal(r.complete, true);
  assert.deepEqual(r.present, ['Diff', 'Tests', 'Risks']);
  assert.equal(r.sections.Tests, 'PASS — node --test — passed');
});

test('Tests requires PASS, FAIL, or NOT RUN and rejects none', () => {
  const none = parseDeliveryReport('## Diff\na.mjs\n## Tests\nnone\n## Risks\nnone');
  assert.equal(none.complete, false);
  assert.deepEqual(none.missing, ['Tests']);
  const failed = parseDeliveryReport('## Diff\na.mjs\n## Tests\nFAIL — pnpm test — two failures\n## Risks\nknown');
  assert.equal(failed.complete, true, 'a reported test failure is still a complete delivery report');
  assert.equal(failed.tests_status, 'FAIL');
  const bulleted = parseDeliveryReport('## Diff\na.mjs\n## Tests\n- NOT RUN — pnpm test — unavailable\n- PASS — file check — ok\n## Risks\nnone');
  assert.equal(bulleted.complete, true);
  assert.equal(bulleted.tests_status, 'NOT RUN');
  const mixed = parseDeliveryReport('## Diff\na.mjs\n## Tests\nPASS — unit — ok\nFAIL — integration — broke\n## Risks\nknown');
  assert.equal(mixed.complete, true);
  assert.equal(mixed.tests_status, 'FAIL');
  const malformed = parseDeliveryReport('## Diff\na.mjs\n## Tests\nPASS — unit — ok\nintegration not checked\n## Risks\nknown');
  assert.equal(malformed.complete, false);
  assert.deepEqual(malformed.missing, ['Tests']);
  const missingResult = parseDeliveryReport('## Diff\na.mjs\n## Tests\nPASS — unit\n## Risks\nnone');
  assert.equal(missingResult.complete, false);
  assert.deepEqual(missingResult.missing, ['Tests']);
});

test('empty / absent report is incomplete with all mandatory sections missing', () => {
  for (const text of ['', '   ', 'just a chatty summary without headings']) {
    const r = parseDeliveryReport(text);
    assert.equal(r.complete, false);
    assert.deepEqual(r.missing, DELIVERY_SECTIONS);
  }
});

test('review report parses complete with the review contract', () => {
  const text = [
    '## Review Findings',
    'looks good',
    '',
    '## Evidence',
    'checked src/a.mjs',
    '',
    '## Risks',
    'none',
    '',
    '## Verdict',
    'approved',
  ].join('\n');
  const r = parseDeliveryReport(text);
  assert.equal(r.format, 'review');
  assert.equal(r.complete, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.sections.Verdict, 'approved');
});

test('review report with a missing verdict is incomplete from the review contract', () => {
  const text = ['## Review Findings', 'ok', '', '## Evidence', 'saw it', '', '## Risks', 'none'].join('\n');
  const r = parseDeliveryReport(text);
  assert.equal(r.format, 'review');
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, ['Verdict']);
});

test('report headings are detected only as line-start ## headings', () => {
  const text = 'some ## Diff inline mention\n## Tests\nPASS — node --test — passed\n## Risks\nnone';
  const r = parseDeliveryReport(text);
  assert.equal(r.present.includes('Diff'), false); // inline, not a heading
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, ['Diff']);
});

test('non-string report input is handled without throwing', () => {
  assert.doesNotThrow(() => parseDeliveryReport(undefined));
  assert.doesNotThrow(() => parseDeliveryReport(42));
  const r = parseDeliveryReport(null ?? undefined);
  assert.equal(r.complete, false);
});

// ---------- validateDeliveryReport ----------

test('validateDeliveryReport agrees with parse on complete and missing reports', () => {
  assert.equal(validateDeliveryReport(codingReport()).ok, true);
  const bad = validateDeliveryReport('## Diff\nx');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ['Tests', 'Risks']);
  assert.deepEqual(validateDeliveryReport(parseDeliveryReport(codingReport())).missing, []);
});

// ---------- formatDeliveryMetadata ----------

test('formatDeliveryMetadata gives bounded snippets plus complete flag', () => {
  const md = formatDeliveryMetadata(parseDeliveryReport(codingReport()));
  assert.equal(md.complete, true);
  assert.equal(md.tests_status, 'PASS');
  assert.equal(md.diff, 'src/a.mjs — fixed the bug');
  assert.equal(md.unverified, 'not tested on Windows');
  assert.equal('missing' in md, false);
});

test('formatDeliveryMetadata preserves aggregate coding test status only for valid coding reports', () => {
  const notRun = formatDeliveryMetadata(parseDeliveryReport('## Diff\na.mjs\n## Tests\nPASS — unit — ok\nNOT RUN — integration — unavailable\n## Risks\nnone'));
  assert.equal(notRun.complete, true);
  assert.equal(notRun.tests_status, 'NOT RUN');

  const failed = formatDeliveryMetadata(parseDeliveryReport('## Diff\na.mjs\n## Tests\nPASS — unit — ok\nFAIL — integration — broke\n## Risks\nknown'));
  assert.equal(failed.complete, true);
  assert.equal(failed.tests_status, 'FAIL');

  const invalid = formatDeliveryMetadata(parseDeliveryReport('## Diff\na.mjs\n## Tests\nPASS — unit\n## Risks\nnone'));
  assert.equal(invalid.complete, false);
  assert.equal('tests_status' in invalid, false);
});

test('formatDeliveryMetadata clips long sections and names missing ones', () => {
  const text = ['## Diff', 'a'.repeat(1000), '', '## Tests', 'PASS — check — ok', '', '## Risks', ''].join('\n');
  const md = formatDeliveryMetadata(parseDeliveryReport(text), { limit: 20 });
  assert.equal(md.complete, false);
  assert.deepEqual(md.missing, ['Risks']);
  assert.ok(String(md.diff).length <= 25); // clipped + ellipsis
});

test('formatDeliveryMetadata maps review sections onto findings/evidence/verdict keys', () => {
  const text = ['## Review Findings', 'ok', '', '## Evidence', 'saw', '', '## Risks', 'none', '', '## Verdict', 'approved'].join('\n');
  const md = formatDeliveryMetadata(parseDeliveryReport(text));
  assert.equal(md.complete, true);
  assert.equal(md.verdict, 'approved');
  assert.equal(md.findings, 'ok');
  assert.equal('tests_status' in md, false);
});

test('contract constants line up with the parser', () => {
  assert.deepEqual(DELIVERY_SECTIONS, ['Diff', 'Tests', 'Risks']);
  assert.deepEqual(OPTIONAL_DELIVERY_SECTIONS, ['Unverified']);
  assert.deepEqual(REVIEW_SECTIONS, ['Review Findings', 'Evidence', 'Risks', 'Verdict']);
  assert.match(buildDeliveryInstructions({}), /# Delivery report/);
  assert.ok(String(DELIVERY_MARKER).length > 0);
});

// ---------- MCP view consistency ----------
//
// dsh_run_worker and dsh_worker_result must expose the same per-job delivery +
// workspace_diff fields (both go through jobView / WorkerRegistry.view with
// withResult=true), while dsh_worker_status stays limited to the two booleans.

function finishedJob() {
  return {
    id: 'j1', tier: 'flash', model: 'deepseek-v4-flash', effort: 'max', status: 'done', source: 'claude-code',
    task: 'implement X', cwd: '/proj', turn: 1, step: 2, currentTool: null, toolCalls: 3,
    tokens: { input: 10, output: 20, reasoning: 0 }, startedAt: 't0', endedAt: 't1',
    result: ['did it', '', '## Diff', 'a.mjs', '', '## Tests', 'PASS — node --test — passed', '', '## Risks', 'none'].join('\n'),
    error: null, stopReason: 'completed',
    delivery_complete: true, delivery_missing: [], delivery_metadata: { complete: true, diff: 'a.mjs', tests_status: 'PASS' },
    workspaceDiff: { kind: 'git', patch: '…', redacted: [], truncated: false, dirtyBaseline: false },
  };
}

test('standalone job view: full delivery + workspace fields only in withResult views', () => {
  const full = jobView(finishedJob(), { withResult: true });
  assert.equal(full.delivery_complete, true);
  assert.deepEqual(full.delivery_missing, []);
  assert.equal(full.delivery.complete, true);
  assert.equal(full.delivery.tests_status, 'PASS');
  assert.equal(full.workspace_diff_available, true);
  assert.equal(full.workspace_diff.kind, 'git');
  assert.equal(full.workspace_baseline_dirty, false);
  // dsh_worker_status shape: only the two booleans from the new mechanism.
  const status = jobView(finishedJob());
  assert.equal(status.delivery_complete, true);
  assert.equal(status.workspace_diff_available, true);
  assert.equal('delivery' in status, false);
  assert.equal('delivery_missing' in status, false);
  assert.equal('workspace_diff' in status, false);
});

test('hub job view mirrors the standalone view for delivery + workspace fields', () => {
  const reg = new WorkerRegistry({ get: () => undefined });
  const job = { ...finishedJob(), sessionId: 's1' };
  const full = reg.view(job, true);
  assert.equal(full.delivery_complete, true);
  assert.equal(full.delivery.complete, true);
  assert.equal(full.delivery.tests_status, 'PASS');
  assert.equal(full.workspace_diff_available, true);
  assert.equal(full.workspace_diff.kind, 'git');
  const status = reg.view(job);
  assert.equal(status.delivery_complete, true);
  assert.equal(status.workspace_diff_available, true);
  assert.equal('delivery' in status, false);
  assert.equal('delivery_missing' in status, false);
  assert.equal('workspace_diff' in status, false);
  assert.equal('workspace_diff' in status, false);
});

test('incomplete worker output surfaces as delivery_complete=false in full views', () => {
  const job = { ...finishedJob(), result: 'worked without a report', delivery_complete: false, delivery_missing: ['Diff', 'Tests', 'Risks'], delivery_metadata: { complete: false, missing: ['Diff', 'Tests', 'Risks'] } };
  const full = jobView(job, { withResult: true });
  assert.equal(full.delivery_complete, false);
  assert.deepEqual(full.delivery_missing, ['Diff', 'Tests', 'Risks']);
  assert.equal(full.delivery.complete, false);
  // Execution status stays separate from delivery completeness.
  assert.equal(full.status, 'done');
});

test('failed tests remain delivery metadata and do not rewrite execution status', () => {
  const job = { ...finishedJob(), delivery_metadata: { complete: true, tests_status: 'FAIL', diff: 'a.mjs', tests: 'FAIL — node --test — failed', risks: 'known' } };
  const full = jobView(job, { withResult: true });
  assert.equal(full.status, 'done');
  assert.equal(full.delivery.complete, true);
  assert.equal(full.delivery.tests_status, 'FAIL');
});
