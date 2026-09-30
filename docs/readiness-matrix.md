# DSH Crew Readiness Matrix

The readiness matrix is a conservative diagnostic surface for release and environment confidence. Its primary rule is simple:

> Missing evidence is never PASS.

The matrix is emitted by `hubStatus()` and is therefore visible inside the existing `dsh_worker_config` response under `hub_compatibility.readiness_matrix`.

## Statuses

- `PASS` — direct evidence confirms the row.
- `FAIL` — a check actually ran and produced an incompatible or failed result.
- `BLOCKED` — the check could not run because required infrastructure or authorization was unavailable.
- `SKIP` — the row is intentionally not applicable for the active policy/path.
- `NOT_APPLICABLE` — the row asks about a route this machine does not use, and the
  matrix says so instead of omitting it. The two built-in DeepSeek rows are the only
  rows a policy may mark this way: they read `NOT_APPLICABLE` /
  `WORKER_PROVIDER_FOLLOWS_DSH` whenever a known, other provider is selected, and keep
  `NOT_RUN` when the selection is unknown.
- `NOT_RUN` — no trusted evidence has been supplied for the row.

`BLOCKED` and `SKIP` are not failures. `NOT_RUN` is not success.

Applicability is decided when the row is built and it is final for that row:

- Supplied evidence can neither create nor clear it. `NOT_APPLICABLE` is not part of
  the evidence vocabulary (`PASS`, `FAIL`, `BLOCKED`, `SKIP`, `NOT_RUN`), so no
  evidence source can make a required row disappear from readiness, and evidence
  reported against a not-applicable row is kept as `reported_evidence` metadata
  instead of flipping the status back.
- A required row that arrives as `NOT_APPLICABLE` anyway is a contradiction, not a
  pass: consumers that project such a row into readiness report
  `UNAVAILABLE` / `CHECK_NOT_APPLICABLE_ON_REQUIRED_ROW`, which cannot leave the
  aggregate READY.
- The matrix declares `schema_version: 2`: a row may legally be `NOT_APPLICABLE` and
  the summary carries a matching key, which is what a strict consumer needs to know.

## Evidence classes

The matrix separates three kinds of evidence:

1. `live-runtime` — facts the current process can directly observe, such as Hub reachability and protocol compatibility.
2. `ci` — platform validation such as Linux deterministic, Windows regressions, and future macOS smoke.
3. `real-execution` — provider/model and workflow behavior that requires a genuine DSH execution.

Live checks are populated automatically. The config report also consumes the
compatible Hub's bounded job registry, so a completed Worker or Reviewer can
promote the corresponding generic real-execution row. Other CI and execution
rows remain `NOT_RUN` until a trusted higher layer supplies explicit evidence.

## Target rows

- `linux_deterministic`
- `windows_regressions`
- `macos_smoke`
- `hub_compatibility`
- `provider_catalog`
- `provider_health`
- `reviewer_health`
- `model_execution`
- `worker_primary_callable`
- `worker_escalation_callable`
- `reviewer_primary_callable`
- `provider_lifecycle_consistent`
- `deepseek_flash`
- `deepseek_pro`
- `reviewer_pipeline`
- `cancellation_timeout_escalation`
- `standalone_official`

This list is the one the code builds; it had drifted, listing a row that was
removed and omitting four that exist.

Coverage of a provider is not a row per provider. `deepseek_flash` and
`deepseek_pro` are the exception: they name DeepSeek Official because that
provider has its own slots, and a machine running its workers elsewhere has no
such execution to show — the row says so rather than borrowing another
provider's. Everything else that answers "can this machine's configured route
actually run" — `provider_health`, `reviewer_health`, `model_execution`,
`worker_primary_callable`, `reviewer_primary_callable`, `reviewer_pipeline` — is
filtered to whatever route is currently selected, so an operator on other
providers is covered by those and loses nothing by the two DeepSeek rows
reading `NOT_APPLICABLE` under `follow-dsh`. A static row per provider was tried and replaced by these
dynamic signals; `opencode_go_mimo_qwen` was that attempt's last trace in this
document.

`provider_health` and `reviewer_health` describe only the currently resolved
Worker and Reviewer routes. A fresh negative observation overrides historical
success; unrelated providers and stale observations do not. Historical jobs
count only when their provider/model matches the corresponding current route,
with escalation evidence matched against the current escalation route.

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

`src/ci-evidence.mjs` is that layer for the `ci` rows. It resolves the running
version's tag to the commit it was cut from, reads that commit's CI run, and
evidences each platform row from its own job. Three things have to hold before a
row may go green, because each is a way to look validated without being
validated: the job's runner labels must name the platform the row claims (a job
*name* is not a platform), the run must be one this repository pushed (a pull
request carries its own workflow file, so its runs are not evidence), and the
job itself must have concluded successfully. The commit is recorded in
`evidence_ref` so `version → tag → commit` stays auditable. Nothing is read from
or written to credentials: the public API is used anonymously.

One limit belongs where a reader of a green row will meet it. The mapping starts
from the version number, so the evidence describes the commit the matching tag
points at. A payload installed with `update --candidate <dir>` can carry local
edits that were never tagged while reporting the same version, and the row is
then green for the tagged commit rather than for the tree that is running.
`evidence_ref` names that commit, which is as much as this can honestly say
until the payload records its own revision.
