# Changelog

## Unreleased

Future changes go here.

## 0.5.5 — 2026-08-30

- Prevents candidate capture from following untracked symlinks or junctions
  outside an isolated worktree, and makes reviewer mutation fingerprints cover
  the complete sanitized diff even when the retained patch is truncated.
- Makes current provider-catalog failure override stale successful execution
  evidence so capability readiness remains fail-closed.
- Preserves foreign Windows startup files, cleans ZCode MCP entries across
  native/shared configuration transitions, and writes global configuration by
  atomic same-directory replacement.
- Bounds model-catalog diagnostics, waits for cancellation and worktree cleanup
  before reporting completion, and adds focused regression coverage for every
  corrected boundary.
- Keeps the streamlined English and Chinese quick starts while restoring the
  supported source-uninstall and legacy-launcher migration guidance.

## 0.5.4 — 2026-08-30

- Corrects the release metadata guard so the changelog test verifies the
  current release entry instead of an older version heading.

## 0.5.3 — 2026-08-30

- Replaces the one-shot Windows login launcher with a single-instance service
  supervisor that safely restores the isolated 3210 Crew backend and official
  3080 UI after process exits, confirms repeated health failures before
  recovery, and binds process ownership to PID plus creation time.
- Makes ZCode dispatch asynchronous and transport-safe, keeps workflow/model
  metadata at the host boundary, and verifies the same workflow instead of
  creating duplicates after bounded waits.
- Enforces explicit, isolated, evidence-backed authorization for successful
  zero-change Worker jobs across MCP and direct Hub paths; shared workspaces,
  missing candidates, mismatched diffs, and absent evidence fail closed.
- Requires complete successful Result Contracts, consistent workspace evidence,
  and an approving Reviewer verdict before live execution readiness becomes
  PASS; the 3080/3210 extension and MCP configuration share this rule.
- Fixes Windows source installation under current Node.js, canonical client
  builds, quiet Codex/ZCode/Claude host detection, and live model-execution
  readiness after verified Harness work.

## 0.5.2 — 2026-08-29

- Adds a managed, capability-aware global Codex policy with a mandatory operator
  decision gate when selected Crew capabilities become unavailable.
- Adds an idempotent per-user Windows login launcher for the isolated 3210 Crew
  backend and official 3080 UI, including status and safe uninstall support.
- Rewrites the primary READMEs around a shorter quick-start flow and documents
  installation ownership, verification, and rollback.
- Adds source-aware ZCode integration with managed global policy, Worker /
  Reviewer dispatch agents, status/config commands, MCP collision protection,
  readiness reporting, and safe uninstall.

## 0.5.1 — 2026-08-27

- Upgrades and exact-pins the client build toolchain so Rolldown no longer
  reports the invalid legacy `define` option during production builds.
- Marks Harness- and React-provided peer dependencies as optional for the
  globally installed launcher, preventing npm from auto-installing the native
  Harness dependency graph outside the Crew-managed runtime.
- Invokes npm's CLI directly through Node on Windows instead of passing an
  argument array through a shell, removing the Node DEP0190 security warning.
- Adds regression contracts for warning-free client builds, host-provided peer
  metadata, and shell-free npm verification.

## 0.5.0 — 2026-08-26

- Consolidates the three official 3080 settings entries into one compact DSH
  Crew operations console with accessible, persisted disclosure sections.
- Makes the shared client surface-aware through structured bridge/runtime
  evidence: 3080 renders the full Crew control plane while 3210 renders a
  diagnostics-only Crew panel and leaves Provider/Model management to native
  Harness menus. Unknown surfaces fail closed to the minimal view.
- Adds a direct, safe link from the daily 3080 console to the isolated 3210
  Crew Harness for low-level Provider and Harness Model configuration.
- Keeps the compact Worker/Reviewer task table and adds clear role, selected
  provider/model, routing source, progress, and token columns without expanding
  the information-flow boundary.
- Adds an in-memory model invocation overview showing count, task/routing
  sources, roles, and the latest invocation time; prompts, results, credentials,
  and new persistent telemetry are explicitly excluded.
