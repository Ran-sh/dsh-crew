---
name: dsh-crew
description: "DSH Crew worker/reviewer dispatch (dsh-crew MCP tools): dispatch coding work, configure models and review gates, and maintain session history. Load only when the operator asks to use dsh-crew."
---

# DSH Crew

**On demand only.** Do not dispatch Crew work because it might help — dispatch
because the operator asked for it in this turn ("use dsh-crew", "call dsh-crew",
"派给 crew", and the like). Crew is a capability the operator chooses, not a
standing policy, so nothing here should shape how you work until it is invoked.
That is the whole point of it living in a skill rather than in a global
instruction file: the host's own way of working stays untouched.

Once invoked, this is the operating guide.

## What it is

A plugin on the official DeepSeek Harness. A hub on 3210 dispatches jobs to
worker/reviewer models, optionally in an isolated git worktree, and returns a
compact structured result. Codex, ZCode and Claude Code all reach it through the
same `dsh-crew` MCP server, so the behaviour below is identical from any host.

## Tools

| Tool | Use |
|---|---|
| `dsh_run_worker` | dispatch one unit and wait for the result |
| `dsh_spawn_worker` | dispatch and return a workflow id immediately |
| `dsh_worker_status` | list workflows with phase, role, model, tokens |
| `dsh_worker_result` | fetch or wait for one workflow (`wait_seconds`) |
| `dsh_worker_cancel` | cancel a workflow |
| `dsh_worker_config` | read/update session settings: enable dispatch, tier, effort, timeout, presets, policy |

Dispatch takes `task` (make it self-contained — the worker sees nothing else),
`role` (`worker` for implementation, `reviewer` for an independent review pass),
`cwd` (the workspace; defaults to the current project) and `timeout_seconds`.
Use `dsh_spawn_worker` when you have other work to do meanwhile, then
`dsh_worker_result` with `wait_seconds` to collect it.

`dsh_worker_config` with no arguments is the cheapest way to answer "what is
Crew set to right now". Its settings last for the session only; persisted
changes belong in the 3210 panel.

## Reading a result

A result carries a `phase` and, when it did not succeed, a failure code. The
phases are `created`, `queued`, `running`, `verifying`, `escalating`,
`reviewing`, `ready`, `completed`, `failed`, `cancelled`, `interrupted`.

**`phase: failed` does not mean the worker broke.** Most often it means the
workflow's delivery gate rejected the result, and the reason code says which
gate. Read the code before reacting:

| Code | Means |
|---|---|
| `DELIVERY_INCOMPLETE` | the worker returned no change where the contract required one — a reply-only or question-only task lands here, and it is not a defect |
| `TESTS_FAILED` / `TESTS_NOT_RUN` | the worker's own test evidence is failing or absent |
| `REVIEW_CHANGES_REQUESTED` | the reviewer asked for changes; act on them |
| `REVIEW_INCONCLUSIVE` | the review could not reach a verdict |
| `WORKSPACE_MISMATCH` | the worker's changes are not in the workspace the job was meant to touch |
| `TASK_BLOCKED` / `TASK_PARTIAL` | the worker says it could not finish |
| `ATTEMPT_TIMEOUT` / `RUNTIME_FAILURE` / `EXECUTION_FAILED` | the run itself failed |
| `POLICY_REJECTED` | Crew's own policy refused the dispatch; change the request, not the worker |
| `PROVIDER_UNAVAILABLE` / `HUB_INCOMPATIBLE` | no model or no reachable hub |

`terminal_reason: escalation_disabled` is **not** a separate failure — it is the
escalation policy declining to retry after a failure. The failure code above it
is the real reason.

The selection trace names the model actually used and every candidate that was
skipped, with the reason. Reach for it whenever the chosen model is not the one
you expected.

## Choosing what to dispatch

