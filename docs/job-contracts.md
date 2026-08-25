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

## Compatibility boundary

The internal legacy phase events remain in the explicit full view for current
debug consumers. Canonical events and the compact Result Contract are the
stable integration surface for new Codex, Claude, CLI, and HTTP consumers.

This design borrows the useful boundary from
[OpenMausBot](https://github.com/milind-soni/OpenMausBot)—a small provider
contract and one normalized event stream—without adopting its desktop chat,
bot roster, persona, connector, or general-purpose agent-platform scope.
