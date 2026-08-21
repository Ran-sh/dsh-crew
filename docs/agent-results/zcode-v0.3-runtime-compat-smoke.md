# ZCode v0.3 Runtime Compatibility Contract — Real Environment Smoke Report

## 1. Source
- Test branch: `test/v0.3-runtime-compat-smoke`
- Checked-out HEAD (ACTIVE-only commit, newer): `4c3bfd26814a0d5e654be6625fb4e3c9cf1e257c`
- Exact tested source SHA (from `feat/v0.3-runtime-compat-contract`, confirmed ancestor of tested HEAD): `e8f4e4acd95f6d1f310863d43dfa87434f5bd67d`
- Mode: `TEST_ONLY` (no source/test/config modified; only the report + ACTIVE deletion below)

## 2. Environment
- OS: Windows 11 10.0.22631 (x64), Git Bash (MINGW64)
- Node: v24.18.1; pnpm: 11.7.0
- DSH: `@deepseek-ai/dsh` `0.1.0-rc.7` (shared install; profile scaffold via same binary)
- Existing running Hub/plugin revision (user `web` profile, port 3080): `@ran-sh/dsh-crew` pinned at `80db87a0...` (version 0.1.0-rc.1, legacy generation, `main ./src/hub/index.mjs`, no `/runtime`) — used read-only as the real stale-Hub target
- Disposable current Hub (this task): own DSH profile `v03test` on `127.0.0.1:3210`, plugin symlinked to `D:/Users/48376/Desktop/dsh-crew` (exact tested source; `main ./src/hub/entry.mjs`), removed after testing
- Effective LLM engine: `@earendil-works/pi-ai` `0.82.1`; `@deepseek-ai/dsh-llm-pi-ai` `0.1.0-rc.7`

## 3. Preflight
- PASS — `pnpm install --frozen-lockfile` — already up to date, exit 0
- PASS — `node --test test/*.test.mjs` — **329/329** pass, 0 fail (includes the v0.3 compatibility suites)
- PASS — `pnpm run build:client` — built OK; regenerated `lib/client.js` restored to HEAD (worktree clean)
- Env recorded above; no DSH/plugin/config package updates performed

## 4. Results

| ID | Check | Status | Evidence |
|---|---|---|---|
| R1 | Real stale-Hub classification | **PASS** | Existing `web` Hub (80db87a) is still the old generation. `GET /_dsh/dsh-crew/ping` → 200 `{ok:true,service:"dsh-crew-hub"}`. SOURCE MCP with `DSH_CREW_HUB=http://127.0.0.1:3080`: `dsh_worker_config` → `hub_reachable=true`, `hub_compatible=false`, `hub_compatibility.code=HUB_SERVICE_MISMATCH`. Dispatch attempt (`dsh_spawn_worker`, disposable repo) in BOTH `mode=hub` (`wf-mt2glmdh-33e6j7`) and `mode=auto` (`wf-mt2glmkt-3gj1om`) → workflow `failed`, `error_code=HUB_SERVICE_MISMATCH`, message "DSH workers hub is reachable but incompatible (…). Update/restart the Hub plugin before using Hub execution." Hub `/jobs` before=2 → after=2 (**no new Hub job**); `mode=auto` did **not** fall back to Standalone. Complex dirty-state: the live legacy Hub returns `HTTP 200 + SPA HTML` for the missing `/runtime` route (DSH web SPA fallback), so the probe classifies it `HUB_SERVICE_MISMATCH` rather than the ACTIVE's assumed `HUB_PROTOCOL_MISSING` (that path is covered by deterministic tests with a literal 404). Still fail-closed with a contract code — see Blockers/Failures §9. |
| R2 | Disposable current-Hub profile | **PASS** | Created disposable profile `~/.dsh/profiles/v03test` (scaffolded by `dsh plugin --profile v03test`, base+web-app bundles from the shared store, `@ran-sh/dsh-crew` linked via `link:D:/Users/48376/Desktop/dsh-crew` = exact source). Booted `dsh --profile v03test --host 127.0.0.1 --port 3210`. `GET /ping` → 200 `service=dsh-crew-hub`. `GET /runtime` → 200 `{ok:true, service:"dsh-crew-hub", runtime_version:"0.3.0-dev", protocol_version:1, capabilities:[jobs,jobs-wait,jobs-cancel,roles,attempt-index,model-policy,model-catalog,presets,config]}`. All 6 required capabilities (jobs, jobs-wait, jobs-cancel, roles, attempt-index, model-policy) present. Existing `web` profile untouched. |
| R3 | MCP compatibility report vs current Hub | **PASS** | SOURCE MCP with `DSH_CREW_HUB=http://127.0.0.1:3210`: `dsh_worker_config` → `hub_reachable=true`, `hub_compatible=true`, `hub_compatibility.code=null`, `runtime_version=0.3.0-dev`, `protocol_version=1`, `missing_capabilities=[]`, capabilities match R2. MCP initialize `serverInfo` = `{name:"dsh-crew", version:"0.3.0-dev"}`. |
| R4 | Real current-Hub worker smoke | **PASS** | Disposable git repo `r4-smoke` (src/value.mjs `VALUE=1`, src/value.test.mjs expects `VALUE===2`, baseline committed). SOURCE MCP (session reset → `mode=hub`, balanced, no escalation, no auto review, `preset_flash=cordis`, `preset_pro=cordis`) → blocking `dsh_run_worker(role=worker)` against the disposable Hub. Workflow `wf-mt2gzr72-uerwqx` → `done`/`completed`, decision `accept/verified`; real Hub attempt `hub-1-mt2gzrc6` (provider `opencode-go`, model `deepseek-v4-flash`, `selection_source=preferred-default`, status done); candidate changed `[src/value.mjs]`; outcome `task_status=success`, `tests_status=PASS`, `delivery.complete=true`; worktree isolation, primary clean. Independent replay: clone at base `f04fe41b…`, `git apply` candidate patch, `node --test src/value.test.mjs` → **1 pass / 0 fail, exit 0**. Hub-side `/jobs` on the disposable Hub confirms `hub-1-mt2gzrc6`. |
| R5 | Compatibility cache / transition sanity | **PASS** | Fresh MCP process vs current Hub reported `compatible` immediately with no stale state (R3 first probe); repeated `dsh_worker_config` reads at t0/t3/t13 (last beyond the 10s probe cache window) all `hub_compatible=true, code=null` — cached status is 10s-bounded, not stuck; the R1 stale-hub process (legacy, `HUB_SERVICE_MISMATCH`) and the current-hub processes are separate and never leak `HUB_PROTOCOL_MISSING` into the current-Hub case. R4's fresh process dispatched successfully (additional evidence). No destructive restarts/races created. |
| R6 | Cleanup and safety | **PASS** | Stopped only the disposable DSH (PID 12600 on 3210, port released, process gone). Removed disposable profile `v03test`, temp repos/driver/logs/launcher. `~/.config/dsh-crew/config.json` sha `7cbbc8e1…` unchanged; `~/.dsh/settings.yaml` sha `b3c608b8…` unchanged (both byte-identical to their pre-task states). Existing `web` profile untouched (plugin still 80db87a, `main ./src/hub/index.mjs`); web Hub (3080) healthy; no v0.3 test plugin left installed; no credential values read/printed; repository clean except this report + ACTIVE deletion. |