Delegate a bounded, independently verifiable unit when isolation,
specialization, parallel work or independent review earns its cost. Give each
unit its objective, owned files, workspace, constraints and acceptance
evidence. Keep ambiguity, integration, external effects and final communication
yourself. Trivial work stays local.

Continue authorized work after a successful subtask; a returned workflow is a
checkpoint, not the end of the task. If a worker's result is incomplete or its
review asks for changes, that is a task result to act on — not approval.

## Common ways a dispatch surprises you

- **A task that only asks a question fails.** The delivery contract wants a
  change; a reply-only task returns `DELIVERY_INCOMPLETE`. That is the gate
  working, not the worker failing.
- **Isolated workspaces need git.** The default `worktree` isolation fails with
  `NOT_GIT_REPOSITORY` for a non-git workspace rather than silently sharing the
  tree. Use `shared` deliberately if that is what you want.
- **Long tasks need a longer timeout.** `timeout_seconds` is per attempt and
  caps at 7200; the default is far shorter than a real refactor.
- **A worker cannot see your conversation.** Anything it needs must be in
  `task`, in the workspace, or in a file it can read.

## Configuration

Two surfaces, and they are not equivalent:

- **3210** — the full control plane: workflow, model priority, routing, provider
  lifecycle, history, and the peak/off-peak schedule.
- **3080** — the quick surface (sub-agent switch, model priority order). It
  writes through the same config via a restricted key allowlist.

Everything lands in `~/.config/dsh-crew/config.json`. Prefer the panel over hand
editing: the write path validates, and a hand edit can be silently dropped by
the loader.

## Model routing

Worker and reviewer each walk an ordered `{provider, model}` priority list and
take the first admissible candidate; an empty list falls through to Harness
Default. Candidates are skipped when the provider is unhealthy, tombstoned, or
inside a peak window it is blocked for. A `warn` rule keeps the model selectable
and records the advisory in the selection trace.

The **peak/off-peak schedule** (panel → 波峰波谷调度) restricts chosen models by
local wall clock: `block` skips the model during peak so the next candidate
serves the job, `warn` uses it and flags the choice, and an unlisted model is
unrestricted. Defaults mirror DeepSeek's published peak hours.

## Work

`isolation: worktree` is the default: a coding worker runs in a per-job git
worktree and the primary tree is untouched. Non-git workspaces fail with
`NOT_GIT_REPOSITORY` rather than silently sharing the tree; use `shared`
explicitly if that is what you want. Concurrent jobs are capped by
`max_parallel`.

The reviewer gate is `required` by default: an unreviewed change fails. Review
findings and failing tests are results to address, never a reason to bypass the
gate.

## History

Session storage is shared between 3080 and 3210 — clearing one clears both.
Cleanup is scoped by provenance, and the default scope is **Crew-created only**,
so the operator's own conversations survive. `all` removes theirs too; use it
deliberately. Archived batches are restorable from the panel.

## When Crew is unavailable

If a capability needed by a work unit you already dispatched becomes unavailable
or non-callable, **stop and ask**. Do not implement further on that unit, do not
repair or reconfigure Crew, do not silently fall back to doing it yourself.
Perform bounded read-only diagnosis, report the evidence and what already
completed, and wait for the operator to choose: repair Crew and continue through
it, or leave Crew alone and continue with the host agent.

A nonterminal wait is not an outage — keep polling the same workflow rather than
dispatching a duplicate. This gate applies only once Crew has been selected for
a work unit; it does not apply when planning chose local work.

## Host boundaries

- Never install, update, register, unlink, repair or mutate anything under
  `~/.dsh`. Crew's runtime lives in its own `DSH_HOME`.
- Runtime upgrades go through the Crew-owned installer (`dsh-crew update`), never
  through direct pnpm/npm/dsh plugin operations.
- Preparing an upgrade must not restart 3080 or 3210.
- The legacy 3080 bridge must never be used for 3210 lifecycle or rollback.
- Delegation grants no new authority: pushing, publishing, messaging, changing
  credentials or deleting data still need their own authorization.
