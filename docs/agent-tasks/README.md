# Agent Task Contracts

Task Contracts define work. They do not define which executor must perform it.

Supported modes:

- `IMPLEMENT` — code or documentation changes explicitly allowed by the task scope.
- `TEST_ONLY` — validation and reporting only; writable paths are limited to `docs/agent-results/**`.
- `REVIEW_ONLY` — inspection, analysis, and reporting only; writable paths are limited to `docs/agent-results/**`.

Any compatible executor (Codex, ZCode, Claude Code, DeepSeek Harness, or another platform) may execute any mode if the Task Contract authorizes it. Executor choice never changes mode semantics.

## Active task

The canonical active task is:

`docs/agent-tasks/ACTIVE_TASK.json`

It is machine-readable and authoritative. `ACTIVE_TASK.md` may exist only as a non-authoritative human companion.

Do not create an ACTIVE task during workflow installation.

If the active task is missing or invalid, the executor must stop instead of inferring work from chat history, old reports, issues, source code, or another executor's files.

## Generate a task for dsh-crew

Use the workflow package without adding it as a product dependency:

```sh
npm exec --yes --package=github:Ran-sh/chatgpt_workflow -- agent-workflow task create --target . \
  --mode REVIEW_ONLY \
  --objective "Review the requested change" \
  --validate "node --test test/*.test.mjs" \
  --accept "Findings are reported with evidence" \
  --companion
```

The generator reads the current Git branch when available. Unless `--source-commit` is supplied explicitly, it writes `source_commit: LATEST`, meaning the executor resolves the current tip of `source_branch` after pulling/fetching and records the exact SHA used in the Result Contract.

This default is deliberate: the ACTIVE task is normally committed to the same branch, so pinning the task to the pre-task HEAD would become stale as soon as the task itself is committed. Use `--source-commit <SHA>` only when execution must be intentionally pinned to an immutable revision.

When a local Git HEAD is available, the generator records it as `metadata.prepared_from_commit` for audit without treating it as the execution pin.

For `IMPLEMENT`, at least one explicit `--allow <path>` is required. `TEST_ONLY` and `REVIEW_ONLY` are machine-enforced as result-only write modes under `docs/agent-results/**`.

The generator refuses to replace an existing ACTIVE task and validates generated JSON before activation.

## Manual template

`TEMPLATE_TASK.json` is a schema-valid platform-neutral scaffold for cases where a task is authored without the CLI. Replace every placeholder with repository-specific facts before activating it.

Validate a task with the project-local validator:

```sh
node .agent-workflow/validator/validate-contract.mjs task docs/agent-tasks/ACTIVE_TASK.json
```

## Source of authority

Permissions come only from the active Task Contract, especially:

- `mode`;
- `source_branch` and `source_commit`;
- `objective` and `context`;
- `allowed_changes`;
- `forbidden_changes`;
- `validation`;
- `acceptance_criteria`;
- `result_contract`;
- `completion_commit_contract`.

Executor adapters may document platform-specific startup or environment details, but they must not grant or remove task permissions.
