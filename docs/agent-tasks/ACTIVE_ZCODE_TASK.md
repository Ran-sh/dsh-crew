Protocol: Agent Handoff Protocol v1
Agent: ZCODE
Mode: TEST_ONLY
Source Branch: fix/v0.2-runtime-hardening
Source Commit: LATEST
Result Path: docs/agent-results/zcode-runtime-hardening-real-env-report.md
Delete Active Task On Completion: YES

# Goal

Independently validate the real DSH runtime behavior of the v0.2 runtime-hardening branch after deterministic Linux/Windows CI passed. This is a verification task only. Do not repair failures.

# Context

The runtime hardening implementation was last changed at:

`15859546ef31f5dc49fc17075a7f80f7d509b54a`

Later commits on this branch add only testing/protocol documentation. Record the actual branch HEAD you test.

Draft PR: `Ran-sh/dsh-crew#1`.

Deterministic GitHub Actions has already passed on Linux and Windows for the runtime-hardening code. This task covers behavior CI cannot prove: real DSH Hub sessions, actual provider/model selection, cancellation, timeout, workflow metadata, reviewer behavior, worktree isolation, and optional Standalone compatibility.

A legacy root file `CODEX_TEST_RUNTIME_HARDENING.txt` may exist on the branch. It is superseded by this ACTIVE task for ZCode. Do not execute it as a separate task.

## Provider / model constraints for this test

- The tester/orchestrator should use the **OpenCode Go plan's Muse** environment when that is the available authorized tester environment.
- DSH worker-model validation must use the **existing OpenCode Go API/provider already configured in DeepSeek Harness**.
- For worker-model coverage, use model IDs actually advertised by the live DSH catalog that belong to the **MiMo** and **Qwen/千问** families. Do not invent model IDs.
- MiMo/Qwen are worker/reviewer models for these tests; do not silently substitute them as the main tester model.
- Do not rewrite provider credentials, global priorities, API keys, or `~/.config/dsh-crew/config.json` just to make a case pass.
- If the required provider/model family is unavailable under the existing authorized configuration, mark the case `BLOCKED` and state the reason.
- Standalone is a separate DeepSeek Official compatibility path. Run it only if an authorized `DEEPSEEK_API_KEY` is already present. Otherwise mark that case `SKIP`.

# Allowed Changes

Inside the repository, only:

- `docs/agent-results/zcode-runtime-hardening-real-env-report.md`
- deletion of `docs/agent-tasks/ACTIVE_ZCODE_TASK.md` on completion

Outside the repository, you may create disposable temporary Git repositories needed for runtime tests.

Session-scoped `dsh_worker_config` changes required by this task are allowed. Reset them at the end.

# Forbidden Changes

- Any source file under `src/`, `lib/`, `scripts/`, `agents/`, `commands/`, `codex/`, or `statusline/`.
- Existing tests or assertions.
- `.github/workflows/**`.
- `package.json`, `pnpm-lock.yaml`, version/release metadata.
- README files or permanent protocol/templates.
- DSH/provider credentials or global model/provider configuration.
- The user's normal project workspaces.
- PR merge/rebase/reset/force-push operations.
- Any fix intended to make a failing scenario pass.
- Any other Agent's ACTIVE task.

If you discover a product bug, document it in the report and continue with independent scenarios when safe. Do not repair it.

# Required Work

## 1. Start-of-task protocol

1. Pull `fix/v0.2-runtime-hardening` with fast-forward-only semantics.
2. Read `docs/agent-workflow.md` completely.
3. Read this ACTIVE task completely.
4. Record:
   - `git rev-parse HEAD`
   - current branch
   - `git status --short`
   - OS
   - Node version
   - pnpm version
   - DSH version
   - tester/orchestrator environment/model
5. If the repository worktree is already dirty, do not reset/stash/clean it. Report the condition. If the dirtiness would make the test unreliable, mark affected cases `BLOCKED`.

## 2. Deterministic preflight

Run when the local environment supports it:

- `pnpm install --frozen-lockfile`
- `node --test test/*.test.mjs`
- `pnpm run build:client`

Do not edit anything if a command fails. Record the exact outcome.

## 3. Live DSH configuration evidence

With DSH Hub available, read `dsh_worker_config` without changing it first.

Record, with secrets removed:

- `hub_reachable`
- effective/default tier or role policy
- collaboration mode
- escalation setting
- effective flash/worker and pro/strong selections when reported
- exact OpenCode Go provider id visible to DSH
- exact MiMo-family model id(s) visible
- exact Qwen-family model id(s) visible
- any provider-resolution error

