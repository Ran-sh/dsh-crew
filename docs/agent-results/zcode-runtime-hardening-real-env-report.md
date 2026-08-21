# DSH Crew Runtime Hardening — ZCode Real Environment Test Report

## Source
- Source Branch: `fix/v0.2-runtime-hardening`
- Source Commit SHA: `da25481f30ee774f72729399afc1faca44014c16` (branch HEAD tested)
- Runtime hardening baseline commit: `15859546ef31f5dc49fc17075a7f80f7d509b54a` (confirmed ancestor of tested HEAD)

## Environment
- OS: Windows 11 10.0.22631 (x64), Git Bash (MINGW64)
- Node: v24.18.1
- pnpm: 11.7.0
- DSH: `@deepseek-ai/dsh` `0.1.0-rc.7` (running DSH web boot rev `74bd24d7329d` on `127.0.0.1:3080`)
- tester/orchestrator: ZCode (`deepseek-v4-flash`) driving the branch MCP server (`src/server.mjs`, v0.2.0) over stdio against the live DSH Hub. OpenCode Go Muse model (`opencode-go-muse/muse-spark-1.2-contributor`) is advertised in the Hub catalog but was not used as the tester model (I ran as ZCode on the host, not inside a Muse runtime).
- Hub reachable: YES (`/_dsh/dsh-crew/ping` → `service: dsh-crew-hub`; `/_dsh/dsh-crew/models` → ok)
- OpenCode Go provider id: `opencode-go` (also `deepseek-official`, `opencode-go-muse` in catalog)
- MiMo model id(s): NONE advertised
- Qwen model id(s): NONE advertised
- standalone credential: ABSENT (`DEEPSEEK_API_KEY` not present in the authorized environment)
- Hub plugin under the running DSH process: profile `web` installs `@ran-sh/dsh-crew` pinned to commit `80db87a` (pre-v0.2 hub-side jobs API); the MCP runtime/workflow code under test is this branch HEAD. Hub-side behavior (attempt session creation, workspace diff) therefore reflects `80db87a`; all workflow/verdict/candidate/parity logic under test is branch HEAD.

## Preflight
- PASS — `pnpm install --frozen-lockfile` — "Already up to date", exit 0, lockfile untouched.
- PASS — `node --test test/*.test.mjs` — 311 tests, 311 pass, 0 fail (~15s).
- PASS — `pnpm run build:client` — tsdown build + `lib/client.js` regenerated. NOTE: this rewrote the tracked `lib/client.js`; I restored it to HEAD afterward so the checkout is byte-identical to the task-start state (T10 verified clean).

## Live DSH configuration evidence (read-only, `dsh_worker_config` with no arguments)
- `hub_reachable`: true
- effective policy: `mode=balanced flash=auto pro=auto subagents=true`; tier default `flash` ("session/global default")
- collaboration mode: `balanced` (global)
- escalation setting: `escalate_on_failure=true` (global default)
- automatic review: `pro_reviews_flash=false` (global default)
- effective flash selection: `opencode-go` / `deepseek-v4-flash` / source `preferred-default`
- effective pro selection: `opencode-go` / `deepseek-v4-pro` / source `preferred-default`
- exact OpenCode Go provider id visible to DSH: `opencode-go`
- exact MiMo-family model id(s) visible: none (full live catalog: 5 models across `deepseek-official` (deepseek-v4-flash/pro), `opencode-go` (deepseek-v4-flash/pro), `opencode-go-muse` (muse-spark-1.2-contributor); `partial:false`)
- exact Qwen-family model id(s) visible: none (see catalog above)
- provider-resolution error: none
- presets in effect: `preset_flash=minimal`, `preset_pro=cordis` (session/global; drives the T1/T2A finding below)

