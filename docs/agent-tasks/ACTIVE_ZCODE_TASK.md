Protocol: Agent Handoff Protocol v1
Agent: ZCODE
Mode: IMPLEMENT
Source Branch: ops/opencode-go-catalog-remediation
Source Commit: LATEST
Result Path: docs/agent-results/zcode-opencode-go-catalog-remediation.md
Delete Active Task On Completion: YES

# Goal
Remediate the diagnosed local OpenCode Go model-catalog truncation, verify that DSH exposes the built-in MiMo/Qwen models again, and close the previously BLOCKED T3 coverage with two real disposable-repo worker runs if the environment supports them.

# Context
The preceding TEST_ONLY diagnosis proved `LOCAL_MODELS_OVERRIDE`:
- `~/.dsh/settings.yaml` contains `llm-pi-ai.providers.opencode-go.models: [deepseek-v4-flash, deepseek-v4-pro]`.
- Installed `@earendil-works/pi-ai@0.82.1` has a 16-model built-in `opencode-go` catalog including `mimo-v2.5`, `mimo-v2.5-pro`, `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`.
- The live Crew catalog exposes exactly the two locally overridden DeepSeek IDs.
- `dsh-crew` source is not the cause.

The running Hub plugin may still be the older installed revision `80db87a`; do NOT update packages/plugins in this task. That revision already supports configured flash/pro provider+model priority through the live Harness catalog, so it is sufficient for this narrow T3 verification.

# Allowed Changes
Outside the repository:
1. Create a backup of `~/.dsh/settings.yaml`.
2. Modify ONLY the `models` key under `llm-pi-ai.providers.opencode-go` by removing that key/list entirely. Preserve `displayName`, `apiKeyEnv`, `api`, `baseURL`, all credentials/references, all other providers, and especially `opencode-go-muse` unchanged.
3. Restart ONLY the existing DSH web process/service needed for `127.0.0.1:3080` to reload settings. Do not install/update packages.
4. Temporarily modify `~/.config/dsh-crew/config.json` only as needed to select the two test models. Before doing so, record whether the file existed and preserve an exact backup. At the end, restore the original file byte-for-byte (or restore non-existence if it did not exist).
5. Session-scoped `dsh_worker_config` overrides are allowed for test execution and must be reset afterward.
6. Disposable temporary Git repositories outside the dsh-crew checkout are allowed and must be removed after testing.

Inside the repository:
- Write only `docs/agent-results/zcode-opencode-go-catalog-remediation.md`.
- Delete only `docs/agent-tasks/ACTIVE_ZCODE_TASK.md` on completion.

# Forbidden Changes
- No changes to dsh-crew source, tests, package metadata, lockfiles, CI, release metadata, README, docs other than the result report.
- Do not edit or print credential values, `.credentials.yaml`, API keys, bearer tokens, cookies, Authorization headers, or signed URLs.
- Do not change `api`, `baseURL`, `apiKeyEnv`, or provider IDs in `~/.dsh/settings.yaml`.
- Do not update DSH, pi-ai, dsh-crew plugin packages, or the running Hub plugin revision.
- Do not add a hand-written expanded `models:` list as the remediation. The desired fix is to remove the explicit override and let the installed built-in catalog supply per-model metadata/protocol information.
- Do not read another Agent's ACTIVE file.
- Do not touch `fix/opencode-go-public-model-catalog`; that experimental branch is not part of this task.

# Required Work
## A. Preflight
1. Pull `ops/opencode-go-catalog-remediation` with fast-forward only when possible.
2. Record actual source SHA, branch, OS, Node, pnpm, DSH version, current Hub reachability, and current loaded dsh-crew plugin revision if observable.
3. Confirm the repository worktree is clean before making allowed report/task changes.
4. Read `docs/agent-workflow.md`, then this complete ACTIVE task.

## B. Safe local remediation
1. Inspect only the shape needed to confirm `llm-pi-ai.providers.opencode-go.models` still exists and is exactly the diagnosed two-model override. Never print secret values.
2. Make a timestamped backup of `~/.dsh/settings.yaml` and record the backup path without revealing secret-bearing contents.
3. Remove only the `models` key under `llm-pi-ai.providers.opencode-go` using a YAML-aware edit if practical; otherwise use a narrowly scoped edit and validate the resulting YAML parses successfully.
4. Verify all other keys under `opencode-go` remain present and `opencode-go-muse` is unchanged.
5. Restart only the existing DSH web process/service on port 3080 using the already-installed environment. Do not install/update anything.
6. Wait for `/_dsh/dsh-crew/ping` to return healthy.

