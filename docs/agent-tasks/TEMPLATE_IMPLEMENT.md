# IMPLEMENT Human Authoring Guide

Machine authority: `ACTIVE_TASK.json`.

IMPLEMENT requires explicit writable paths in `allowed_changes`. Include a Result Contract under `docs/agent-results/**` in both `allowed_changes` and `completion_commit_contract`, and include deletion of `docs/agent-tasks/ACTIVE_TASK.json` in completion.

Use repository facts for validation; for normal dsh-crew implementation consider `node --test test/*.test.mjs` and `pnpm run build:client` unless the task specifies otherwise.

Executor identity does not change permissions.