- Reports Codex and Claude integration readiness separately from installation:
  Codex validates managed roles, prompts, and MCP targets; Claude validates the
  marketplace payload, installed snapshot, and tool permissions. The console
  also surfaces existing runtime activation boundaries.
- Adds a compact structured readiness matrix for Codex MCP, ds-worker,
  ds-reviewer, Claude plugin, Crew Harness runtime, and the official bridge;
  missing or partial evidence never becomes READY.

## 0.4.2 — 2026-08-26

- Restores live extension readiness evidence by projecting completed Hub Worker
  and Reviewer jobs from the active registry, so real executions can advance
  model and reviewer components from `DEGRADED` to `READY`.
- Adds regression coverage for the synchronous, privacy-preserving job view used
  by the extension contract.

## 0.4.1 — 2026-08-25

- Disposes completed Hub Agent handles before isolated worktree cleanup so
  Windows does not retain successful Worker/Reviewer worktrees with `EPERM`.
- Shares one disposal promise across completion, cancellation, timeout, and Hub
  shutdown to prevent double-dispose races, and surfaces Agent cleanup failures
  in the job cleanup evidence.
- Preserves direct Hub provider/model selection traces inside the compact Result
  Contract evidence envelope instead of returning an empty trace, while
  allow-listing and bounding selected model and routing-reason fields so raw
  provider payloads cannot pass through.

## 0.4.0 — 2026-08-25

- Adds a versioned canonical job-event contract and a bounded evidence-first
  Result Contract for Worker/Reviewer workflows.
- Makes MCP workflow and cancellation results compact by default, while preserving the previous
  rich candidate/workflow view behind explicit `detail: "full"`.
- Replaces patch/prose forwarding to automatic Reviewers with a bounded context
  capsule and direct isolated-workspace inspection.
- Bounds Hub hand-off memory by retaining only the latest assistant message
  needed for the final Delivery Report.
- Adds versioned Worker/Reviewer Profiles and Workspace Context registries with
  validation-before-write and bounded reference-only Agent hand-offs.
- Adds a narrow extension capability/readiness contract, incremental canonical
  event watch, compact HTTP job contracts, and `dsh-crew inspect` for GPT-first
  orchestrators.
- Classifies failures by stable family and `retry` / `fallback` / `human` /
  `terminal` disposition without parsing provider logs.
- Aligns MCP and loopback HTTP Job Request fields for caller ids, profiles,
  workspace branch/worktree policy and request-level constraints; adds real
  workspace preflight states and `dsh-crew jobs list|get|watch|cancel|submit`.

## 0.3.8 — 2026-08-24

- Adds an opt-in official Harness integration: the standard UI remains on `127.0.0.1:3080`, while the full Crew Hub and model workloads stay isolated in the Crew-owned `dsh-crew` profile on `127.0.0.1:3210`.
- Ships a lightweight, loopback/same-origin official-web bridge that proxies only `/_dsh/dsh-crew/*`, strips hop-by-hop headers, bounds request bodies, hides internal failures, and coalesces background sidecar startup without duplicate cold-start processes.
- Adds `dsh-crew integrate` and `dsh-crew detach`. Install/update automatically repair an enabled bridge; detach remains opted out; uninstall removes the bridge without losing the reinstall intent unless `--purge` is used.
- Preserves unrelated official `web` profile bundles/dependencies and creates a Crew-owned backup before the first bridge registration. Invalid or missing official profiles fail closed.
- Repairs fresh Crew profile scaffolding so both `dsh-base` and `dsh-web-app` are present, allowing a newly installed isolated 3210 backend to bind its web server.
- Raises the MCP TypeScript SDK floor to `1.25.4`, clearing the current high-severity production dependency advisories.
- Simplifies the English and Chinese README around the supported 3080 UI + isolated 3210 backend workflow, single/multiple model behavior, Codex/Claude usage, and recovery commands.

## 0.3.7 — 2026-08-24

### Added

- Split the DSH Crew settings surface into nine accessible collapsible modules with compact live summaries, expand/collapse-all controls, persisted disclosure state, and automatic attention for model/provider errors and running jobs.

### Changed

