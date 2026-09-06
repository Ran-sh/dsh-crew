# Agent Workflow

Based on Ran-sh/chatgpt_workflow v1.8.0
(`5e4239aa3a30e3a1738dcdb79e7d341ea8bca458`), with repository-specific guidance.

## 1. Select the entry mode

**Direct user work:** complete the current request under the root `AGENTS.md`.
An old or missing ACTIVE task does not replace the request. Do not create an ACTIVE
task, demand an executor trigger, or stop at a plan merely because this file exists.

**Explicit handoff:** the user asks to execute `ACTIVE_TASK.json` or invokes this
handoff protocol. Only then apply the contract lifecycle below. The contract is
the handoff's task specification; it cannot override higher-priority instructions.
If it is missing, invalid or conflicts with the request, report the blocker instead
of inferring a replacement task from issues, chat history or old results.

The canonical trigger remains: `Execute ACTIVE_TASK.json according to Agent Workflow Protocol.`
Executor identity (Codex, ZCode, Claude Code, DSH or another host) never grants
permissions or changes the mode.

## 2. Handoff contract

Read `docs/agent-tasks/ACTIVE_TASK.json`. An optional `ACTIVE_TASK.md` is a
non-authoritative companion; JSON wins within the handoff.

| Mode | Authorized writes |
| --- | --- |
| IMPLEMENT | Explicit `allowed_changes` only |
| TEST_ONLY | Reports under `docs/agent-results/**` only |
| REVIEW_ONLY | Reports under `docs/agent-results/**` only |

Honor `forbidden_changes`; unlisted paths remain read-only. Completion may remove
ACTIVE files only as expressly permitted by the contract. The `result_contract`
must be under `docs/agent-results/**` and included in `allowed_changes` and
`completion_commit_contract`. The completion contract must also include
`docs/agent-tasks/ACTIVE_TASK.json`, plus its companion when metadata says one exists.

## 3. Execute and hand back

1. Inspect `git status --short`, `git branch --show-current` and `git rev-parse HEAD`.
   Preserve dirty worktrees. Fetch, switch and fast-forward only as authorized;
   do not reset, stash, clean, rebase, overwrite or force-push unrelated changes.
2. Validate the active contract:
   `node .agent-workflow/validator/validate-contract.mjs task docs/agent-tasks/ACTIVE_TASK.json`.
3. Resolve `source_branch` and `source_commit`. `LATEST` means the fetched current
   tip of the named branch; record the exact executed SHA. An explicit SHA is an
   immutable pin. Confirm the executing checkout's HEAD matches that resolved SHA
   before starting work; if it cannot be made to match without violating worktree
   safety, stop and report the mismatch. Do not invent other symbolic semantics.
4. Begin a Result Contract v2 (`schema_version: 2`) with real
   `timeline.started_at`. Execute the authorized task, not unrelated follow-ups.
5. Run every contract-required validation. Record actual commands, evidence, changed
   files, blockers and acceptance-criterion outcomes.
6. Write `timeline.completed_at`, then run
   `node .agent-workflow/validator/validate-contract.mjs result <result-json> --stamp`.
   Only the validator writes `result_validation`; never fabricate its success.
7. Check acceptance and stamped evidence. Normal revalidation uses the same result
   command without `--stamp`; repeat after a relevant result change, not ritualistically.
8. If completion is real and `delete_active_task_on_completion` is true, remove
   the permitted ACTIVE files. Commit/push only allowed completion paths with the
   user's authority. Then stop this handoff; do not self-assign a new task.

Use only `PASS`, `FAIL`, `PARTIAL`, `SKIP`, `BLOCKED`, `NOT RUN`.
Unexecuted or partial checks are never PASS. A review finding is evidence, not
permission to repair in REVIEW_ONLY or TEST_ONLY mode.

All v2 timestamps use second-precision ISO 8601 with timezone, e.g.
`2026-09-06T10:30:00+08:00`; no milliseconds. Ordering is:
`started_at <= completed_at <= result_validation.validated_at`.
A new v2 result without stamped validation is incomplete. Historical v1 results
(without `schema_version`) remain valid; do not rewrite them just to upgrade format.

The orchestrator reads committed results and repository state directly when tools
allow it; do not require the user to paste reports unnecessarily. Create handoffs
for genuinely separate execution/environment work, not every repository edit.

## 4. Choose proportionate validation

The contract's explicit matrix wins. Otherwise select tests by affected behavior:

| Change | Starting evidence |
| --- | --- |
| Instructions/templates | Link/schema checks and affected installer/dispatcher tests |
| JavaScript logic | Focused `node --test test/<affected>.test.mjs`; adjacent integration tests when boundaries change |
| Client UI | `pnpm run build:client`; `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.client.json`; affected browser journey |
| Lifecycle/storage/security | Ownership, failure, recovery and disposable-fixture tests; independent review under live policy |
| Cross-cutting or release acceptance | CI-equivalent full matrix in `.github/workflows/ci.yml` |

CI uses Node 22 and pnpm 10 with `pnpm-lock.yaml`. No lint script is configured.
The broad test command is `node --test test/*.test.mjs`; it is not a prerequisite
for every wording change. Once appropriate checks pass, broaden or repeat only
for new changes, failures or unresolved concerns. Do not claim Windows verification
from Linux-only runs or replace behavioral tests with wording-matching tests.

## 5. Runtime and external-effect boundaries

DSH Crew is a plugin on official Harness. Production dispatch uses the Crew-owned
`dsh-crew` profile on 3210 (`mode=auto|hub`); 3080 is the official frontend.
Standalone is legacy/internal compatibility, not a selectable production mode.
Test its SDK path separately only when that path is in scope.
Crew's runtime evidence schema is a product API; the Result Contract v2 above is
only for explicitly invoked external handoffs.

- Never install, update, register, unlink, repair or mutate `~/.dsh`, its web
  profile or credential stores. Do not read/copy official credentials for tests.
- Runtime tests use a disposable or explicitly authorized Crew-owned `DSH_HOME`
  (normally `~/.config/dsh-crew/harness`). Coding/history tests use disposable
  repositories and records, not the user's source checkout or conversations.
- Use only authorized provider/model configuration. Missing credentials or an
  optional legacy SDK are SKIP/BLOCKED, not permission to invent or obtain them.
- Installer preparation does not restart services. Activation and external writes
  (push, merge, release, publication, account or credential changes) need authority.
  A validation verdict does not grant it.
- Never expose secrets, cookies, signed URLs, raw provider payloads or private
  reasoning. Preserve required evidence without copying unnecessary transcripts.
- Apply the configured DSH operator decision gate when a selected capability
  becomes unavailable. Do not bypass manual/disabled roles or review.

## 6. Workflow ownership

Installation does not create an ACTIVE task. Removal must refuse while one exists.
`docs/.agent-workflow-install.json` distinguishes generated files from
migrated/adopted files. Only manifest-owned generated paths are automatically
removable; adopted workflow files require explicit review. This protocol is
development infrastructure, not a product runtime dependency.
