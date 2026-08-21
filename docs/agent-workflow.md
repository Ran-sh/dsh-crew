# Agent Handoff Protocol v1

GitHub is the durable handoff layer between the user, ChatGPT, ZCode, Codex, DeepSeek Harness, and future execution agents.

Detailed instructions live in this repository. The user should only need to send a short trigger from a phone, remote terminal, or chat UI.

## Roles

- **ChatGPT** — architecture, diagnosis, task design, acceptance criteria, implementation when explicitly taking ownership, and result analysis.
- **ZCode** — implementation-oriented executor by default; may only modify source when its ACTIVE task says `Mode: IMPLEMENT`.
- **Codex** — independent verification/review executor by default.
- **DeepSeek Harness** — runtime/application/agent-level executor; permissions still come from the ACTIVE task.
- **GitHub** — source of truth for task state, reports, evidence, and commits.

The ACTIVE task, not the agent name, determines permissions.

## Active task files

Use exactly one file per agent:

- `docs/agent-tasks/ACTIVE_ZCODE_TASK.md`
- `docs/agent-tasks/ACTIVE_CODEX_TASK.md`
- `docs/agent-tasks/ACTIVE_DEEPSEEK_HARNESS_TASK.md`

Only create an ACTIVE file when that agent actually has work.

If the expected ACTIVE file does not exist, stop. Do not infer a task from old reports, chat history, issues, nearby code, or another agent's ACTIVE file. Do not read or execute another agent's ACTIVE task.

## Required task header

Every ACTIVE task must start with:

```text
Protocol: Agent Handoff Protocol v1
Agent: ZCODE | CODEX | DEEPSEEK_HARNESS | ANY
Mode: IMPLEMENT | TEST_ONLY | REVIEW_ONLY
Source Branch: <branch>
Source Commit: <sha | LATEST | LATEST_MAIN | LATEST_DEFAULT_BRANCH>
Result Path: <path | NONE>
Delete Active Task On Completion: YES
```

The executing agent must record the actual `git rev-parse HEAD` used for the task. If an explicit Source Commit is required and the checkout does not match it, stop instead of silently working on another revision.

## Modes

### IMPLEMENT

Source changes are allowed only inside `Allowed Changes`.

The agent must:

1. Pull the requested branch with a fast-forward-only update when possible.
2. Record source SHA, branch, environment when relevant, and initial worktree status.
3. Read this protocol and its full ACTIVE task.
4. Modify only explicitly allowed paths.
5. Run required tests.
6. Report blocked/not-run validation truthfully.
7. Inspect the final diff.
8. Stage only paths permitted by the Completion Commit Contract.
9. Commit/push only when the ACTIVE task requires it and the environment supports it.

### TEST_ONLY

No source modification is allowed.

Do not modify implementation, existing tests, assertions, schemas, package versions, build scripts, CI, or release metadata to make failures disappear.

Allowed writes are limited to report/artifact paths explicitly listed by the ACTIVE task and deletion of that ACTIVE task itself.

### REVIEW_ONLY

Read-only review of source, diffs, logs, tests, and reports. A review report may be created only when the ACTIVE task explicitly permits it.

## Start-of-task protocol

Run or resolve the equivalent of:

```sh
git pull --ff-only
git rev-parse HEAD
git branch --show-current
git status --short
```

If the worktree is already dirty, preserve the user's existing changes. Never reset, clean, stash, overwrite, or delete them unless the ACTIVE task explicitly authorizes that action.

## Scope discipline

Every ACTIVE task must contain:

- Goal
- Context
- Allowed Changes
- Forbidden Changes
- Required Work
- Required Tests
- Acceptance Criteria
- Result / Report Contract
- Completion Commit Contract

Anything outside `Allowed Changes` is read-only.

Separate defects discovered during the task must be reported, not opportunistically fixed.

## Testing states

Use only:

- `PASS` — executed and met expectation.
- `FAIL` — executed and did not meet expectation.
- `PARTIAL` — only part could be verified.
- `SKIP` — intentionally not applicable.
- `BLOCKED` — required but impossible because of a concrete environment/platform/quota/credential/dependency/permission blocker.
- `NOT RUN` — not executed; reason required.

