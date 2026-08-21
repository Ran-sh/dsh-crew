# Agent Task Contracts

Task Contracts define work. Executors do not own fixed workflow roles.

Canonical task:

`docs/agent-tasks/ACTIVE_TASK.json`

`ACTIVE_TASK.md` is optional and non-authoritative. Installation/migration must not create an ACTIVE task.

Modes:

- `IMPLEMENT` — explicit writable scope required.
- `TEST_ONLY` — result-only writes under `docs/agent-results/**`.
- `REVIEW_ONLY` — result-only writes under `docs/agent-results/**`.

Any compatible executor may execute any mode. Missing/invalid ACTIVE means stop.

## Generate a task

```sh
npm exec --yes --package=github:Ran-sh/chatgpt_workflow -- agent-workflow task create --target . \
  --mode REVIEW_ONLY \
  --objective "Review the requested change" \
  --validate "node --test test/*.test.mjs" \
  --accept "Findings are reported with evidence" \
  --companion
```

For `IMPLEMENT`, pass explicit `--allow <path>` entries. The generator refuses to replace an existing ACTIVE task and validates before activation.

Manual authors may use `TEMPLATE_TASK.json`, then validate with `.agent-workflow/validator/validate-contract.mjs`.