If the edit cannot be made safely, restore the settings backup and mark remediation BLOCKED. If DSH cannot restart, report the exact blocker; do not perform unrelated process/package changes.

## C. Catalog verification
After restart, GET `/_dsh/dsh-crew/models` and record secret-free evidence.
PASS requires:
- provider `opencode-go` is present;
- at least one `mimo-*` model is present;
- at least one `qwen*` model is present;
- `deepseek-v4-flash` and `deepseek-v4-pro` remain present;
- catalog response is not reduced to the former two-model override.
Record exact available MiMo/Qwen IDs and counts. Do not require the public endpoint count to match the installed built-in count.

## D. Real T3 closure — MiMo + Qwen
Only continue if C passes.

1. Snapshot `~/.config/dsh-crew/config.json` exactly (existence + bytes/hash) before temporary priority changes.
2. Temporarily ensure Hub worker routing uses `worker_provider_mode=follow-dsh` and configure model priorities so the two runs are forced to exact live-catalog IDs:
   - MiMo run: `opencode-go / mimo-v2.5`
   - Qwen run: `opencode-go / qwen3.7-max`
   If either exact ID is absent after remediation, choose another exact MiMo/Qwen ID from the installed live catalog and state why. Never invent an ID.
3. Use session-scoped `dsh_worker_config` with Hub mode, no escalation, no automatic review, and `preset_flash=cordis`, `preset_pro=cordis` so the Windows terminal limitation of `minimal` does not invalidate the coding evidence.
4. For each model, create a fresh disposable Git repository containing a tiny deterministic Node test (for example export `VALUE=1`, test expects `VALUE===2`), commit baseline, then dispatch a coding worker to make the minimal change and run the test.
5. For each run record:
   - workflow id and real Hub attempt id;
   - returned provider/model/selection_source;
   - terminal phase/status;
   - candidate changed files / workspace diff evidence;
   - worker delivery metadata;
   - actual deterministic test result.
6. PASS for each family requires returned metadata proves the intended `opencode-go` MiMo/Qwen model was used AND the disposable repository has the correct code change with real tests PASS.
7. A model/protocol/provider execution failure is FAIL or BLOCKED based on observable cause. Do not change `api`, `baseURL`, provider protocol, credentials, package versions, or model metadata to force a pass.

## E. Restore temporary state
1. Restore `~/.config/dsh-crew/config.json` exactly to the pre-test bytes/existence.
2. Call `dsh_worker_config(reset=true)`.
3. Remove disposable repos created by this task only.
4. Verify the dsh-crew checkout has no source/test/config changes.
5. Keep the intended `~/.dsh/settings.yaml` remediation in place if B+C succeeded. Do NOT restore the bad two-model `models:` override after successful verification.

# Required Tests / States
Use only PASS / FAIL / PARTIAL / SKIP / BLOCKED / NOT RUN.
Report separately:
- R1 settings remediation
- R2 DSH restart/health
- R3 catalog restored
- R4 MiMo real worker
- R5 Qwen real worker
- R6 temporary Crew config restored
- R7 repository safety / secrets

# Acceptance Criteria
Overall `REMEDIATED — T3 PASS` only if R1-R7 are PASS and both MiMo and Qwen real worker runs pass.
Use `REMEDIATED — T3 INCOMPLETE` if the catalog is fixed but one/both model executions are BLOCKED/PARTIAL for an external/environment reason.
Use `NOT REMEDIATED` if the catalog remains truncated or the settings change cannot be safely applied.

# Result / Report Contract
Write `docs/agent-results/zcode-opencode-go-catalog-remediation.md` with:
- source/result SHAs;
- environment;
- pre/post catalog evidence;
- exact non-secret local config shape changed (key names only, never credential values);
- backup path(s);
- R1-R7 table;
- exact MiMo/Qwen provider/model IDs and workflow/attempt IDs;
- PASS/FAIL/BLOCKED evidence;
- confirmation that temporary Crew config was restored exactly;
- files changed in repo;
- final verdict and recommended next action.

# Completion Commit Contract
Stage and commit ONLY:
- `docs/agent-results/zcode-opencode-go-catalog-remediation.md`
- deletion of `docs/agent-tasks/ACTIVE_ZCODE_TASK.md`

Commit and push to `ops/opencode-go-catalog-remediation`. Do not merge anything.

After push, return only:
- Source Commit SHA
- Result Commit SHA
- R1-R7 summary
- exact MiMo/Qwen models tested
- blockers/failures if any
- Verdict
- Report Path
