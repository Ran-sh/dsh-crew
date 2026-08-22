# Changelog

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

- Legacy Flash/Pro and collaboration-mode inputs remain supported as compatibility commands while canonical schema-v3 state is authoritative.
- Explicit provider/model priorities remain authoritative and are never reordered by adaptive routing.
- Credentials, quota, pricing, and raw vendor payloads are never used as adaptive-routing inputs.
- Real-environment acceptance verified official Harness state remained unchanged across Crew install/status/uninstall/reinstall.

### Validation

Final isolated acceptance on Windows completed successfully:

- 426/426 deterministic tests passed.
- Client build passed.
- Policy probe passed 13/13.
- Live schema-v3 policy matrix passed 15/15.
- Genuine OpenCode-backed MCP worker and reviewer-class execution passed with sanitized selection traces.
- Live concurrency raise/lower, activation boundaries, adaptive routing, structured error propagation, readiness/catalog, isolated install/status/uninstall, and final isolated reinstall all passed.
- Official Harness returned HTTP 200 before and after acceptance; protected `~/.dsh` metadata/hash evidence was unchanged.
- Standalone DeepSeek Official was legitimately skipped because no `DEEPSEEK_API_KEY` was supplied to the executor.
- macOS smoke remains applicability-skipped because the final executor was Windows.
