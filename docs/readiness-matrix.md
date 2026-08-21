# DSH Crew Readiness Matrix

The readiness matrix is a conservative diagnostic surface for release and environment confidence. Its primary rule is simple:

> Missing evidence is never PASS.

The matrix is emitted by `hubStatus()` and is therefore visible inside the existing `dsh_worker_config` response under `hub_compatibility.readiness_matrix`.

## Statuses

- `PASS` — direct evidence confirms the row.
- `FAIL` — a check actually ran and produced an incompatible or failed result.
- `BLOCKED` — the check could not run because required infrastructure or authorization was unavailable.
- `SKIP` — the row is intentionally not applicable for the active policy/path.
- `NOT_RUN` — no trusted evidence has been supplied for the row.

`BLOCKED` and `SKIP` are not failures. `NOT_RUN` is not success.

## Evidence classes

The matrix separates three kinds of evidence:

1. `live-runtime` — facts the current process can directly observe, such as Hub reachability and protocol compatibility.
2. `ci` — platform validation such as Linux deterministic, Windows regressions, and future macOS smoke.
3. `real-execution` — provider/model and workflow behavior that requires a genuine DSH execution.

Only live checks are populated automatically by the current runtime. CI and real-execution rows remain `NOT_RUN` until a trusted higher layer supplies explicit evidence.

## Target rows

- `linux_deterministic`
- `windows_regressions`
- `macos_smoke`
- `hub_compatibility`
- `provider_catalog`
- `deepseek_flash`
- `deepseek_pro`
- `opencode_go_mimo_qwen`
- `reviewer_pipeline`
- `cancellation_timeout_escalation`
- `standalone_official`

## Provider/catalog rule

The Hub client does not know the active worker provider mode, so its embedded matrix leaves `provider_catalog` as `NOT_RUN` with `PROVIDER_MODE_UNKNOWN` rather than guessing.

When a higher layer knows the provider mode and has actually read the Harness catalog, it may build a more specific matrix:

- DeepSeek Official strict mode: catalog row may be `SKIP` / `PROVIDER_CATALOG_NOT_REQUIRED`.
- Follow-DSH with successful catalog read: `PASS` / `PROVIDER_CATALOG_RESOLVED`.
- Follow-DSH with an attempted but failed catalog read: `FAIL` / `PROVIDER_CATALOG_UNAVAILABLE`.
- Hub unavailable/incompatible before catalog access: `BLOCKED`, not `FAIL`.

## Credential safety

The matrix never reads or returns credential values, provider configuration payloads, quota data, pricing, cookies, tokens, or raw exception dumps. The standalone row defaults to `NOT_RUN` / `CREDENTIAL_STATUS_NOT_PROBED` unless an authorized real-environment validation explicitly reports evidence.

## Trusted evidence

`buildReadinessMatrix()` accepts an optional evidence map so CI/report aggregation can be added later without changing row semantics. Evidence can set only the existing status vocabulary. Invalid statuses are ignored rather than broadening the contract.

An evidence record may contain:

```json
{
  "status": "PASS",
  "reason_code": "CI_GREEN",
  "evidence_source": "github-actions",
  "evidence_ref": "run-123"
}
```

The matrix does not fetch or trust arbitrary remote data by itself. Loading and authenticating an evidence source is the responsibility of the higher layer that calls the builder.