Do not infer model IDs from memory. Use live catalog/config evidence.

## 4. Disposable test repository

Create a temporary Git repository outside the dsh-crew checkout for coding-worker tests.

Use a tiny deterministic Node fixture, for example:

- `value.mjs` exports `VALUE = 1`
- `value.test.mjs` expects `VALUE === 2`
- commit the initial baseline

Use a fresh repo/copy for cases where isolation between runs matters.

Never ask a worker to modify the dsh-crew source checkout.

# Required Tests

Classify every case using only `PASS`, `FAIL`, `PARTIAL`, `SKIP`, `BLOCKED`, or `NOT RUN`.

## T1 — Hub blocking worker / default model

1. Reset session and set Hub mode with balanced collaboration, no escalation, no automatic review.
2. Run `dsh_run_worker(role="worker", cwd=<fresh disposable repo>, ...)` for the tiny change and test.
3. Verify:
   - workflow terminates successfully;
   - child attempt has a real Hub attempt id;
   - exact provider/model/selection_source are returned;
   - candidate exists and matches actual Git changes;
   - worker delivery includes Diff / Tests / Risks and real PASS evidence;
   - the primary dsh-crew checkout is not modified by the worker.

## T2 — Legacy model-class hint preservation

Use fresh disposable repos.

A. Run `role="worker", tier="flash"`.
B. Run `role="worker", tier="pro"`.

Verify:

- both remain role=worker;
- tier acts as a model-class hint only;
- when distinct cheap/strong selections exist, the `pro` call does not collapse to the flash/cheap slot;
- returned provider/model/selection_source match the live policy.

If policy intentionally maps both to the same model, `PASS` is allowed only with evidence explaining that policy result.

## T3 — MiMo / Qwen worker coverage

Without editing global priorities:

- obtain at least one successful workflow whose metadata proves use of a MiMo-family model, if currently selectable;
- obtain at least one successful worker or reviewer workflow whose metadata proves use of a Qwen-family model, if currently selectable;
- verify actual file/test evidence in disposable repos.

If a family is visible but cannot be selected under the existing policy, mark `BLOCKED` and explain exactly why.

## T4 — Review pipeline and reviewer non-mutation

1. Reset session to Hub + review pipeline, automatic review enabled, escalation disabled.
2. Run a successful coding worker in a fresh disposable repo.
3. Verify worker + reviewer child attempts belong to the same workflow.
4. Record exact provider/model for both.
5. Verify review metadata and normalized verdict exist.
6. Verify reviewer does not mutate the implementation candidate.
7. If reviewer mutation is detected, an `approved` result must not remain a green approval; expect invalidation/request_changes semantics.

## T5 — Async spawn / status / result parity

1. Reset to Hub, balanced, no review, no escalation.
2. `dsh_spawn_worker` on a fresh disposable repo.
3. Record returned `wf-*` id.
4. Observe `dsh_worker_status` while queued/running when possible.
5. Use `dsh_worker_result(job_id=<wf-id>, wait_seconds=...)` until terminal.
6. Verify the final semantic contract matches blocking execution: phase/status, candidate, child attempt metadata, provider/model, and delivery evidence.

## T6 — Real cancellation reaches the active Hub attempt

1. Reset to Hub, balanced, no review, no escalation.
2. Spawn a harmless task that runs a long command (for example a 60-second Node sleep) before completion.
3. Once the workflow is running, cancel the `wf-*` id.
4. Verify:
   - workflow becomes terminal `cancelled`;
   - no escalation/reviewer starts afterwards;
   - the underlying real `hub-*` attempt/session is stopped;
   - the wrapper is not merely reporting cancellation while the worker keeps running.

## T7 — Attempt timeout cancels before retry

1. Reset to Hub, balanced, `default_timeout_seconds=8`, escalation disabled, automatic review disabled.
2. Run/spawn a harmless command that sleeps well beyond 8 seconds.
3. Verify:
   - the real attempt is stopped on timeout;
   - `timed_out=true` appears when exposed by metadata;
   - workflow reaches the appropriate terminal failure state;
   - no overlapping second worker exists.

Use Hub session state as evidence when available.

## T8 — Escalation policy and latest candidate

