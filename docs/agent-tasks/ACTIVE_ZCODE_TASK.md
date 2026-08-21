Protocol: Agent Handoff Protocol v1
Agent: ZCODE
Mode: TEST_ONLY
Source Branch: test/opencode-go-catalog-diagnosis
Source Commit: LATEST
Result Path: docs/agent-results/zcode-opencode-go-catalog-diagnosis.md
Delete Active Task On Completion: YES

# Goal

Determine why the current live DSH environment exposes only the DeepSeek V4 Flash/Pro models for the registered `opencode-go` provider while OpenCode Go currently offers MiMo and Qwen model families.

This is a ROOT-CAUSE DIAGNOSIS task. Do not change source code, DSH settings, provider configuration, credentials, installed plugins, model priorities, or the running environment in order to make the model list look correct.

# Context

The previously completed real-environment report observed a live DSH catalog containing only:

- `deepseek-official`: DeepSeek V4 models
- `opencode-go`: `deepseek-v4-flash`, `deepseek-v4-pro`
- `opencode-go-muse`: Muse

and therefore marked MiMo/Qwen coverage BLOCKED.

Current external evidence indicates that OpenCode Go itself now exposes MiMo and Qwen models and that recent DSH/pi-ai builds are expected to have a richer built-in `opencode-go` model directory. A common failure mode is an explicit local provider `models:` override replacing the built-in directory.

Do not assume that is the cause. Prove the cause from the local environment.

# Allowed Changes

Only:

1. Create/update `docs/agent-results/zcode-opencode-go-catalog-diagnosis.md`.
2. Delete `docs/agent-tasks/ACTIVE_ZCODE_TASK.md` when finished.

No other repository file may be modified.

# Forbidden Changes

- No source edits under `src/`, `lib/`, `test/`, `scripts/`, `codex/`, `agents/`, `.github/`, package metadata, lockfiles, docs outside the result file, or release metadata.
- Do not modify `~/.dsh/settings.yaml`, `~/.dsh/.credentials.yaml`, `~/.config/dsh-crew/config.json`, environment variables, provider settings, model priorities, presets, or DSH profile bundles.
- Do not install, remove, upgrade, downgrade, restart, or reconfigure DSH/plugins for this task.
- Do not run `git reset`, `git clean`, `git stash`, rebase, force-push, or modify unrelated files.
- Do not print API keys, tokens, cookies, Authorization headers, credential file contents, signed URLs, or secret-bearing error payloads.
- Do not read another Agent's ACTIVE task.

# Start-of-Task Protocol

1. Checkout/pull `test/opencode-go-catalog-diagnosis` using fast-forward-only behavior when possible.
2. Record:
   - `git rev-parse HEAD`
   - `git branch --show-current`
   - `git status --short`
3. Read `docs/agent-workflow.md` and this ACTIVE file only.
4. If the worktree contains pre-existing user changes, preserve them and report them. Do not clean/reset/stash them.

# Required Work

## D1 — Environment / Version Evidence

Record, without secrets:

- OS
- Node version
- pnpm version
- DSH package/version
- DSH web/profile boot revision if available
- `dsh-crew` plugin revision loaded by the running web profile if available
- installed `@deepseek-ai/dsh-llm-pi-ai` package/bundle version or revision if resolvable read-only
- whether DSH Hub is reachable

Use existing read-only commands/APIs only. Do not install tools.

## D2 — Inspect the Effective Local `opencode-go` Configuration Shape

Read only the relevant non-secret configuration shape needed to diagnose model-directory overrides.

For the `llm-pi-ai.providers.opencode-go` section in `~/.dsh/settings.yaml` (or the actual effective settings location used by this DSH install), report ONLY:

- whether the provider entry exists
- the names of keys present, such as `apiKeyEnv`, `api`, `baseURL`, `compat`, `models`, `displayName`
- if a `models` field exists: the model IDs only
- if `apiKeyEnv` exists: the environment-variable NAME only, not its value
- if `baseURL` exists: the non-secret base URL is allowed
- whether the entry appears to be a minimal override or a full/custom provider definition

Do NOT print credential values.
Do NOT read or print `~/.dsh/.credentials.yaml` contents. At most record `credential file: PRESENT/ABSENT` if needed.

If the local settings parser/tool can show merged/effective provider config without secrets, that evidence is preferred over raw-file parsing.

## D3 — Inspect the Installed DSH/pi-ai Built-In `opencode-go` Directory

Using the installed package files or a read-only DSH inspection API, find the built-in catalog entry for provider id `opencode-go`.

Record:

- provider id/display name
- base URL if non-secret
- API/protocol mapping if exposed
- total built-in model count
- exact MiMo model IDs present
- exact Qwen model IDs present
- `deepseek-v4-flash` / `deepseek-v4-pro` presence

Do not copy large source files into the report. Record only concise evidence and paths/module identifiers.

If the installed build does NOT contain MiMo/Qwen, record that clearly; this may indicate a stale DSH/pi-ai build rather than a config override.

## D4 — Compare Three Catalog Surfaces

Collect and compare these model lists:

