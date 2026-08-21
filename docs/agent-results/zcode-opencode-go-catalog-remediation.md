# OpenCode Go Catalog Remediation — T3 Closure Report (ZCode)

## Source
- Source Branch: `ops/opencode-go-catalog-remediation`
- Source Commit SHA: `fa4cc10db083b4d47b9addcc081a14a7ae7a9feb` (branch HEAD tested)
- Result Commit SHA: filled in terminal output after push (this file is written before the commit)

## Environment
- OS: Windows 11 10.0.22631 (x64), Git Bash (MINGW64)
- Node: v24.18.1
- pnpm: 11.7.0
- DSH: `@deepseek-ai/dsh` `0.1.0-rc.7` (boot rev `74bd24d7329d` — unchanged before/after restart, same build, no package change)
- Hub plugin (profile `web`): `@ran-sh/dsh-crew` pinned at commit `80db87a0...` (version 0.1.0-rc.1) — NOT updated, per task
- `@deepseek-ai/dsh-llm-pi-ai`: `0.1.0-rc.7`; effective LLM engine `@earendil-works/pi-ai`: `0.82.1` (built-in provider catalog)
- DSH Hub reachable: YES (`/_dsh/dsh-crew/ping` → `service: dsh-crew-hub`); web PID listening on `127.0.0.1:3080`
- Tester/orchestrator: ZCode driving this branch's MCP server (`src/server.mjs`) over stdio against the live Hub

## Remediation Performed (report-only of the state change; key names only, never credential values)
External to the repo, per task authorization:
1. `~/.dsh/settings.yaml` → `llm-pi-ai.providers.opencode-go`: **removed only the explicit `models` key** (the 9-line `deepseek-v4-flash`/`deepseek-v4-pro` override). Preserved `displayName`, `apiKeyEnv` (NAME `OPENCODE_GO_API_KEY` only), `api` (`openai-completions`), `baseURL` (`https://opencode.ai/zen/go/v1`). `opencode-go-muse` and all other providers/settings/credentials references untouched. YAML re-validated after edit (parses, `models` gone, muse intact).
2. Restarted the DSH web process for `127.0.0.1:3080` using the already-installed binary (`node …/@deepseek-ai/dsh/lib/bin.js web`, profile `web`), no installs/updates.
3. Temporarily set model priorities in `~/.config/dsh-crew/config.json` (`flash_model_priority=[{provider:opencode-go, model:mimo-v2.5}]`, `pro_model_priority=[{provider:opencode-go, model:qwen3.7-max}]`, both `_configured=true`; `worker_provider_mode` already `follow-dsh`) to force the two test models.

## Backup Paths
- `~/.dsh/settings.yaml.zcode-backup-20260821031930` (original settings, before removing `models`)
- `~/.config/dsh-crew/config.json.zcode-backup-20260821032353` (exact bytes of the pre-test config)
- Extra safety copies (not modified originals): `~/.dsh/profiles/web/cordis.patch.yml.zcode-safety-20260821112038`, `~/.dsh/profiles/web/package.json.zcode-safety-20260821112038`

## Catalog Evidence (secret-free)
Pre-remediation (from the diagnosis task): `/_dsh/dsh-crew/models` → `opencode-go` exposed only `deepseek-v4-flash`, `deepseek-v4-pro` (the local `models` override), total catalog 5 models.

Post-remediation (after settings reload + restart):
- `provider_count: 3`, `model_count: 19`, `partial: false`, `harness_default` opencode-go/deepseek-v4-flash
- `opencode-go` now exposes the full built-in directory: **16 models** = `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.1`, `glm-5.2`, `grok-4.5`, `hy3`, `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`, `mimo-v2.5`, `mimo-v2.5-pro`, `minimax-m2.7`, `minimax-m3`, `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`
- MiMo present: `mimo-v2.5`, `mimo-v2.5-pro`; Qwen present: `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`
- `deepseek-v4-flash` / `deepseek-v4-pro` still present; `opencode-go-muse` unchanged (`muse-spark-1.2-contributor`)