1. Reset to Hub, balanced, escalation enabled, automatic review disabled.
2. Confirm the session report shows escalation enabled.
3. Do not corrupt provider/model configuration to force failure.
4. If a natural safe partial/failure occurs, verify:
   - next attempt uses the stronger model policy;
   - candidate is recaptured after the latest attempt;
   - final candidate reflects the latest worker state.
5. If no safe natural escalation occurs, mark this scenario `NOT RUN` and state that forced destructive/expensive failure was intentionally avoided.

Important stale-candidate assertion: if latest candidate capture fails, final `candidate_available` must be false; an earlier attempt's candidate must not be presented as final, and the worktree must be retained for recovery.

## T9 — Standalone compatibility

Only if an authorized `DEEPSEEK_API_KEY` is already present:

1. Reset session to standalone, balanced, escalation disabled.
2. Run one tiny worker task in a disposable repo.
3. Verify completion, standalone attempt metadata, and real Git/test result.
4. Do not expect OpenCode Go/MiMo/Qwen on this path; it is DeepSeek Official compatibility.

If credential is absent, mark `SKIP`.

## T10 — Session reset and safety

1. Call `dsh_worker_config(reset=true)`.
2. Verify session settings return to defaults.
3. Verify the dsh-crew source checkout has no test-created source modifications.
4. Verify no API key/token/credential content appears in the report.
5. Remove only disposable temp repos you created and can positively identify.

# Acceptance Criteria

- No source code, existing tests, CI, package metadata, or global provider credentials are changed.
- Every T1–T10 case has one allowed protocol status and concrete evidence/reason.
- Workflow/attempt IDs and provider/model metadata are recorded where relevant.
- Real Git/test evidence is used for coding-worker success; model prose alone is not accepted as proof.
- Cancellation and timeout are checked against the underlying Hub session when possible.
- MiMo/Qwen IDs are taken from the live catalog, never invented.
- Secrets are redacted.
- Session configuration is reset at the end.
- The result report is durable in GitHub.

# Result / Report Contract

Create:

`docs/agent-results/zcode-runtime-hardening-real-env-report.md`

Use this structure:

```text
# DSH Crew Runtime Hardening — ZCode Real Environment Test Report

## Source
- Source Branch:
- Source Commit SHA:
- Runtime hardening baseline commit: 15859546ef31f5dc49fc17075a7f80f7d509b54a

## Environment
- OS:
- Node:
- pnpm:
- DSH:
- tester/orchestrator:
- Hub reachable:
- OpenCode Go provider id:
- MiMo model id(s):
- Qwen model id(s):
- standalone credential: PRESENT / ABSENT (never print value)

## Preflight
- PASS/FAIL/PARTIAL/SKIP/BLOCKED/NOT RUN — pnpm install --frozen-lockfile — evidence/reason
- ...

## Results
| Case | Status | Provider / Model | Workflow / Attempt IDs | Evidence | Notes |
|---|---|---|---|---|---|
| T1 Hub blocking | | | | | |
| T2 tier hint | | | | | |
| T3 MiMo/Qwen | | | | | |
| T4 review pipeline | | | | | |
| T5 async parity | | | | | |
| T6 cancellation | | | | | |
| T7 timeout | | | | | |
| T8 escalation | | | | | |
| T9 standalone | | | | | |
| T10 reset/safety | | | | | |

## Failures / Blockers
For each non-PASS item: reproduction/scenario, expected behavior, actual behavior, IDs, provider/model/selection_source, relevant phase/status/error/timed_out flags, and a concise secret-redacted log excerpt.

## Repository Changes
List only the allowed report + ACTIVE deletion.

## Verdict
Choose one:
- READY FOR MERGE
- NOT READY — FIX REQUIRED
- INCOMPLETE — BLOCKED BY ENVIRONMENT

## Recommended Next Action
Recommendation only; do not perform source fixes.
```

# Completion Commit Contract

Before committing, inspect:

```sh
git status --short
git diff --cached --name-only
```

The final completion commit may contain **only**:

- `docs/agent-results/zcode-runtime-hardening-real-env-report.md`
- deletion of `docs/agent-tasks/ACTIVE_ZCODE_TASK.md`

Do not stage or commit any other path, including disposable test repos, source changes, the legacy root test prompt, other protocol files, or unrelated user changes.

Push the completion commit to `fix/v0.2-runtime-hardening` if Git write access is available. If push is unavailable, mark result persistence as `BLOCKED` and do not claim success.

After the completion commit/push, stop. Do not fix failures and do not merge PR #1.
