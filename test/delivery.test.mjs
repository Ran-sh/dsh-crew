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
    'node --test passed',
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
  const text = 'some ## Diff inline mention\n## Tests\nran the suite\n## Risks\nnone';
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
  assert.equal(md.diff, 'src/a.mjs — fixed the bug');
  assert.equal(md.unverified, 'not tested on Windows');
  assert.equal('missing' in md, false);
});

test('formatDeliveryMetadata clips long sections and names missing ones', () => {
  const text = ['## Diff', 'a'.repeat(1000), '', '## Tests', 't', '', '## Risks', ''].join('\n');
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
});

test('contract constants line up with the parser', () => {
  assert.deepEqual(DELIVERY_SECTIONS, ['Diff', 'Tests', 'Risks']);
  assert.deepEqual(OPTIONAL_DELIVERY_SECTIONS, ['Unverified']);
  assert.deepEqual(REVIEW_SECTIONS, ['Review Findings', 'Evidence', 'Risks', 'Verdict']);
  assert.match(buildDeliveryInstructions({}), /# Delivery report/);
  assert.ok(String(DELIVERY_MARKER).length > 0);
});
