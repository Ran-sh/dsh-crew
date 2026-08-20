// Auditable worker delivery: one shared Delivery Contract that every coding
// worker (and the automatic Pro review) must fill out before its result is
// accepted, plus pure helpers to prompt for, parse, validate and format it.
//
// Everything here is a pure function (no I/O, no worker runtime), so tests can
// exercise the contract without starting DSH. Keeping the contract in one
// shared builder guarantees the prompt-construction points (jobs.mjs, the hub,
// the MCP shim) emit byte-identical instructions, and parse / validate let the
// orchestrator separate *execution* status (running/done/failed) from
// *delivery* completeness (did the worker actually report Diff/Tests/Risks?).

export const DELIVERY_SECTIONS = ['Diff', 'Tests', 'Risks'];
export const OPTIONAL_DELIVERY_SECTIONS = ['Unverified'];
export const ALL_DELIVERY_SECTIONS = [...DELIVERY_SECTIONS, ...OPTIONAL_DELIVERY_SECTIONS];

export const REVIEW_SECTIONS = ['Review Findings', 'Evidence', 'Risks', 'Verdict'];

/** Any worker prompt that already carries a delivery report (added once). */
export const DELIVERY_MARKER = '# Delivery report';

const METADATA_KEYS = {
  Diff: 'diff',
  Tests: 'tests',
  Risks: 'risks',
  Unverified: 'unverified',
  'Review Findings': 'findings',
  Evidence: 'evidence',
  Verdict: 'verdict',
};

/**
 * Prompts a coding worker (or, with isReview, an automatic Pro review) to end
 * its final message with the auditable delivery contract. This is the single
 * source of the contract text for every worker prompt.
 */
export function buildDeliveryInstructions({ tier = 'pro', isReview = false } = {}) {
  if (isReview) {
    return `# Delivery report — automatic review (worker tier: pro)
You are reviewing an implementation, and your review must be auditable. End your final message with these four sections — each on its own line as a '##' heading — followed by concise content:

## Review Findings
One-line overall assessment of whether the implementation satisfies the task.

## Evidence
What you inspected: file paths, diffs, commands you ran, and their results.

## Risks
Concrete issues found: bugs, style problems, missing edge cases, security or secret-handling concerns.

## Verdict
One line: approved / needs changes / rejected, plus the single most important reason.

Do not edit files unless the user explicitly asks for fixes.`;
  }
  return `# Delivery report requirements (worker tier: ${String(tier).toUpperCase()})
You are a coding worker, and your result must be auditable. End your final message with these three mandatory sections — each on its own line as a '##' heading — followed by concise, factual content:

## Diff
Every file you changed or created (paths), with a one-line summary per file. If you changed nothing, write "no files changed".

## Tests
Every entry must use exactly one of these auditable states:
PASS — <command/check> — <result>
FAIL — <command/check> — <reason>
NOT RUN — <check> — <reason>
"none" is not a valid Tests result.

## Risks
Known risks and side effects: files touched outside the requested scope, assumptions you made, anything that could break, and any credentials or sensitive data you opened.

## Unverified
(Optional — omit entirely if you verified everything.) Anything you could not verify: skipped builds, untested platforms, known gaps.

The Diff, Tests and Risks sections are mandatory — do not skip them. Keep each section tight (a few lines is enough).

${tier === 'flash' ? `Implement only the delegated coding scope.
Run direct validation needed for your change.
Return the Delivery Report.
Then stop and return control to the Main Agent.

Do not autonomously start a new task or delegate further work.` : ''}`;
}

/**
 * Append the delivery instructions to a worker task prompt. Idempotent: a task
 * that already carries the delivery report (e.g. a review prompt, or a
 * re-dispatch) is returned untouched so instructions are never doubled.
 */
export function appendDeliveryInstructions(task, { tier, isReview } = {}) {
  if (typeof task !== 'string') return task;
  if (task.includes(DELIVERY_MARKER)) return task;
  return `${task}\n\n${buildDeliveryInstructions({ tier, isReview })}`;
}

function parseTestsSection(value) {
  if (typeof value !== 'string' || value.trim() === '') return { valid: false, status: undefined };
  const statuses = [];
  for (const line of value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const match = line.match(/^(?:[-*+]\s+)?(PASS|FAIL|NOT RUN)\s+—\s+\S.*?\s+—\s+\S.*$/);
    if (!match) return { valid: false, status: undefined };
    statuses.push(match[1]);
  }
  const status = statuses.includes('FAIL') ? 'FAIL' : statuses.includes('NOT RUN') ? 'NOT RUN' : statuses.includes('PASS') ? 'PASS' : undefined;
  return { valid: status !== undefined, status };
}