## 5. Stale-Hub compatibility code observed (real case)
`HUB_SERVICE_MISMATCH` — reached because the DSH web legacy Hub answers `GET /_dsh/dsh-crew/runtime` with `HTTP 200 + text/html` (SPA fallback, non-JSON), not 404. The contract's `HUB_PROTOCOL_MISSING` code (for a literal missing route / 404) is covered by the deterministic test suite.

## 6. Current `/runtime` identity and capabilities (disposable Hub)
`{ service: "dsh-crew-hub", runtime_version: "0.3.0-dev", protocol_version: 1, capabilities: [jobs, jobs-wait, jobs-cancel, roles, attempt-index, model-policy, model-catalog, presets, config] }`

## 7. Real worker IDs / provider / model / result + replay
- Workflow `wf-mt2gzr72-uerwqx`; Hub attempt `hub-1-mt2gzrc6`; provider `opencode-go`, model `deepseek-v4-flash`, `selection_source=preferred-default`; terminal `done`/`completed`; candidate `[src/value.mjs]` (`VALUE 1 → 2`); delivery complete; **independent replay: `node --test` 1 pass / 0 fail**.

## 8. Cleanup / safety evidence
See R6. Byte-hashes: `config.json` `7cbbc8e1fb84f2a7dff6d793d259940c497b08234b1699103d786aa2eb21314d`; `settings.yaml` `b3c608b86311c10ad631306e42918f6d860350fe16ccdb38eaf317a3526095f9`. No secrets in report/diff.

## 9. Blockers / Failures
None that require fixing. One documentation-worthy observation (classified **DSH_ENVIRONMENT**, not SOURCE_BUG): a real hosted legacy Hub returns `200 + SPA HTML` for the missing `/runtime` route, so real-world stale-Hub classification surfaces as `HUB_SERVICE_MISMATCH` instead of the ACTIVE's assumed `HUB_PROTOCOL_MISSING`. Both are contract codes; the essential behavior (reachable-but-incompatible → fail closed, no fallback worker) is correct and proven. Recommendation (report-only, NOT performed): when the running `web` deployment is upgraded to a generation exposing `/runtime`, consider whether the probe should distinguish "route exists but non-JSON/service-mismatch" from "route 404" for diagnostics; no functional defect observed.

## 10. Verdict
**READY — RUNTIME COMPATIBILITY CONTRACT PASS**