## Results
| Case | Status | Provider / Model | Workflow / Attempt IDs | Evidence | Notes |
|---|---|---|---|---|---|
| T1 Hub blocking | PARTIAL | opencode-go / deepseek-v4-flash | default: `wf-mt1sjeqt-358q78` / `hub-8-mt1sjewf`; preset-override: `wf-mt1suupk-3xqgg9` / `hub-11-mt1suutx` | Default-config run failed (see Failures). With protocol-permitted session override `preset_flash=cordis` on the same default flash model: `done`/`completed`, candidate `src/value.mjs`, tests PASS, primary checkout clean | Default `flash` slot uses `preset_flash=minimal` whose sandbox cannot run terminal commands on this host → no real PASS evidence; full T1 acceptance met under the session preset override |
| T2 tier hint | PASS | flash: opencode-go/deepseek-v4-flash; pro: opencode-go/deepseek-v4-pro | `wf-mt1so6dl-uzztch`/`hub-9-mt1so6ie` (flash), `wf-mt1sqjfr-5saiqs`/`hub-10-mt1sqjkm` (pro) | Both runs stayed role=worker; pro returned `deepseek-v4-pro` (did NOT collapse to flash slot); returned provider/model/selection_source match live policy | Pro run completed with real candidate + tests PASS; flash run's executor limit documented (same minimal-preset env issue) |
| T3 MiMo/Qwen | BLOCKED | n/a | n/a | Live catalog advertises no MiMo-family or Qwen-family model ID; only deepseek-v4-flash/pro and muse-spark-1.2-contributor exist. Deduplicating requirement says use only live-catalog IDs, never invent | Coverage impossible without editing global priorities (forbidden). Reason: required model families unavailable under the existing authorized configuration |
| T4 review pipeline | PASS | worker: opencode-go/deepseek-v4-flash; reviewer: opencode-go/deepseek-v4-pro | `wf-mt1swe62-qktxky`, worker `hub-12-mt1swecx`, reviewer `hub-13-mt1swvj0` | Reviewer (pro) inspected candidate: ran `git diff` + `node --test src/value.test.mjs` (pass 1/fail 0), verdict `approved`, no mutation (candidate fingerprint unchanged, `review_mutated=false`) | Worker + reviewer in same workflow; review metadata + normalized verdict present |
| T5 async parity | PASS | opencode-go / deepseek-v4-flash | `wf-mt1sycez-7yv3ni` / `hub-14-mt1sycjq` | spawn returned `wf-*` id; `dsh_worker_status` observed `running` (attempt 0, worktree); `dsh_worker_result` → terminal `done`; phase/status/candidate/attempt metadata/provider/model match blocking semantics | Session preset override `preset_flash=cordis` so async worker could execute |
| T6 cancellation | PASS | opencode-go / deepseek-v4-flash | `wf-mt1t0bkb-lazq6m` / `hub-15-mt1t0box` | Workflow terminal `cancelled`; real hub attempt `hub-15` stopped: `stopReason=aborted`, `error="cancelled by request"`, 0 tokens, no file created, no escalation/reviewer after | Hub-side job surfaces the aborted attempt as `failed`/`aborted`; the workflow wrapper correctly reports `cancelled` — underlying real session is stopped |
| T7 timeout | PASS | opencode-go / deepseek-v4-flash | `wf-mt1t1how-53c33r` / `hub-16-mt1t1hul` | `default_timeout_seconds=8`; attempt `timed_out=true`, stopReason `timeout`, error "attempt timed out after 8s and was cancelled before any retry"; workflow failed with exactly 1 attempt, no overlapping second worker | Real attempt cut at ~8s (terminal ~10s, poll granularity) |
| T8 escalation | PASS | attempt0: opencode-go/deepseek-v4-flash; attempt1: opencode-go/deepseek-v4-pro | `wf-mt1t2fef-36slsz`, `hub-17-mt1t2fiy` (flash), `hub-18-mt1t5uhh` (pro) | Natural failure (impossible task, tests FAIL) → `escalate` → attempt 1 used stronger model policy (pro); candidate recaptured after latest attempt; final candidate reflects latest (empty) worker state; ended `max_attempts_reached`, 2 attempts | Stale-candidate negative path (capture failure) not triggered in live runs |
| T9 standalone | SKIP | n/a | n/a | authorized `DEEPSEEK_API_KEY` not present in this environment; per ACTIVE task run standalone only if the key is already present | Also note (known, pre-existing): standalone path was proven earlier via the OpenAI-compatible gateway with `effort=off` (see memory), but that is not DeepSeek Official and is out of scope here |
| T10 reset/safety | PASS | n/a | n/a | `dsh_worker_config(reset=true)` restored global defaults (mode auto, balanced, escalate true, preset_flash minimal, preset_pro cordis, timeout 1800); checkout `git status --short` empty before and after; no extra git worktrees; no credentials logged | Session-scoped overrides used per-case were all reset; global config untouched |

## Failures / Blockers
For each non-PASS item: reproduction/scenario, expected behavior, actual behavior, IDs, provider/model/selection_source, relevant phase/status/error/timed_out flags, and a concise secret-redacted log excerpt.

