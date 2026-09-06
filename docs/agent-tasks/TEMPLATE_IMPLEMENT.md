# IMPLEMENT Human Authoring Guide

Machine authority: `ACTIVE_TASK.json`.

IMPLEMENT requires explicit writable paths in `allowed_changes`. Include a Result Contract under `docs/agent-results/**` in both `allowed_changes` and `completion_commit_contract`, and include deletion of `docs/agent-tasks/ACTIVE_TASK.json` in completion.

Choose explicit validation for the affected behavior using the matrix in
`docs/agent-workflow.md`; do not require full runtime acceptance for a small wording
edit. Contract-required checks remain mandatory.

Executor identity does not change permissions.
