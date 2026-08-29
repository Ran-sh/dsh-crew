# Job contracts and information flow

DSH Crew is a narrow bridge and scheduler. Codex or Claude owns the main task;
Crew owns one delegated Worker/Reviewer workflow and reports auditable evidence
back to the caller.

## Information flow

```text
caller objective
  -> Worker in isolated workspace
  -> structured outcome + candidate reference
  -> optional Reviewer inspects the workspace directly
  -> compact Result Contract + canonical job events
  -> caller
```

The Worker receives the complete delegated objective. After it finishes, Crew
does not copy the Worker's raw prose or full patch into the Reviewer prompt.
The Reviewer receives a bounded capsule containing the objective, reported
changes/tests/risks, changed-file names, base revision, and candidate
fingerprint. It opens the relevant files and runs `git diff` in the isolated
workspace when deeper inspection is needed.

The Hub keeps only the latest assistant message needed as the final Delivery
Report. It does not retain an ever-growing list of intermediate assistant
messages.

## Canonical events

Every workflow result can expose a versioned, ordered `canonical_events` list.
Each event has `schema_version`, `event_id`, `job_id`, `sequence`, `type`, `at`,
`role`, `attempt`, and bounded structured `data`.

Supported event types (the allow-list is versioned; `approval.required` is
reserved for a future approval broker and is not emitted by the current
runtime):

- `job.created`, `job.started`
- `model.selected`, `model.fallback`
- `worker.started`, `worker.completed`
- `review.started`, `review.completed`
- `approval.required`
- `job.completed`, `job.failed`, `job.cancelled`

Events never carry a candidate patch, raw provider payload, credential, or full
assistant response. `event_cursor` identifies the latest event in status views.

## Result Contract

`dsh_run_worker` and `dsh_worker_result` default to `detail: "compact"`. Their
`evidence` object contains:

- `status`: `PASS`, `FAIL`, `PARTIAL`, or `BLOCKED`
- structured execution/test/delivery/review summary
- bounded model-selection trace
- changed files, reported changes, tests, risks, and unverified checks
- reviewer verdict and evidence when review ran
- candidate fingerprint/base revision and workspace recovery state
- bounded machine error code/message when execution failed

Raw worker prose and candidate patch text are excluded. For an explicit debug
or recovery operation, pass `detail: "full"`; this preserves the previous rich
workflow view and adds the same evidence envelope.

## Profiles, Workspace Context, and watch

Both blocking and asynchronous MCP dispatch accept optional `job_id`, `profile`,
`workspace`, `constraints`, `workspace_id`, and `context_refs` fields. The
caller id is echoed as `client_job_id`; it never replaces Crew's internal id.
Profiles control role-compatible
routing, isolation, timeout, fallback, and review strictness. Workspace Context
adds bounded project facts by reference; instruction file contents are opened by
the Agent in the workspace rather than copied through the hand-off.

`dsh_worker_result` accepts `after_sequence`. The response includes only newer
`canonical_events` plus the current numeric `event_cursor`, so callers can watch
long jobs without replaying the entire event history.

The isolated Hub also exposes `/extension`, `/profiles`, `/workspaces`,
`/jobs/:id/contract`, and `/jobs/:id/events`. All remain loopback-only.

Per-job precedence is request `constraints` > Profile > session defaults.
`workspace.branch` pins the isolated base revision; `workspace.worktree` accepts
`auto`, `existing`, or `none`. Workspace preflight reports `READY`, `CONFLICT`,
`READ_ONLY`, or `UNAVAILABLE` before dispatch.

`constraints.allow_no_changes: true` is reserved for explicitly read-only
search, inspection, or analysis work. It does not blindly convert a partial
Delivery Report into success: Crew requires an isolated candidate with zero
changed files, a complete Delivery Report, at least one passing evidence check,
and no failed check. If the Worker reports no changes but the workspace contains
edits—or reports changes while the workspace is empty—the workflow fails closed
with workspace-evidence mismatch.

The CLI is a JSON projection of the same local HTTP surface:

```text
dsh-crew jobs list
dsh-crew jobs get <job-id> --detail compact
dsh-crew jobs watch <job-id> --after <sequence>
dsh-crew jobs cancel <job-id>
dsh-crew jobs submit --request job.json
```

## Compatibility boundary

The internal legacy phase events remain in the explicit full view for current
debug consumers. Canonical events and the compact Result Contract are the
stable integration surface for new Codex, Claude, CLI, and HTTP consumers.

This design borrows the useful boundary from
[OpenMausBot](https://github.com/milind-soni/OpenMausBot)—a small provider
contract and one normalized event stream—without adopting its desktop chat,
bot roster, persona, connector, or general-purpose agent-platform scope.
