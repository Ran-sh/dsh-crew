# Agent Handoff Protocol

Workflow source: `Ran-sh/chatgpt_workflow` v1.8.0 (`5e4239aa3a30e3a1738dcdb79e7d341ea8bca458`).

## 1. Operating model

GitHub is the durable source of truth. ChatGPT is the orchestrator; Codex, ZCode, Claude Code, DeepSeek Harness, and other compatible agents are interchangeable remote execution platforms.

The intended loop is:

```text
User request
  -> ChatGPT inspects/changes GitHub directly
  -> local or real-environment work remains
  -> ChatGPT commits ACTIVE_TASK.json
  -> user sends one short executor trigger
  -> executor performs the task and commits a Result Contract
  -> ChatGPT reads GitHub and continues
```

Do not create executor work for repository operations ChatGPT can already complete safely through GitHub.

## 2. Task authority

The machine-readable active task is:

`docs/agent-tasks/ACTIVE_TASK.json`

It is the only task authority. Executor names never grant permissions or determine task mode.

If the active task is missing or invalid, stop. Do not infer work from chat history, issues, old result reports, source code, historical executor-specific ACTIVE files, or another executor's task.

`docs/agent-tasks/ACTIVE_TASK.md` may exist only as a non-authoritative human companion. If it conflicts with JSON, the JSON Task Contract wins.

The normal user-facing trigger is intentionally minimal:

```text
Execute ACTIVE_TASK.json according to Agent Workflow Protocol.
```

Project requirements must not be duplicated into the trigger.

## 3. Modes

- `IMPLEMENT` — implementation changes only inside explicit `allowed_changes`.
- `TEST_ONLY` — validation/reporting only; writable paths are limited to `docs/agent-results/**`.
- `REVIEW_ONLY` — inspection/reporting only; writable paths are limited to `docs/agent-results/**`.

The Task Contract, not the executor, determines scope.

## 4. Source revision and worktree safety

Before executing, resolve `source_branch` and `source_commit` from the Task Contract and confirm the working copy matches the requested revision.

`source_commit: LATEST` means: after fetching/pulling according to repository policy, resolve and execute the current tip of `source_branch`, and record the exact SHA actually used in the Result Contract. This is the normal value for a queued task committed to the same branch because the task commit itself moves the branch tip.

Use an explicit commit SHA only when the orchestrator intentionally wants execution pinned to that immutable revision. Other explicitly documented symbolic values may be used only when this workflow defines their resolution semantics.

At task start, resolve the equivalent of:

```sh
git pull --ff-only
git rev-parse HEAD
git branch --show-current
git status --short
```

Validate the task when local Node is available:

```sh
node .agent-workflow/validator/validate-contract.mjs task docs/agent-tasks/ACTIVE_TASK.json
```

Preserve dirty worktrees. Never reset, clean, stash, overwrite, force-push, or discard unrelated user changes without explicit task authorization.

## 5. Scope and safety

- Modify only paths authorized by `allowed_changes`.
- Treat `forbidden_changes` as hard prohibitions.
- Everything not authorized is read-only.
- `result_contract` must be inside `docs/agent-results/**` and must appear in `allowed_changes`.
- Never expose credentials, tokens, cookies, private keys, signed URLs, secret environment values, or sensitive local paths.
- Do not invent build, test, lint, typecheck, release, provider, model, credential, or environmental facts.
- Preserve dirty worktrees and unrelated changes.
- Separate defects are reported, not opportunistically fixed outside scope.

## 6. Validation statuses

Use only:

`PASS`, `FAIL`, `PARTIAL`, `SKIP`, `BLOCKED`, `NOT RUN`

Never convert an unexecuted, skipped, partial, or blocked check into PASS.

## 7. Execution lifecycle

New execution results use **Result Contract v2** (`schema_version: 2`). Historical Result Contracts without `schema_version` are legacy v1 and remain valid; do not rewrite old reports only to upgrade their format.

1. Read this workflow.
2. Read and validate `docs/agent-tasks/ACTIVE_TASK.json`.
3. Confirm source revision and worktree safety.
4. Start a Result Contract v2 draft and record `timeline.started_at` at second precision with timezone when real task execution begins.
5. Execute only the authorized scope in the real environment.
6. Run every required validation or record why it is `BLOCKED`, `SKIP`, or `NOT RUN`.
7. Finish writing the Result Contract and record `timeline.completed_at` at second precision with timezone.
8. Run the installed Result validator with `--stamp` so the validator itself writes `result_validation` evidence:

   ```sh
   node .agent-workflow/validator/validate-contract.mjs result <result-json> --stamp
   ```

9. Verify completion against `acceptance_criteria`. A new Result Contract v2 without stamped validator evidence is incomplete.
10. When completion is real and `delete_active_task_on_completion` is true, remove `ACTIVE_TASK.json` and its companion when required.
11. Commit/push only paths allowed by `completion_commit_contract` and repository policy.
12. Stop. Do not self-assign follow-up work.

`completion_commit_contract` must include the Result Contract and `docs/agent-tasks/ACTIVE_TASK.json`. If task metadata says a human companion was generated, include `docs/agent-tasks/ACTIVE_TASK.md` too.