- Rewrote the English and Simplified Chinese READMEs around the shortest supported install, start, configure, use, update, and uninstall path while retaining isolation and legacy-migration safety boundaries.

## 0.3.6 — 2026-08-24

- Persist required transitive peer dependencies inside Crew-managed payloads, fixing Codex Desktop and Claude Code MCP startup after global installation.
- Validate every staged payload with a real MCP `initialize` handshake before activation, so missing runtime dependencies fail closed during install/update.

## 0.3.5 — 2026-08-24

### Fixed

- Adds the supported migration recovery for legacy `<=0.3.3` installations: refresh the global launcher first, then run `dsh-crew update`. When the running launcher is newer than the managed payload, its already-installed and validated package becomes the convergence candidate before registry resolution, while preserving staged validation, prior-release retention, config preservation, integration repair, and fail-closed/no-downgrade behavior.
- Makes launcher/payload divergence guidance direction-aware: a newer launcher directs the user to update the managed payload, a newer payload remains authoritative and prints the exact launcher-refresh command, and equal versions emit no warning.

### Compatibility

- Immutable public `0.3.3` cannot discover later registry versions with its old update implementation. The supported bootstrap boundary is therefore explicit: `npm install -g @ran-sh/dsh-crew@latest`, followed by `dsh-crew update`.

## 0.3.4 — 2026-08-23

### Fixed

- Recovers the public distribution path around the npm/cli #9870 npx regression: the primary supported lifecycle is now a stable package-manager-installed launcher (`npm install -g @ran-sh/dsh-crew` then `dsh-crew install|status|update|uninstall`), which does not depend on transient npx cache PATH behavior; the broken `npx` flow is documented as a known compatibility issue instead of the primary path.

### Changed

- `dsh-crew update` is a real registry-aware update operation: it resolves the newest permitted Crew package from the configured npm registry (never downgrading) or from an explicit safe `--candidate`/`DSH_CREW_CANDIDATE` override, packs and stages it into durable Crew-owned state with full validation before activation, preserves config/credentials and the prior usable release until the switch succeeds, repairs stale registrations, and stays idempotent when already current. The globally installed launcher intentionally does not self-replace; after a payload update the CLI prints the exact one-line command to refresh it.
- `dsh-crew status` additionally distinguishes the launcher/candidate version from the installed Crew payload version/state so divergence between the global launcher and the managed payload is visible at a glance.

## 0.3.3 — 2026-08-23

### Added

- First-class npx-managed lifecycle CLI: a single natural `dsh-crew` executable so `npx @ran-sh/dsh-crew@latest install|status|update|uninstall` works without naming a binary; unknown commands fail with usage text and a nonzero exit.
- Durable Crew-owned package persistence for npx installs: the already-built published payload (plus its production dependency closure) is staged, validated, and committed under `~/.config/dsh-crew/app/releases/<stamp>` before Harness registration, so installations never depend on a transient npx cache, tarball, or extraction path.
- `status` is read-only and reports the candidate CLI version, installed Crew version/path when determinable, DSH plugin state in the dedicated `dsh-crew` profile, and Codex/Claude integration state.
- `update` is upgrade-aware and safe: it stages and validates the candidate before switching, preserves Crew config/credentials, repairs registration/integrations, stays idempotent when already current, keeps the previous usable release until the replacement is activated, and can repair stale/incomplete payload or registration state.
- `uninstall` removes the Crew-managed installed payload plus plugin registration and host integrations while preserving normal Crew config/backups by default; existing `--purge` semantics remain explicit.

### Changed

- README (English and Chinese) now presents `npx @ran-sh/dsh-crew@latest` as the primary install/manage UX; source-checkout setup remains documented as the developer path.
- The Claude Code and Codex Desktop installers accept an explicit payload root so npx-managed installs render integration paths against the durable installed package instead of a transient execution directory.

## 0.3.2 — 2026-08-23

### Fixed

