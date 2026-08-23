# Changelog

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