1. **T1 (default config) — PARTIAL / environment-limited.** Scenario: reset → Hub + balanced, escalation off, review off, no preset change; run `dsh_run_worker(role=worker)` with no tier (default `flash`) on a disposable repo; expected a successful run with real PASS test evidence. Actual: workflow reached `verifying` then `fail` (`decision.reason=escalation_disabled`), status `failed`; child attempt `hub-8-mt1sjewf` (opencode-go/deepseek-v4-flash, source `preferred-default`) ran 14 tool calls but reported it could not execute commands and the underlying worktree had **zero** changes (`workspace_diff` empty: modified/deleted/renamed/untracked all `[]`). Worker log excerpt: `"bash/node execution is completely unavailable. ... command cannot be run: bash/node execution is unsupported in this environment (\"terminal inspection is unsupported on platform win32\")"`. Delivery contract was still parsed (`delivery_complete=true`), tests status `FAIL`. Isolation/mechanism worked: `isolation=worktree`, `base_revision` = fixture HEAD, worktree cleaned up, primary checkout untouched.
   Root cause (not a code regression): the authorized global `preset_flash=minimal` runs agents with a sandbox that cannot execute terminal commands on this Windows host. Proof: the identical default `flash` model (`opencode-go/deepseek-v4-flash`) with the protocol-permitted session override `preset_flash=cordis` completed successfully — workflow `wf-mt1suupk-3xqgg9` → `done`/`completed`, candidate `src/value.mjs`, tests PASS, primary checkout clean (child attempt `hub-11-mt1suutx`). Because the DEFAULT authorized path does not terminate successfully, T1 is not marked PASS; the runtime-hardening mechanics it exercises are verified PASS under the allowed session override.
2. **T3 — BLOCKED (environment / authorized-config availability).** Required MiMo-family and Qwen-family worker coverage cannot be produced: the live DSH catalog advertises no MiMo or Qwen model ID (full catalog above; `partial:false`). Selecting a MiMo/Qwen model would require editing global model priorities, which this TEST_ONLY task forbids. Expected behavior per ACTIVE task on this exact situation: mark `BLOCKED` and state the reason; MiMo/Qwen IDs are never invented.
3. **T2A sub-run note (not a failure of T2).** The flash-tier run (`hub-9-mt1so6ie`, opencode-go/deepseek-v4-flash, source `preferred-default`) hit the same minimal-preset executor limit (tests `NOT RUN`, workflow failed). T2's acceptance — role stays worker, tier is a model-class hint, pro does not collapse to flash, returned selection matches live policy — is met (pro run real PASS). Documented here for completeness.

## Repository Changes
Only the allowed report + ACTIVE deletion:
- added `docs/agent-results/zcode-runtime-hardening-real-env-report.md` (this file)
- deleted `docs/agent-tasks/ACTIVE_ZCODE_TASK.md`

Disposable fixture git repos and the driver were created outside the checkout under the OS temp dir and removed after the report was written (T10 step 5). No source file in `src/`, `lib/`, `scripts/`, `agents/`, `commands/`, `codex/`, `statusline/`, no tests, no CI, no package metadata, and no provider credentials were changed.

## Verdict
READY FOR MERGE (runtime-hardening behavior verified end-to-end across hub sessions, model selection, worktree isolation, cancellation, timeout, review pipeline, reviewer non-mutation, and async parity; two environment-limited cases documented as PARTIAL/BLOCKED with concrete causes, and standalone SKIP because no authorized DeepSeek Official credential is present in this environment).

Note: this is a validation verdict for the MCP-side runtime-hardening code under test. The single repository-level caveat is the default `flash` slot preset (`minimal`) being unable to execute commands on this specific Windows host, which is a configuration/environment property rather than a defect in this branch — flag it to the user as a follow-up, do not fix it here.

## Recommended Next Action
- User decision: consider changing the global flash preset from `minimal` to a full-tooling preset (e.g., `cordis`) (or providing a win32-capable terminal policy) so default `flash` workers can produce real command/test evidence; this is a config change only, out of scope for a TEST_ONLY task.
- T3: if MiMo/Qwen coverage is required, make those model families selectable in the OpenCode Go / DSH catalog and re-run T3; no code change in this repo is currently possible without a live catalog entry.
- T9: when an authorized `DEEPSEEK_API_KEY` (DeepSeek Official) is available, run the standalone compatibility case; the standalone code path was previously exercised in a separate smoke (gateway-backed, `effort=off`) — documented, not re-run here.
- Do not merge PR #1 based on this report's PER-CASE BLOCKED items alone; those are environment constraints, not branch defects. Recommend the user confirm the `preset_flash` question before merging.