- Registers local Crew plugins directly in the isolated Crew profile, preserving pnpm release-age policy while keeping install, uninstall, and reinstall lifecycle operations offline and idempotent.
- Derives the authoritative npm-install verifier candidate version from the candidate `package.json` instead of a hard-coded release literal, so `verify:npm-install` and `verify:npm-install:official` work directly for the current candidate without source edits; removes version-stale temp/user-agent labels and keeps the bounded official DSH cohort audit fail-closed.
- Makes disposable worktree cleanup on Windows bounded and truthful: transient cleanup locks are retried with a small backoff, the filesystem fallback only touches Crew-owned worktree paths and verifies the git registration before claiming success, and a workflow whose cleanup fails reports `workspace_retained: true` with a non-empty `cleanup_warning` instead of a clean release. Allowed/primary worktrees are never treated as disposable.

## 0.3.1 — 2026-08-22

### Fixed

- Aligns the published DSH peer/dev package cohort with the authoritative official `@deepseek-ai/dsh@0.1.1-rc.2` release cohort, preventing npm's default resolver from mixing the stale `0.1.0-rc.6` pins with `dsh-tools@0.1.0-rc.8` and failing with `ERESOLVE`.
- Adds a disposable plain-npm-install regression gate for the packed candidate without resolver bypass flags.

## 0.3.0 — 2026-08-22

DSH Crew v0.3 focuses on runtime compatibility, canonical configuration authority, explainable model routing, live runtime controls, release/readiness diagnostics, and hard isolation from the official DeepSeek Harness profile.

### Added

- Runtime identity and Hub compatibility handshake with stable protocol/capability diagnostics.
- Schema-v3 canonical config authority with deterministic legacy import/migration diagnostics.
- Explicit activation boundaries for live, next-workflow, next-session, and restart-required settings.
- Per-attempt sanitized model-selection traces.
- Live `max_parallel` runtime updates without cancelling active workers.
- Opt-in adaptive routing using bounded process-local success/failure/timeout/latency history while preserving explicit priority order.
- Machine-readable readiness/catalog diagnostics.
- Structured failure classification and bounded machine-code propagation across Hub/client/attempt/workflow layers.
- Crew-owned reusable DSH CLI/runtime bootstrap for isolated installs and acceptance runs.

### Changed

- Supported installs now use the Crew-owned DSH home `~/.config/dsh-crew/harness`, profile `dsh-crew`, and Hub port `3210`.
- The official/default `~/.dsh` home and `web` profile are treated as foreign user state and are not modified by normal Crew install/test workflows.
- Source install/status/uninstall prefer the reusable Crew-owned DSH runtime before transient `npx` fallback.
- Settings and `dsh_worker_config` expose canonical runtime/activation/readiness metadata.

### Compatibility and safety

- Final v0.3 acceptance was completed against the execution-time npm `@latest` for official DeepSeek Harness, `@deepseek-ai/dsh@0.1.1-rc.2`.
- Legacy Flash/Pro and collaboration-mode inputs remain supported as compatibility commands while canonical schema-v3 state is authoritative.
- Explicit provider/model priorities remain authoritative and are never reordered by adaptive routing.
- Credentials, quota, pricing, and raw vendor payloads are never used as adaptive-routing inputs.
- Real-environment acceptance verified official Harness state remained unchanged across Crew install/status/uninstall/reinstall.
- Existing DSH peer/dev package constraints are intentionally not bulk-bumped with the top-level CLI because official subpackages do not share one synchronized version line; compatibility is validated against the real Harness runtime instead of guessed from package names.

### Validation

Final isolated acceptance on Windows completed successfully:

- 426/426 deterministic tests passed.
- Client build passed.
- Policy probe passed 13/13.
- Live schema-v3 policy matrix passed 15/15.
- Genuine OpenCode-backed MCP worker and reviewer-class execution passed with sanitized selection traces.
- Live concurrency raise/lower, activation boundaries, adaptive routing, structured error propagation, readiness/catalog, isolated install/status/uninstall, and final isolated reinstall all passed.
- Official Harness `@deepseek-ai/dsh@0.1.1-rc.2` returned HTTP 200 on the official web profile after update; protected `~/.dsh` metadata/hash evidence was unchanged.
- Standalone DeepSeek Official was legitimately skipped because no `DEEPSEEK_API_KEY` was supplied to the executor.
- macOS smoke remains applicability-skipped because the final executor was Windows.