## 8. Result handoff

New Result Contracts must include `schema_version: 2` and an auditable timeline:

```text
timeline.started_at
  -> local execution and required checks
  -> timeline.completed_at
  -> validator --stamp
  -> result_validation.validated_at
```

All three timestamps use ISO 8601 with year, month, day, hour, minute, second, and timezone, for example `2026-08-21T15:12:04+08:00`. Milliseconds are not used.

`result_validation` is validator-owned evidence. Executors must not manually claim validator success. The validator stamps `status: PASS`, the canonical command, the validation timestamp, and success evidence only after the v2 draft Result Contract passes validation; the stamped final document is then validated again before it is written.

Historical v1 Result Contracts, identified by the absence of `schema_version`, remain valid without v2 timeline/stamp fields so workflow upgrades do not invalidate prior evidence.

Normal validation for an already stamped result is:

```sh
node .agent-workflow/validator/validate-contract.mjs result <result-json>
```

After execution, the user may simply tell ChatGPT that the executor is finished. ChatGPT should inspect GitHub directly, evaluate the result, and decide the next action instead of asking the user to paste the report.

## 9. Orchestrator boundary

ChatGPT should create an ACTIVE Task only for work it cannot actually complete through GitHub or that requires the user's real execution environment, credentials, devices, runtime, GUI, provider configuration, or release tooling.

Repository edits that ChatGPT can safely perform through GitHub should be performed directly rather than delegated by default.

## 10. Installation and removal

Workflow installation must not create an ACTIVE task. Workflow removal is ownership-based using `docs/.agent-workflow-install.json` and must refuse to proceed while an ACTIVE task exists.

This repository was migrated from a pre-v1.7 workflow. The manifest distinguishes newly generated workflow-owned files from pre-existing workflow files that were modified/adopted. Automated uninstall may remove only paths recorded as workflow-owned generated files; migrated/adopted files require explicit review before deletion.

The workflow is development infrastructure, not a product runtime dependency.

## 11. dsh-crew project adapter

Repository facts verified from this repository:

```text
Repository: Ran-sh/dsh-crew
Default branch: main
Runtime/language: Node.js ESM; JavaScript source with TypeScript/TSX client code
CI Node version: 22
Package manager: pnpm 10 (pnpm-lock.yaml is authoritative)
Primary source: src/
Tests: test/*.test.mjs
Build: pnpm run build:client
Primary deterministic sweep: node --test test/*.test.mjs
CI: .github/workflows/ci.yml
Dedicated typecheck command: none currently defined; do not invent one
Dedicated lint command: none currently defined; do not invent one
Result contracts: docs/agent-results/
```

The CI workflow runs deterministic Linux unit/integration checks plus the workspace-audit test and client build, and a separate Windows path/Git-resolver regression job. Platform-specific claims must be validated on the platform they describe.

### Protected / sensitive areas

Unless an `IMPLEMENT` Task Contract explicitly allows them, keep these read-only:

- `~/.config/dsh-crew/` and DSH/provider credential storage
- API keys, tokens, environment secrets, signed URLs, cookies
- `.github/workflows/**`
- `package.json`, lockfiles, version/release metadata
- installer/release behavior
- user workspaces outside explicitly designated disposable test repositories

### Branch / PR policy

- Do not push implementation changes directly to `main` unless a task explicitly authorizes it.
- Prefer feature/fix/chore branches and pull requests.
- Do not force-push, rewrite published history, reset, or rebase unrelated commits unless explicitly authorized.

### Default implementation validation

Unless a task narrows or expands the matrix, implementation should consider:

```sh
node --test test/*.test.mjs
pnpm run build:client
```

Do not claim Windows behavior was verified only on Linux.

### Real DSH / provider validation

- **Hard isolation rule (dsh-crew P0)**: every dsh-crew DSH test uses a
  disposable or Crew-owned isolated `DSH_HOME` (default
  `~/.config/dsh-crew/harness`) and a dedicated/disposable profile (default
  `dsh-crew`). Never boot, install into, or mutate the user's normal `~/.dsh`
  or its persistent `web` profile. Never read or copy official DSH credential
  stores (`~/.dsh/.credentials.yaml`, `~/.dsh/settings.yaml`, provider key
  files). Credentials must be task-scoped explicit environment variables or
  isolated-store credentials created for the test; an absent credential is a
  `SKIP`/`BLOCKED`, never a reason to read the official store.
- Use disposable Git repositories for coding-worker runtime tests; never ask a worker to edit the dsh-crew source checkout unless the task explicitly allows it.
- Use only provider/model configuration already authorized in the current environment unless the task permits a configuration change.
- Hub and Standalone are separate execution paths and must be reported separately when both matter.
- Standalone may require `DEEPSEEK_API_KEY`; if unavailable or unauthorized, mark the scenario `SKIP` or `BLOCKED` rather than fabricating credentials.
- Session-level worker configuration changes require task authorization and should be restored after the test group.
- dsh-crew internal worker/reviewer roles are product orchestration concepts; they do not change the external Agent Workflow rule that execution platforms are interchangeable.
