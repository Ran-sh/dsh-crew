# OpenCode Go Catalog Diagnosis

## Source
- Branch: `test/opencode-go-catalog-diagnosis`
- Source Commit SHA: `72a145bc1c5df2eb01ffb9d44a6223e11dd60495`
- Report Commit SHA: returned in terminal output after push (not pre-filled)

## Environment
- OS: Windows 11 10.0.22631 (x64), Git Bash (MINGW64)
- Node: v24.18.1
- pnpm: 11.7.0
- DSH: `@deepseek-ai/dsh` `0.1.0-rc.7`
- DSH web boot revision: `74bd24d7329d`
- `dsh-crew` plugin revision loaded by running web profile (`~/.dsh/profiles/web`): `@ran-sh/dsh-crew` pinned to commit `80db87a0...` (version 0.1.0-rc.1 tarball install)
- `@deepseek-ai/dsh-llm-pi-ai` bundle: `0.1.0-rc.7` (npx cache of the running DSH)
- Effective LLM engine package holding the built-in provider directory: `@earendil-works/pi-ai` `0.82.1` (`~/.dsh/profiles/node_modules`)
- DSH Hub reachable: YES (`/_dsh/dsh-crew/ping` → `service: dsh-crew-hub`)
- Tester/orchestrator: ZCode (TEST_ONLY, read-only diagnosis; no DSH/plugin restarts, no installs, no setting edits)

## Local opencode-go Config Shape
Read-only inspection of `~/.dsh/settings.yaml` → `llm-pi-ai.providers` (credential VALUES never printed):

- Provider ids defined locally in `llm-pi-ai.providers`: `opencode-go`, `opencode-go-muse`
- `opencode-go` keys present: `displayName`, `apiKeyEnv`, `api`, `baseURL`, `models`
- `models` (explicit override): `deepseek-v4-flash`, `deepseek-v4-pro` — exactly 2 IDs
- `apiKeyEnv` NAME only: `OPENCODE_GO_API_KEY` (value not read/printed)
- `baseURL` (non-secret): `https://opencode.ai/zen/go/v1`
- `api`: `openai-completions`
- `displayName`: `OpenCode Go`
- Shape classification: **custom/minimal provider definition that carries an explicit `models` override** — a full/custom definition (auth env + api + baseURL) whose `models` list replaces the built-in directory at the effective-LLM layer.
- For contrast, `opencode-go-muse` is similarly defined locally as `openai-responses` with `models: [muse-spark-1.2-contributor]` (unrelated provider, not part of this issue).

No secret values were read or printed; `.credentials.yaml` contents were not read.

## Installed Built-In Catalog
Provider directory for id `opencode-go` in the installed LLM engine:

- Package: `@earendil-works/pi-ai@0.82.1` at `~/.dsh/profiles/node_modules/@earendil-works/pi-ai` (distributed via the `@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.7` bundle)
- Files: `dist/providers/opencode-go.js` / `opencode-go.models.js` (auto-generated) / `data/opencode-go.json` (protocol-keyed data; keys `anthropic-messages`, `openai-completions`, `openai-responses`)
- **Total built-in model count: 16**
- Exact MiMo IDs present: `mimo-v2.5`, `mimo-v2.5-pro`
- Exact Qwen IDs present: `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`
- `deepseek-v4-flash` / `deepseek-v4-pro` present: yes (both)
- Other IDs in directory: `glm-5.1`, `glm-5.2`, `grok-4.5`, `hy3`, `kimi-k2.6`, `kimi-k2.7-code`, `kimi-k3`, `minimax-m2.7`, `minimax-m3`
- Legacy box-check (D3/ACTIVE context): the installed build DOES contain MiMo and Qwen, i.e. the built-in directory is **not stale** — the truncation is not caused by an outdated pi-ai build.

