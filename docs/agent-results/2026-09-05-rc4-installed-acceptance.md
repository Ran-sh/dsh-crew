# RC4 installed acceptance — 2026-09-05

Scope: DSH Crew plugin compatibility and explicit Reviewer result delivery.
Code under test: `7db47ba19ff07f288398689897a73d8d696dd4e5`.
Branch: `codex/post-release-polish`. No main merge or npm publication performed.

## Installed state

- Crew payload and live runtime: `1.2.0-rc.4`.
- Official DeepSeek Harness: `0.1.2-rc.1`, dedicated `dsh-crew` profile on 3210.
- Crew-owned installer completed with `supervisor_convergence.state=VERIFIED`.
- Runtime ID: `7c2ccf64-7d14-40cd-82c0-ec2c2a2298bf`.
- Codex, ZCode, Claude integration and Windows login startup reported installed.
- Claude RC4 cache MCP initialize/tools-list passed (six Crew tools).
- Official web profile was not modified. Existing deprecated bridge diagnostic remains unhealthy.

## Verification

- Full automatic suite: 1104 tests, 1103 passed, 0 failed, 1 skipped.
  The captured summary does not identify the skipped test; do not count it as passed.
- TypeScript: `tsc --noEmit -p tsconfig.client.json` passed.
- Diff whitespace check passed.
- Result contract/workflow regression suite: 39 passed; final optional-field adjustment:
  12 contract/reviewer tests passed, followed by the full suite above.
- Contract module coverage run before the optional-field adjustment:
  lines 98.82%, branches 79.01%, functions 100%. Branch coverage is below 80%.
- Earlier RC3 official cohort manifest audit passed (25 manifests, 264 checks).
  This is manifest compatibility evidence, not a full official-host installation test.

## Real installed MCP/model checks

Used the operator's existing local route, not package defaults:
`opencode-go-muse/muse-spark-1.3-contributor`. Live provider probe returned callable.
Both runs invoked the installed RC4 MCP entrypoint with the corresponding
source environment, through 3210 and isolated worktrees.

| Source | Workflow | Result |
| --- | --- | --- |
| codex | `wf-mto4uxr2-1as9yj` | PASS, success, delivery complete, review approve |
| zcode | `wf-mto4wur9-kzbwq7` | PASS, success, delivery complete, review approve |

Both reviewers inspected the result-contract fix and its runtime normalization,
reported test evidence, edited no files, and released their temporary worktrees.
These checks validate installed MCP paths and source propagation; they are not
interactive UI tests inside the Codex or ZCode applications.

## Defects found and addressed

RC3 real checks exposed `review.delivery_complete=true` while top-level evidence
reported PARTIAL and incomplete delivery. The envelope only consumed Worker
outcomes. RC4 derives standalone review evidence from its review result, requires
successful complete approval, retains failure/cancellation/mutation gates, and
does not invent test execution. A second real check caught the runtime's omitted
mutation flag; the fix now follows that existing optional-boolean contract.

## Remaining scope and observations

- Installation and watcher convergence took several minutes; improve phase
  progress visibility and investigate latency before calling the UX polished.
- Independent reviews noted malformed non-boolean mutation values and absent
  baseline fingerprints as follow-up hardening areas. Current normalizeReview
  emits true or omits the flag; broader baseline guarantees need separate review.
- Native client UI interactions, visual/image-generation features, Windows login
  after reboot, and every configured alternative provider were not retested here.
- No claim of complete product acceptance or release approval is made.
