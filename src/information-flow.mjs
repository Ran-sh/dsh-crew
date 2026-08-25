// Bounded context builders for agent-to-agent hand-offs.
//
// Workers still receive the user's complete delegated task. Once a worker has
// run, downstream agents receive only an objective plus structured evidence
// and artifact references. They inspect the isolated workspace directly when
// more detail is required; raw prose and whole patches are never re-embedded.

function clip(value, limit) {
  const text = String(value ?? '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated: ${text.length - limit} characters omitted]`;
}

function list(values, { count = 40, itemLimit = 300 } = {}) {
  if (!Array.isArray(values) || values.length === 0) return ['(none)'];
  const selected = values.slice(0, count).map((value) => `- ${clip(value, itemLimit)}`);
  if (values.length > count) selected.push(`- [truncated: ${values.length - count} additional items omitted]`);
  return selected;
}

function tests(values) {
  if (!Array.isArray(values) || values.length === 0) return ['(none reported)'];
  return list(values.map((entry) => [entry?.status, entry?.command, entry?.summary].filter(Boolean).join(' — ')), {
    count: 30,
    itemLimit: 500,
  });
}

/** Build the automatic-review context capsule. */
export function buildReviewTask(task, view = {}) {
  const outcome = view?.outcome ?? {};
  const candidate = view?.candidate ?? {};
  const changedFiles = Array.isArray(candidate.changed_files) ? candidate.changed_files : [];
  const parts = [
    'You are the automatic reviewer of a completed worker implementation.',
    'REVIEW ONLY: inspect the candidate and report findings. Do not modify files.',
    '',
    'Objective:',
    clip(task, 4000),
    '',
    'Worker outcome:',
    `task_status=${outcome.task_status ?? 'unknown'} tests_status=${outcome.tests_status ?? 'unknown'} delivery=${outcome.delivery?.complete ? 'complete' : 'incomplete'}`,
    '',
    'Reported changes:',
    ...list(outcome.changes),
    '',
    'Reported tests:',
    ...tests(outcome.tests),
    '',
    'Reported risks:',
    ...list(outcome.risks),
    '',
    'Candidate artifact:',
    `base_revision=${candidate.base_revision ?? 'unknown'}`,
    `fingerprint=${candidate.fingerprint ?? 'unknown'}`,
    'changed_files:',
    ...list(changedFiles, { count: 80, itemLimit: 500 }),
    '',
    'Inspect the candidate directly in the current isolated workspace. Use git diff against the base revision and open only the files needed for review. The worker\'s raw prose and full patch are intentionally not embedded in this hand-off.',
    '',
    'Report: 1) whether the implementation satisfies the objective, 2) concrete bugs/style/security risks, 3) suggested fixes. End with ## Review Findings / ## Evidence / ## Risks / ## Verdict (approved | needs changes | rejected).',
  ];
  return parts.join('\n');
}

