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

/**
 * The pointer to the reviewed attempt's persisted execution record.
 *
 * Only a pointer: the record itself is far too large to embed, and the reviewer
 * is expected to open it in the workspace it already has. It is emitted only
 * when the runtime could resolve both halves, so a transport that cannot name
 * the store degrades to the previous capsule instead of printing a dead path.
 */
function executionRecordLines(evidence) {
  const sessionId = evidence?.sessionId;
  const root = evidence?.root;
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return [];
  if (typeof root !== 'string' || root.trim() === '') return [];
  return [
    '',
    'Persisted execution record:',
    `session: ${sessionId}`,
    `store: ${root}`,
    `The record is the directory named "${sessionId}", one workspace level below that store. Read the session journal inside it — \`session.jsonl\` or a versioned \`session.v*.jsonl\`, possibly \`.zstd\`-compressed — and take your evidence from its \`tool/result\` entries: those hold the exact bytes a \`write\` produced (including a file that was later deleted) and the recorded output and exit code of every command that ran.`,
    'The journal is written as concatenated zstd frames, so a single-frame decompressor returns only the header; split it on the zstd magic 28 B5 2F FD and decompress each slice.',
    'This is the original execution, not a re-enactment. When the work was transient — created, run and removed before this review — this record is the only account of it, and a reproduction you run yourself cannot stand in for it: say so plainly and mark anything the record does not settle as NOT RUN rather than substituting an equivalent check.',
  ];
}

/** Build the automatic-review context capsule. */
export function buildReviewTask(task, view = {}, { strictness = 'standard' } = {}) {
  const outcome = view?.outcome ?? {};
  const candidate = view?.candidate ?? {};
  const changedFiles = Array.isArray(candidate.changed_files) ? candidate.changed_files : [];
  const parts = [
    'You are the automatic reviewer of a completed worker implementation.',
    'REVIEW ONLY: inspect the candidate and report findings. Do not modify files.',
    ...(strictness === 'strict' ? [
      'STRICT REVIEW: fail closed. Approve only when direct code and test evidence supports every material claim; treat missing evidence as needs changes.',
    ] : []),
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
    ...executionRecordLines(view?.evidence),
    '',
    'Report: 1) whether the implementation satisfies the objective, 2) concrete bugs/style/security risks, 3) suggested fixes. End with ## Review Findings / ## Evidence / ## Risks / ## Verdict (approved | needs changes | rejected).',
  ];
  return parts.join('\n');
}