/**
 * Parse a worker's final message into the delivery report. Detects the report
 * format from the headings present: coding workers use Diff/Tests/Risks
 * (+ optional Unverified), automatic reviews use Review Findings/Evidence/
 * Risks/Verdict. `complete` means every *mandatory* section of the detected
 * format is present and non-empty.
 *
 * Returns { format, present, complete, missing, sections }.
 */
export function parseDeliveryReport(text = '') {
  const normalized = typeof text === 'string' ? text : String(text ?? '');
  if (normalized.trim() === '') {
    return { format: null, present: [], complete: false, missing: [...DELIVERY_SECTIONS], sections: {} };
  }
  const canonical = new Map(ALL_DELIVERY_SECTIONS.concat(REVIEW_SECTIONS).map((name) => [name.toLowerCase(), name]));
  const heading = /^##\s+(Diff|Tests|Risks|Unverified|Review Findings|Evidence|Verdict)\s*$/gim;
  const marks = [];
  let m;
  while ((m = heading.exec(normalized)) !== null) marks.push({ index: m.index, name: canonical.get(m[1].toLowerCase()), len: m[0].length });
  if (marks.length === 0) {
    return { format: null, present: [], complete: false, missing: [...DELIVERY_SECTIONS], sections: {} };
  }
  const sections = {};
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i].len;
    const end = i + 1 < marks.length ? marks[i + 1].index : normalized.length;
    const body = normalized.slice(start, end).trim();
    const name = marks[i].name;
    sections[name] = sections[name] === undefined ? body : `${sections[name]}\n\n${body}`;
  }
  const isReview = REVIEW_SECTIONS.some((s) => s !== 'Risks' && sections[s] !== undefined);
  const mandatory = isReview ? REVIEW_SECTIONS : DELIVERY_SECTIONS;
  const parsedTests = isReview ? null : parseTestsSection(sections.Tests);
  const missing = mandatory.filter((s) => {
    const v = sections[s];
    if (v === undefined || v === '') return true;
    return !isReview && s === 'Tests' && !parsedTests.valid;
  });
  const testsStatus = parsedTests?.status;
  return {
    format: isReview ? 'review' : 'coding',
    present: [...new Set(marks.map((x) => x.name))],
    complete: missing.length === 0,
    missing,
    sections,
    ...(testsStatus ? { tests_status: testsStatus } : {}),
  };
}

/**
 * Re-check a parsed report (or raw text) against the contract. Pure and
 * forgiving: returns { ok, complete, missing, present } and never throws.
 */
export function validateDeliveryReport(parsedOrText) {
  const parsed = typeof parsedOrText === 'string'
    ? parseDeliveryReport(parsedOrText)
    : (parsedOrText ?? parseDeliveryReport(''));
  const sections = parsed.sections ?? {};
  const isReview = parsed.format === 'review';
  const mandatory = isReview ? REVIEW_SECTIONS : DELIVERY_SECTIONS;
  const parsedTests = isReview ? null : parseTestsSection(sections.Tests);
  const missing = mandatory.filter((s) => {
    const v = sections[s];
    if (v === undefined || v === '') return true;
    return !isReview && s === 'Tests' && !parsedTests.valid;
  });
  return { ok: missing.length === 0, complete: missing.length === 0, missing: [...missing], present: [...(parsed.present ?? [])] };
}

function clip(text, limit) {
  if (typeof text !== 'string') return undefined;
  const t = text.trim();
  if (t === '') return undefined;
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}

/**
 * Compact metadata form of a parsed report for MCP responses / job views:
 * complete + missing plus a bounded snippet per present section. Keeps the
 * worker's full message out of status payloads.
 */
export function formatDeliveryMetadata(parsed, { limit = 400 } = {}) {
  const sections = parsed?.sections ?? {};
  const out = {
    complete: parsed?.complete === true,
    missing: Array.isArray(parsed?.missing) ? [...parsed.missing] : [],
  };
  for (const s of ALL_DELIVERY_SECTIONS) {
    const clipped = clip(sections[s], limit);
    if (clipped !== undefined) out[METADATA_KEYS[s]] = clipped;
  }
  for (const s of REVIEW_SECTIONS) {
    const clipped = clip(sections[s], limit);
    if (clipped !== undefined) out[METADATA_KEYS[s]] = clipped;
  }
  if (parsed?.tests_status) out.tests_status = parsed.tests_status;
  if (out.missing.length === 0) delete out.missing;
  return out;
}
