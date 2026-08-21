# Agent Handoff Protocol

Workflow source: `Ran-sh/chatgpt_workflow` v1.7.0 (`4d41242fc8fc89bb595681047e6e90f460d0d65d`).

## 1. Authority model

GitHub is the durable handoff layer. The only authoritative active task is:

`docs/agent-tasks/ACTIVE_TASK.json`

Codex, ZCode, Claude Code, DeepSeek Harness, or any future compatible executor may execute the same task. Executor identity never grants permissions and is not a workflow role.

If the task is missing or invalid, stop. Do not infer work from chat history, issues, old reports, source code, or historical executor-specific ACTIVE files.

`ACTIVE_TASK.md` may exist as a non-authoritative human companion; JSON wins on conflict.

## 2. Modes

- `IMPLEMENT` — may modify only explicit `allowed_changes`.
- `TEST_ONLY` — verification/reporting only; writable paths are limited to `docs/agent-results/**`.
- `REVIEW_ONLY` — inspection/reporting only; writable paths are limited to `docs/agent-results/**`.

Task permissions come from the Task Contract, not from the selected platform.

## 3. Start-of-task protocol

Resolve the equivalent of:

```sh
git pull --ff-only
git rev-parse HEAD
git branch --show-current
git status --short
```

Validate the active task when local Node is available:

```sh
node .agent-workflow/validator/validate-contract.mjs task docs/agent-tasks/ACTIVE_TASK.json
```

Confirm `source_branch` and `source_commit` before executing. Preserve dirty worktrees. Never reset, clean, stash, overwrite, or discard unrelated changes without explicit task authorization.

## 4. Scope and safety

- Modify only `allowed_changes`.
- `forbidden_changes` are hard prohibitions.
- Everything else is read-only.
- `result_contract` must be under `docs/agent-results/**` and included in `allowed_changes`.
- Do not invent commands, providers, models, credentials, or environmental facts.
- Never expose API keys, bearer tokens, cookies, signed URLs, credential files, secret environment values, or private local paths.
- Separate defects are reported, not opportunistically fixed.

## 5. Validation states

Use exactly: `PASS`, `FAIL`, `PARTIAL`, `SKIP`, `BLOCKED`, `NOT RUN`.

Never turn a blocked, skipped, partial, or not-run scenario into PASS.

## 6. Execution lifecycle

1. Resolve branch/revision and working-tree state.
2. Read this workflow.
3. Read and validate `ACTIVE_TASK.json`.
4. Execute only authorized work.
5. Run every required validation or truthfully record `BLOCKED`, `SKIP`, or `NOT RUN`.
6. Write the Result Contract/report.
7. Verify `acceptance_criteria`.
8. On actual completion, delete `ACTIVE_TASK.json`; delete `ACTIVE_TASK.md` too only when the completion contract includes it.
9. Commit/push only `completion_commit_contract` paths and follow repository branch/PR policy.

The completion contract must include the Result Contract and `docs/agent-tasks/ACTIVE_TASK.json`.

## 7. Result handoff

Validate machine-readable results with:

```sh
node .agent-workflow/validator/validate-contract.mjs result <result-json>
```

Results identify task/source revision, status, changed files, tests, blockers, and result path. ChatGPT or another coordinator decides the next task; executors do not self-assign follow-up work.

## 8. dsh-crew project policy

```text
Repository: Ran-sh/dsh-crew
Default branch: main
Package manager: pnpm 10 (pnpm-lock.yaml is authoritative)
Primary source: src/
Built/runtime assets: lib/ and generated client output as defined by repository scripts
Tests: test/*.test.mjs
Build: pnpm run build:client
Primary deterministic tests: node --test test/*.test.mjs
CI: .github/workflows/ci.yml
Dedicated typecheck command: none currently defined; do not invent one
Dedicated lint command: none currently defined; do not invent one
Result contracts: docs/agent-results/
```

### Protected / sensitive areas

Unless an `IMPLEMENT` Task Contract explicitly allows them, keep these read-only:

- `~/.config/dsh-crew/` and DSH/provider credential storage
- API keys, tokens, environment secrets, signed URLs, cookies
- `.github/workflows/**`
- `package.json`, lockfiles, version/release metadata
- installer/release behavior
- user workspaces outside explicitly designated disposable test repositories

### Branch / PR policy

- Do not push implementation changes directly to `main` unless the task explicitly authorizes it.
- Prefer feature/fix branches and PRs.
- Do not force-push, rewrite published history, reset, or rebase unrelated commits unless explicitly authorized.

### Default implementation validation

Unless a task narrows/expands the matrix, implementation should consider:

```sh
node --test test/*.test.mjs
pnpm run build:client
```

Platform-specific scenarios must run on the platform they validate. Do not claim Windows behavior was verified only on Linux.

### Real DSH / provider validation

- Use disposable Git repositories for coding-worker runtime tests; never ask a worker to edit the dsh-crew source checkout unless the task explicitly does so.
- Use only provider/model configuration already authorized in the current environment unless the task permits a configuration change.
- Hub and Standalone are separate execution paths and must be reported separately when both matter.
- Standalone may require `DEEPSEEK_API_KEY`; if unavailable or unauthorized, mark the scenario `SKIP` or `BLOCKED` rather than fabricating credentials.
- Session-level worker configuration changes require task authorization and should be restored after the test group.
- dsh-crew internal worker/reviewer roles are project orchestration concepts; they do not change the external Agent Workflow rule that execution platforms are interchangeable.

## 9. Installation/removal

This repository was migrated from a pre-v1.7 workflow. `docs/.agent-workflow-install.json` distinguishes newly generated files from pre-existing workflow files that were modified/adopted. Automated uninstall may remove only generated files; migrated/adopted files require explicit review before deletion.

The workflow is development infrastructure, not a product runtime dependency.