## Catalog Comparison
| Surface | Total | DeepSeek | MiMo | Qwen | Notes |
|---|---:|---:|---:|---:|---|
| A — live `/_dsh/dsh-crew/models` (opencode-go) | 2 | 2 (`deepseek-v4-flash`, `deepseek-v4-pro`) | 0 | 0 | Whole live catalog: 3 providers / 5 models, `partial:false`, `harness_default` opencode-go/deepseek-v4-flash |
| B — installed built-in `opencode-go` directory (pi-ai 0.82.1) | 16 | 2 | 2 (`mimo-v2.5`, `mimo-v2.5-pro`) | 3 (`qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`) | Data at `dist/providers/data/opencode-go.json` |
| C — public `https://opencode.ai/zen/go/v1/models` (GET, no auth) | 27 | 2 (`deepseek-v4-pro`, `deepseek-v4-flash`) | 4 (`mimo-v2-pro`, `mimo-v2-omni`, `mimo-v2.5-pro`, `mimo-v2.5`) | 5 (`qwen3.5-plus`, `qwen3.6-plus`, `qwen3.7-plus`, `qwen3.7-max`, `qwen3.8-max`) | HTTP 200; contains at least one `mimo-*` and one `qwen*` |

Surface A matches the local `settings.yaml` `models:` override **exactly** (same 2 IDs). Surface B and C both contain MiMo and Qwen, so neither the installed catalog nor the OpenCode Go service is the limiting surface.

## Root Cause
- Classification: **LOCAL_MODELS_OVERRIDE**
- Evidence:
  1. The live `opencode-go` model list from the effective Harness/LLM catalog (Surface A) is byte-identical to the explicit local `llm-pi-ai.providers.opencode-go.models` list in `~/.dsh/settings.yaml` (`deepseek-v4-flash`, `deepseek-v4-pro`).
  2. The installed built-in `opencode-go` directory (Surface B, `@earendil-works/pi-ai@0.82.1`) contains 16 models including `mimo-v2.5`/`mimo-v2.5-pro` and `qwen3.6-plus`/`qwen3.7-max`/`qwen3.7-plus` — so the truncation is not a stale built-in catalog.
  3. A static, case-insensitive search across every `@deepseek-ai/*` package in the running DSH install (npx cache) found no other `opencode-go` catalog/override; the only place that reduces `opencode-go` to the two DeepSeek models is the local settings `models:` override.
  4. The public OpenCode Go endpoint (Surface C, no auth) advertises 27 models incl. MiMo and Qwen — the upstream service is fine.
  Conclusion: the local `models:` override replaces the built-in provider directory at the effective-LLM layer, so `llm.listModels('opencode-go')` (and therefore the Crew live catalog) surfaces only the two pinned DeepSeek models. This exactly matches the previously reported T3 BLOCKED finding.
- Secondary contributors: none proven. `opencode-go-muse` is also locally defined (separate provider) and is not a contributor to the `opencode-go` truncation. The `openai-completions` api/compat values are normal and not a factor.

## Recommended Remediation
Minimal, report-only recommendation (NOT performed):
- Remove only the explicit `models:` list under `llm-pi-ai.providers.opencode-go` in `~/.dsh/settings.yaml` (keep `displayName`, `apiKeyEnv`, `baseURL`, `api`, which are required for the custom endpoint/auth), then restart/refresh DSH so the effective-LLM layer re-reads the built-in 16-model directory. Verify with `/_dsh/dsh-crew/models` and re-run the previous T3 coverage.
- Alternative (if a curated list is preferred): replace the `models:` list with the desired subset from the built-in directory (e.g., add `mimo-v2.5`, `mimo-v2.5-pro`, `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`) instead of deleting it entirely.
- Verify on the DSH settings page / Web UI after the change that MiMo and Qwen appear under OpenCode Go before relying on T3.

## dsh-crew Source Change Required
- NO
- Reason: the truncation originates in the user's local DSH provider configuration (`llm-pi-ai.providers.opencode-go.models` in `~/.dsh/settings.yaml`); dsh-crew correctly surfaces the effective provider catalog reported by the DSH LLM layer and has no code role in this truncation.

## Repository Changes
- added `docs/agent-results/zcode-opencode-go-catalog-diagnosis.md` (this file)
- deleted `docs/agent-tasks/ACTIVE_ZCODE_TASK.md`

No source, no settings, no installed packages, no credentials, and no running environment were modified. HTTP GET only to the public models endpoint; no auth header sent; a single temporary download was removed after parsing.
