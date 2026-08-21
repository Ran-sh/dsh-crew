# ACTIVE ZCode Task

Protocol: Agent Handoff Protocol v1
Agent: ZCode
Mode: TEST_ONLY
Source Branch: test/v0.3-runtime-compat-smoke
Source Commit: e8f4e4acd95f6d1f310863d43dfa87434f5bd67d
Result Path: docs/agent-results/zcode-v0.3-runtime-compat-smoke.md
Delete On Completion: docs/agent-tasks/ACTIVE_ZCODE_TASK.md

## Objective

Real-environment validation of PR #4 / issue #9, the v0.3 Runtime Compatibility Contract.

The code under test is exactly `e8f4e4acd95f6d1f310863d43dfa87434f5bd67d` from `feat/v0.3-runtime-compat-contract`. This TEST_ONLY branch adds only this ACTIVE file on top of that source. Do not implement fixes.

## Hard TEST_ONLY boundaries

- Read `docs/agent-workflow.md` first, then only this ACTIVE task. Do not read another Agent's ACTIVE file.
- Do NOT modify `src/**`, `test/**`, `.github/**`, package/lock files, version/release files, or repository configuration.
- Do NOT modify the user's existing DSH `web` profile installation, `~/.dsh/settings.yaml`, `~/.config/dsh-crew/config.json`, credentials, Codex config, or Claude config.
- Never print/read credential values. Environment-variable NAMES and redacted presence checks are allowed.
- You MAY create and fully remove: a disposable DSH test profile, disposable git repositories, temporary logs, temporary ports/processes, and temporary non-repository files needed for validation.
- Do not leave a v0.3 test plugin installed in the user's existing `web` profile.
- The only repository writes allowed are the Result Path and deletion of this ACTIVE file.

## Preflight

1. Verify checkout branch/head and record the exact tested code source `e8f4e4acd95f6d1f310863d43dfa87434f5bd67d` (the ACTIVE-only commit may be newer).
2. `pnpm install --frozen-lockfile`.
3. `node --test test/*.test.mjs`.
4. `pnpm run build:client`; restore generated `lib/client.js` afterward if the build changes it so the repository is clean except the permitted report/ACTIVE lifecycle.
5. Record OS, Node, pnpm, DSH version, and existing running Hub/plugin revision if discoverable without mutation.

## R1 — Real stale-Hub classification

Use the user's EXISTING Hub only as a read-only stale-Hub target if it is still the previously observed old plugin generation.

- GET existing `/_dsh/dsh-crew/ping`: record status/service.
- GET existing `/_dsh/dsh-crew/runtime`: expected for an old Hub is 404 / absent.
- Run the SOURCE MCP (`node src/server.mjs` through an MCP-capable test client / existing harness) with `DSH_CREW_HUB` pointed at that Hub.
- Call `dsh_worker_config` with no mutation.
- Expected:
  - `hub_reachable=true`
  - `hub_compatible=false`
  - `hub_compatibility.code=HUB_PROTOCOL_MISSING`
- Attempt one harmless disposable-repo worker dispatch in `mode=auto` OR `mode=hub` only to prove admission behavior. It MUST fail closed with the compatibility code/message and MUST NOT start a Standalone attempt or Hub job.
- Verify job/process counts/evidence sufficiently to prove no fallback worker was launched.

If the existing Hub is no longer old, do not downgrade or mutate it just to manufacture this case. Mark the real stale-Hub subcase SKIP and rely on deterministic tests for legacy 404; continue all current-Hub cases below.

## R2 — Disposable current-Hub profile

Create a completely disposable DSH profile (not `web`) and run it on an unused loopback port.

Install/link the exact source under test into that disposable profile using the safest supported local/Git mechanism. You may inspect DSH CLI help to choose the command. Requirements:

- the existing `web` profile is untouched;
- the test profile loads this source generation, not main/old cache;
- no package/version upgrade beyond what is required to instantiate the disposable profile;
- no credential values copied/printed.