Never turn SKIP, BLOCKED, PARTIAL, or NOT RUN into PASS.

## Secrets

Never commit or report:

- API keys or bearer tokens
- Authorization headers
- cookies
- credential-file contents
- signed URL queries
- secret-bearing local paths
- raw third-party errors containing secrets

Use `[REDACTED]` when needed. Recording `credential: PRESENT` is acceptable.

## Commit contract

Before committing:

```sh
git status --short
git diff --cached --name-only
```

The staged paths must exactly match the ACTIVE task's Completion Commit Contract.

Do not commit unrelated user changes, another agent's task, or files outside the whitelist.

A completion commit normally contains only:

- requested implementation and/or report files;
- deletion of that agent's ACTIVE task;
- nothing unrelated.

## ACTIVE lifecycle

1. ChatGPT or the user creates an ACTIVE task on GitHub.
2. User sends a short trigger to the target agent.
3. Agent pulls the target branch and reads this permanent protocol plus its own ACTIVE file.
4. Agent executes only that task.
5. Agent persists any required result/report.
6. Agent deletes only its own ACTIVE file.
7. Agent commits/pushes allowed changes when required.
8. User tells ChatGPT the agent is finished.
9. ChatGPT reads GitHub directly and determines the next task.

## Reporting contract

Durable reports should include:

- source commit;
- branch and environment when relevant;
- work actually performed;
- exact tests/scenarios executed;
- PASS/FAIL/PARTIAL/SKIP/BLOCKED/NOT RUN states;
- observable evidence;
- known limitations;
- files changed;
- result commit SHA when applicable;
- recommended next action without performing out-of-scope work.

Do not include private chain-of-thought. Observable evidence and concise technical rationale are enough.

## dsh-crew project-specific policy

```text
Repository: Ran-sh/dsh-crew
Default branch: main
Package manager: pnpm 10 (pnpm-lock.yaml is authoritative)
Primary source: src/
Built/runtime assets: lib/ and generated client output as defined by repository scripts
Tests: test/*.test.mjs
Build: pnpm run build:client
Primary deterministic test command: node --test test/*.test.mjs
CI: .github/workflows/ci.yml (Linux deterministic job + Windows path/Git resolver job)
Dedicated typecheck command: none currently defined; do not invent one
Dedicated lint command: none currently defined; do not invent one
Result/report directory: docs/agent-results/
```

### Protected / sensitive areas

Unless an ACTIVE task explicitly allows them, treat these as read-only:

- `~/.config/dsh-crew/` and all DSH/provider credential storage
- user API keys, tokens, environment secrets, signed URLs, cookies
- `.github/workflows/**`
- `package.json`, lockfiles, version/release metadata
- installer/release behavior
- user workspaces outside the task's explicitly designated disposable test repository

### Branch / PR policy

- Do not push directly to `main` unless an ACTIVE task explicitly authorizes it.
- Prefer a feature/fix branch and an existing or new PR for source changes.
- Do not force-push, rebase published history, reset, or rewrite unrelated commits unless explicitly authorized.
- Respect the branch named in `Source Branch` and the task's completion contract.

### Required implementation validation

Unless an ACTIVE task narrows or expands the matrix, implementation work should consider:

- `node --test test/*.test.mjs`
- `pnpm run build:client`
- the relevant GitHub Actions checks

Platform-specific tests must run on the platform they actually validate; do not claim a Windows-only behavior is verified by Linux merely because a helper function was unit-tested there.

### Real DSH / provider validation

- Use disposable Git repositories for coding-worker runtime tests; do not ask test workers to edit the dsh-crew source checkout.
- Use only provider/model configuration already authorized in DeepSeek Harness unless the ACTIVE task explicitly permits a configuration change.
- Never print or persist credentials.
- Hub and Standalone are separate execution paths and must be reported separately when both matter.
- Standalone may require `DEEPSEEK_API_KEY`; if it is not already available and authorized, mark that scenario SKIP or BLOCKED as appropriate rather than fabricating credentials.
- Session-level `dsh_worker_config` changes are allowed only when the ACTIVE task says so and should be reset after the test group.

Per-task model/provider details belong in ACTIVE tasks, not this permanent protocol.