A. Current running DSH/Crew model endpoint (`/_dsh/dsh-crew/models`) or equivalent live Harness catalog surface.
B. Installed built-in `opencode-go` directory from D3.
C. OpenCode Go public model endpoint: `https://opencode.ai/zen/go/v1/models`.

For C:

- GET only.
- Do NOT send Authorization or any credential.
- Record only model IDs relevant to this diagnosis (DeepSeek, MiMo, Qwen) and the total count if available.
- If the endpoint is unreachable from the environment, mark C BLOCKED; do not substitute credentials.

Explicitly state whether the public endpoint contains at least:

- one `mimo-*` model
- one `qwen*` model

## D5 — Root-Cause Classification

Choose exactly one primary classification, with evidence:

1. `LOCAL_MODELS_OVERRIDE` — local/effective `opencode-go.models` replaces the built-in directory and explains the truncated live list.
2. `STALE_DSH_CATALOG` — installed DSH/pi-ai built-in directory itself lacks the current MiMo/Qwen models.
3. `LIVE_REGISTRY_MISMATCH` — built-in directory is complete and local settings do not truncate it, but the running `llm.listModels('opencode-go')` / Crew live endpoint is still incomplete.
4. `PROVIDER_PLUGIN_OVERRIDE` — another installed provider/bundle adopts or replaces `opencode-go` and exposes a reduced catalog.
5. `OTHER` — none of the above; explain precisely.
6. `INCOMPLETE` — concrete environment blocker prevents classification.

Do not guess. If more than one contributing factor exists, name a primary cause and secondary contributors.

## D6 — Safe Remediation Recommendation (REPORT ONLY)

Based on the proven classification, state the minimal next action, but DO NOT perform it.

Examples:

- If `LOCAL_MODELS_OVERRIDE`: recommend removing only the unnecessary explicit `models` override and retaining credential reference/minimal provider config, then restart/refresh as required by DSH.
- If `STALE_DSH_CATALOG`: recommend the exact DSH/pi-ai upgrade path only if it can be determined from installed tooling/docs; otherwise say upgrade required without inventing a command.
- If `LIVE_REGISTRY_MISMATCH`: recommend a DSH upstream bug investigation and include the smallest reproduction.
- If `PROVIDER_PLUGIN_OVERRIDE`: identify the overriding bundle and recommend reconciling/removing its catalog override, without doing so.

Also state whether a `dsh-crew` source change is required: `YES` or `NO`, with one-sentence justification.

# Required Validation

Run only read-only validation needed for diagnosis.

At minimum:

- Confirm live `/models` evidence.
- Confirm installed built-in provider-directory evidence.
- Confirm local effective settings shape.
- Compare with the public OpenCode Go model list if reachable without auth.

Do NOT run model-generation calls that consume quota unless absolutely necessary to distinguish two otherwise indistinguishable root causes. If such a call becomes necessary, stop and mark the point BLOCKED rather than spending quota under this TEST_ONLY task.

# Acceptance Criteria

The report is complete only if it contains:

- exact source branch + source commit tested
- environment/version evidence
- local `opencode-go` config SHAPE with secrets excluded
- installed built-in catalog evidence
- current live catalog evidence
- public OpenCode Go catalog evidence or a concrete BLOCKED reason
- one root-cause classification from D5
- minimal remediation recommendation
- explicit `dsh-crew source change required: YES/NO`
- repository change list proving only the report + ACTIVE deletion were written
- no secrets

# Result / Report Contract

Write:

`docs/agent-results/zcode-opencode-go-catalog-diagnosis.md`

Use this structure:

```markdown
# OpenCode Go Catalog Diagnosis

## Source
- Branch:
- Source Commit SHA:
- Report Commit SHA: <fill after commit if practical, otherwise state pending-in-file and return it in terminal output>

## Environment
...

## Local opencode-go Config Shape
...

## Installed Built-In Catalog
...

## Catalog Comparison
| Surface | Total | DeepSeek | MiMo | Qwen | Notes |
|---|---:|---|---|---|---|

## Root Cause
- Classification: LOCAL_MODELS_OVERRIDE | STALE_DSH_CATALOG | LIVE_REGISTRY_MISMATCH | PROVIDER_PLUGIN_OVERRIDE | OTHER | INCOMPLETE
- Evidence:

## Recommended Remediation
...

## dsh-crew Source Change Required
- YES | NO
- Reason:

## Repository Changes
...
```

# Completion Commit Contract

Before commit:

- `git status --short`
- `git diff --cached --name-only`

The completion commit must contain exactly:

- `docs/agent-results/zcode-opencode-go-catalog-diagnosis.md` added/updated
- `docs/agent-tasks/ACTIVE_ZCODE_TASK.md` deleted

No other path may be staged or committed.

Commit/push the result to `test/opencode-go-catalog-diagnosis` if the environment permits.

# Final Return

Return these lines in the terminal/chat output:

- Source Commit SHA:
- Report Commit SHA:
- Root Cause Classification:
- dsh-crew Source Change Required: YES/NO
- Verdict: DIAGNOSED | INCOMPLETE-BLOCKED
- Report Path: docs/agent-results/zcode-opencode-go-catalog-diagnosis.md

Then STOP. Do not apply the remediation.