Start DSH for that disposable profile on an alternate port. Verify:

- `/_dsh/dsh-crew/ping` => 200 and `service=dsh-crew-hub` (legacy reachability stays intact)
- `/_dsh/dsh-crew/runtime` => 200
- `runtime_version=0.3.0-dev`
- `protocol_version=1`
- capabilities include at least: `jobs`, `jobs-wait`, `jobs-cancel`, `roles`, `attempt-index`, `model-policy`

Record the exact plugin/source resolution used by the disposable profile.

## R3 — MCP compatibility report against current Hub

Run SOURCE MCP with `DSH_CREW_HUB=http://127.0.0.1:<test-port>` and call `dsh_worker_config`.

Expected:
- `hub_reachable=true`
- `hub_compatible=true`
- `hub_compatibility.code=null`
- runtime/protocol/capabilities match R2.

Also verify MCP server identity reports runtime generation `0.3.0-dev` if your MCP test client exposes server info.

## R4 — Real current-Hub worker smoke

Use a disposable Git repository with a tiny deterministic coding task + test. Do not use the dsh-crew checkout as worker target.

- Keep worker provider selection as already authorized by the user's environment; do not invent credentials or provider IDs.
- Because Windows `minimal` is a known environment limitation, use a session-only terminal-capable preset such as `cordis` when needed; do not edit global Crew config.
- Start a real blocking or async workflow through the SOURCE MCP against the disposable current Hub.
- Require one actual Hub worker attempt, successful candidate/delivery, and deterministic independent replay/test PASS.
- Record workflow id, Hub attempt id, provider/model, selection source, terminal status, candidate changed files, and replay result.

R4 PASS proves the compatibility handshake did not break real Hub execution.

## R5 — Compatibility cache / transition sanity

Within practical bounds, verify that forcing/refreshing a compatibility read after Hub state changes is not permanently stuck on the old 10-second cached state. At minimum:
- fresh MCP process against current Hub reports compatible immediately;
- repeated config/status calls remain stable;
- no stale `HUB_PROTOCOL_MISSING` survives into the fresh MCP/current-Hub case.

Do not create races or destructive restarts solely for this check.

## R6 — Cleanup and safety

- Stop only the disposable DSH process you started.
- Remove the disposable DSH profile and temporary repos/files/logs when safe. If a live process holds a log file, record it and remove everything else.
- Existing `web` profile remains byte/semantic unchanged to the extent safely verifiable.
- Existing `~/.dsh/settings.yaml`, Crew global config, credentials, Codex/Claude configs unchanged.
- Repository working tree clean except Result Path + ACTIVE deletion before commit.
- No secret values in report/git diff.

## Required report

Write `docs/agent-results/zcode-v0.3-runtime-compat-smoke.md` with:

1. Source/test branch and exact tested source SHA.
2. Environment and DSH/plugin revisions.
3. Preflight results.
4. R1–R6 each as PASS / FAIL / SKIP / BLOCKED with evidence.
5. Exact stale-Hub compatibility code observed (if R1 real case exists).
6. Exact current `/runtime` identity and capabilities.
7. Real worker ids/provider/model/result + independent replay evidence.
8. Cleanup/safety evidence.
9. Any blocker classified as SOURCE_BUG / DSH_ENVIRONMENT / TEST_INFRA.
10. Final verdict exactly one of:
   - `READY — RUNTIME COMPATIBILITY CONTRACT PASS`
   - `NOT READY — FIX SOURCE`
   - `BLOCKED — ENVIRONMENT`

## Completion protocol

After testing:
- add only the report;
- delete only your own `docs/agent-tasks/ACTIVE_ZCODE_TASK.md`;
- commit and push the permitted changes to `test/v0.3-runtime-compat-smoke`;
- final response must contain only: Source Commit SHA, Report Commit SHA, R1–R6 summary, blockers/failures, Verdict, Report Path.