## Results (R1–R7)
| ID | Check | Status | Evidence |
|---|---|---|---|
| R1 | settings remediation | **PASS** | `models` removed only under `opencode-go`; YAML parses; all other keys/providers preserved (incl. `opencode-go-muse`, `agent-default-model`, `image-mind`); backup kept |
| R2 | DSH restart / health | **PASS** | Same installed binary launched identically (no package change); `/_dsh/dsh-crew/ping` healthy ~3s; boot rev unchanged `74bd24d7329d`; listening on 127.0.0.1:3080. (Note: the web process was already stopped when the restart step began; I started it, rather than stopped a live one.) |
| R3 | catalog restored | **PASS** | `opencode-go` 16 models incl. `mimo-v2.5`, `mimo-v2.5-pro`, `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`; not reduced to the former two-model override |
| R4 | MiMo real worker | **PASS** | wf `wf-mt2dzc4k-u71kuv`, hub attempt `hub-1-mt2dzcaf` → provider `opencode-go`, model `mimo-v2.5`, `selection_source=priority`; done/completed, decision verified; candidate `src/value.mjs`; delivery complete, tests PASS; independent repro: patch applied → `node --test` 1 pass / 0 fail |
| R5 | Qwen real worker | **PASS** | wf `wf-mt2e0q7w-ikfnp6`, hub attempt `hub-2-mt2e0qc1` → provider `opencode-go`, model `qwen3.7-max`, `selection_source=priority`; done/completed, decision verified; candidate `src/value.mjs`; delivery complete, tests PASS; independent repro: patch applied → `node --test` 1 pass / 0 fail |
| R6 | temporary Crew config restored | **PASS** | `~/.config/dsh-crew/config.json` restored byte-for-byte from backup (sha256 `7cbbc8e1…` matches pre-test; priorities back to `[]`, `_configured=false`) |
| R7 | repository safety / secrets | **PASS** | dsh-crew checkout `git status --short` clean before/after; no source/test/config/CI/package changes; disposable repos removed; no credentials read or printed (only env-var NAMES + non-secret base URL) |

Details used by R4/R5 (real Hub evidence, `selection_source=priority` proves the model was forced via the configured priority through the live catalog):
- R4 MiMo: workflow `wf-mt2dzc4k-u71kuv`, child attempt `hub-1-mt2dzcaf` (worker, attempt 0), provider `opencode-go`, model `mimo-v2.5`, selection_source `priority`, status done, stopReason completed; candidate changed files `[src/value.mjs]` (patch `VALUE 1 → 2`), outcome task_status `success`, tests_status `PASS` (`node --test src/value.test.mjs` — VALUE is 2), delivery complete, primary checkout not dirty. Independent verification: clone fixture at base revision `8de4dfa…`, `git apply` candidate patch, `node --test src/value.test.mjs` → 1 pass / 0 fail, exit 0.
- R5 Qwen: workflow `wf-mt2e0q7w-ikfnp6`, child attempt `hub-2-mt2e0qc1` (worker, attempt 0), provider `opencode-go`, model `qwen3.7-max`, selection_source `priority`, status done, stopReason completed; candidate `[src/value.mjs]`, task_status `success`, tests_status `PASS`, delivery complete. Independent verification: clone at base `66e9c160…`, apply patch, `node --test` → 1 pass / 0 fail, exit 0.

## Final State / Restore Confirmations
- `~/.config/dsh-crew/config.json` byte-identical to the pre-test backup (sha256 restored); session reset verified via `dsh_worker_config(reset=true)` (session_overrides back to global defaults; effective selection deepseek-v4-flash/pro; hub reachable).
- Disposable temp repos/driver removed from the OS temp dir (only the two live DSH stdout/stderr log files remain, held open by the running web process).
- `~/.dsh/settings.yaml` remediation is kept in place (the two-model `models:` override is NOT restored — intended per task E5, since R3 confirmed the built-in catalog).
- dsh-crew checkout: clean (only repo changes below).

## Repository Changes
- added `docs/agent-results/zcode-opencode-go-catalog-remediation.md` (this file)
- deleted `docs/agent-tasks/ACTIVE_ZCODE_TASK.md`

No dsh-crew source, tests, package metadata, lockfiles, CI, README, or docs outside the result report were changed. No packages/plugins were installed, updated, or removed.

## Verdict
**REMEDIATED — T3 PASS** (R1–R7 all PASS; both MiMo and Qwen real coding-worker runs pass with `selection_source=priority` proving the exact live-catalog model IDs were used, plus independent git/test reproduction).

## Recommended Next Action
- No dsh-crew source change is required; the truncation was a local settings override, now removed. Keep the remediation and the backups.
- The Hub (profile `web`) still runs the older pinned plugin revision `80db87a`; a future plugin refresh is optional, unrelated to this catalog fix.
- Previously noted separate config topic (from the runtime-hardening report, not this task): default `preset_flash=minimal` can't run terminal commands on Windows — revisit as a distinct follow-up if default-flash real evidence is needed.
