# Changelog

## Unreleased

Future changes go here.

## 1.10.0 — 2026-09-12

- Names a worktree for what it is: `Crew_<date>_<time>_<purpose>`, for example
  `Crew_20260912_183045_worker`. The old name was a job id and random hex, so an
  operator looking at the worktree list — or at a cleanup prompt — could not tell
  when a job ran or whether a tree belonged to a worker or a reviewer. The
  purpose is the job's role, which is what the job actually is. Worktrees from an
  earlier release keep being recognised as Crew's under their old prefix, so they
  are still adopted and cleaned up.
- Reserves the worktree directory instead of probing for a free name. The name is
  chosen before anything is created, so two jobs starting inside the same second
  both saw it free, took it, and one lost the race on `git worktree add`. The
  suffix that disambiguates them is allocated by `mkdir`, which fails on
  collision and therefore cannot race; a refused `git worktree add` releases the
  reservation.
- Never treats the main working tree as a stale Crew worktree. Retention lists
  every worktree whose directory starts with a Crew prefix and prunes the ones
  outside the allowed set; a repo whose own directory starts that way — a
  checkout named dsh-crew-something — would land in that list. Nothing was
  destroyed (git refuses to remove a main working tree, and the fs fallback is
  guarded), but every prune would have produced a confusing lock error against
  the repo. `git worktree list` puts the main working tree first, and that
  position is what identifies it — matching the repo root by path cannot work,
  because inspecting from inside a linked worktree reports that worktree as the
  top level.

## 1.9.1 — 2026-09-12

- Releases publish from GitHub Actions through OIDC. Publishing needed a browser
  approval every time because an npm session token cannot publish on its own; a
  granular token with 2FA bypass would remove that at the cost of a long-lived
  credential in a plaintext file that can publish with nobody present. OIDC has
  neither problem: the credential is minted per run from the workflow's identity,
  and pushing the tag is the authorization — the same action the release already
  needed. Provenance is generated automatically. The job refuses a tag that
  disagrees with `package.json`, refuses when the build changes a committed
  artifact, and runs the suite first.

## 1.9.0 — 2026-09-12

- Names a worktree for what it is: `Crew_<date>_<time>_<purpose>`, for example
  `Crew_20260912_183045_worker`. The old name was a job id and random hex, so an
  operator looking at the worktree list — or at a cleanup prompt — could not tell
  when a job ran or whether a tree belonged to a worker or a reviewer without
  opening something. The purpose is the job's role, which is what the job
  actually is. Worktrees from an earlier release keep being recognised as Crew's
  under their old prefix, so they are still adopted and cleaned up.
- Reserves the worktree directory instead of probing for a free name. The name is
  chosen before anything is created, so two jobs starting inside the same second
  both saw it free, took it, and one lost the race on `git worktree add`. The
  suffix that disambiguates them is now allocated by `mkdir`, which fails on
  collision and therefore cannot race. This was reproducible: two concurrent
  coding jobs failed intermittently, and eight concurrent reservations now
  succeed with unique names on every run.

## 1.8.0 — 2026-09-12

- Teaches the skill what a host actually trips on: how to dispatch, and how to
  read what comes back. `phase: failed` is the part that misleads — it usually
  means the delivery gate rejected the result, not that the worker broke, and
  `terminal_reason: escalation_disabled` is the escalation policy declining to
  retry rather than a separate failure. A reply-only task landing on
  `DELIVERY_INCOMPLETE` looks like a defect and is the gate working. The skill
  now carries a code table, the phase list, and the surprises worth knowing
  before dispatching: isolated workspaces need git, `timeout_seconds` is per
  attempt, and a worker cannot see the caller's conversation.
- Pins the skill's factual claims to the code. Two tests read
  `FAILURE_REASON_CODES` and `JOB_PHASES` and fail if the skill omits any, so a
  renamed or added code cannot leave the guidance confidently wrong.

## 1.7.2 — 2026-09-12

- Drops what the policy removal left behind. `codex/AGENTS.md` and
  `zcode/AGENTS.md` were the source of the injected blocks and had no reader
  left, and `managedPolicyBlock`, which read the Codex one, had no caller — dead
  weight in the shipped payload that implied a policy still gets installed. The
  markers and legacy-hash helpers stay: they are what removes a block an older
  release wrote.
- Guards the test isolation that has failed repeatedly here. A test that injects
  a temporary `home` but omits `env` makes the installer follow the developer's
  real `CODEX_HOME`, so the run writes — or deletes — the live skill; three call
  sites did exactly that and removed the real Codex skill. A test now fails when
  a call site forgets `env`, so the mistake is caught by the suite instead of by
  a missing skill later.

## 1.7.1 — 2026-09-12

- Ships the skill template in the npm package. `skills/` was missing from the
  `files` allowlist, so a published install failed every host integration with
  `CREW_SKILL_TEMPLATE_MISSING`: the installer was packaged, the template it
  copies was not. The distribution test now asserts both, which is the check that
  would have caught it.

## 1.7.0 — 2026-09-12

- Replaces the injected delegation policy with an on-demand skill. Crew used to
  write a "capability-aware delegation policy" block into each host's global
  instruction file, so every Codex and ZCode session carried Crew's delegation
  rules — and the operator gate that stops work when Crew is unavailable —
  whether or not Crew was wanted that turn. That shapes how the host does its own
  work, which is the opposite of what an optional capability should do.

  The same guidance now ships as a skill, loaded only when the operator asks for
  Crew. It is installed for each host the way the Oracle skill is: the shared
  `~/.agents/skills` that ZCode reads, plus `$CODEX_HOME/skills` and
  `~/.claude/skills`. Nothing about a host's default behaviour changes until the
  skill is invoked.

  `dsh-crew install` now **removes** any policy block a previous release wrote
  into `~/.codex/AGENTS.md` or `~/.zcode/AGENTS.md` — user-authored text in those
  files is untouched — and uninstall removes the skill. Readiness reports the
  skill instead of the block.

  The Codex and ZCode functions take an explicit `env` so tests no longer resolve
  the developer's real `CODEX_HOME`.

## 1.6.2 — 2026-09-12

- Cleans the removed bridge's keys from a canonical config, not only a legacy one.
  The read path takes a different branch for a canonical file and spreads the
  stored object directly, so the 1.6.1 cleanup never ran on a real config — the
  dead keys stayed in the file and in the `/config` response. The removal now
  happens before either branch, and the test covers the canonical case, which is
  the one a real machine has.

## 1.6.1 — 2026-09-12

- Drops the removed bridge's keys from configs written before it went away. The
  stored-config merge keeps unknown keys on purpose, so those six would otherwise
  sit in the file forever — inert, but there and confusing. Only the known-dead
  keys are deleted; any genuinely unknown key from a newer release is kept.

## 1.6.0 — 2026-09-12

- Removes the vision and image-generation bridge entirely. It existed only to
  lend the text-only model eyes (`describe_image`, pasted-image transcription)
  and a brush (`generate_image`) through a locally installed subscription CLI,
  and it could not do that here: the `codex` provider had the CLI off PATH with
  a model its account does not serve, and the fallback CLI returned nothing. A
  feature that is switched on but cannot work is worse than no feature, so the
  tools, the vision route, the custom-adapter panel and their config keys are
  gone rather than left dormant.

  Removed: `src/multimodal.mjs`, `src/vision-route.mjs`, `src/image-output.mjs`,
  the `describe_image` / `generate_image` registration and the vision route at
  plugin boot, the `/vision-models` and `/provider-test` routes, the panel's
  "Vision & image generation" and custom-adapter sections, and the
  `vision_enabled` / `imagegen_enabled` / `vision_provider` / `vision_model` /
  `imagegen_provider` / `custom_providers` config keys with their 3080 quick
  controls. The provider record's `multimodal_refs` field went with them.

  Settings that no longer exist are simply dropped on the next config write;
  nothing else in the panel or the workflow reads them.

## 1.5.1 — 2026-09-12

- Resolves the vision bridge's CLI instead of spawning a bare name. Codex
  Desktop installs its binary under a versioned directory that is not on PATH,
  and a GUI-launched Hub does not inherit the shell's PATH, so `describe_image`
  failed with a bare `spawn codex ENOENT` even though the CLI was installed and
  working. The bridge now resolves like the workspace code resolves git: the
  platform locator first, then the known install locations, preferring something
  `spawn` can actually execute — npm installs an extensionless shim beside a
  `.cmd`, and taking the first hit resolved `claude` to a shell script that
  `spawn` cannot run. A Windows `.cmd`/`.bat` shim is launched through `cmd.exe`
  with argv, never a command string, so no argument is re-parsed by a shell.
  `imagegen` shared the same resolution path. A name that resolves to nothing is
  returned unchanged, and the spawn error now says which CLI, what was checked,
  and what to do instead of only `ENOENT`.
- Fixes the Codex vision invocation. `-i/--image` is variadic, so
  `-i file.png "<prompt>"` made the CLI read the prompt as a second image and
  fail with "no prompt provided via stdin". The prompt is passed first and the
  image bound with `--image=` so it takes exactly one value.
- Stops the CLI from failing silently. Actions return a structured failure rather
  than throwing, and the dispatcher turned that into exit 1 without printing
  anything — so `dsh-crew rollback` with no version or an unknown version exited
  1 having said nothing at all. The failure reason is now printed.
- Replaces a raw NUL byte in `src/multimodal.mjs` with the `'\0'` escape the rest
  of the repo uses. It was inside a string literal so it worked, but it made the
  file read as binary to editors and diff tooling.
- Stops release retention from deleting a release a running process is executing.
  The Hub loads several modules lazily with a cache-busting query so a config
  edit is visible without a restart; those reads go to disk every time, so
  removing the release under a live process breaks exactly the routes behind
  them. Retention protected the *current pointer* but not the release a running
  process was actually on, so an update could leave a machine whose settings
  panel answered `500 Cannot find module` on `/config`, `/install/status`,
  `/quick-status` and `/runtime/restart-status` — and updating again did not
  repair it, because the damage is to the process, not the files. A process now
  records the release it is running and retention skips any release with a live
  claim; liveness is decided by the pid, so a process that dies without cleaning
  up cannot pin a release forever, and a claim that cannot be written is ignored
  rather than failing the start.
- Writes the Codex integration where Codex actually reads it. Codex honours
  `CODEX_HOME` and falls back to `~/.codex`, but the installer only ever wrote the
  latter — so for anyone who set `CODEX_HOME`, every install reported success
  while Codex kept reading a registration frozen on whatever release was current
  when the variable was set. On this machine that meant a `[mcp_servers]` entry
  still pointing at a release deleted weeks earlier, with the dsh-crew tools
  silently absent from Codex the whole time. The integration now resolves the
  directory the same way Codex does, for the MCP entry, the role files, the
  managed policy block, readiness and uninstall alike.
- The Codex functions take an explicit `env` so tests no longer read the
  developer's real `CODEX_HOME`. Without it a test that injects a temporary
  `home` still resolved to the live Codex directory: the fixtures passed, but the
  install had written into the operator's own config.

## 1.5.0 — 2026-09-11

- Fixes a `ReferenceError` that broke the `dsh_worker_config` tool outright. The
  config report passed `{ enabled_roles }` as a shorthand to a function whose
  parameter carries that name, but the local binding is camelCase — so the call
  raised `enabled_roles is not defined` instead of returning configuration. It
  only fired when the Hub supplied a readiness snapshot, which is the normal
  case, so the tool was unusable in practice while looking correct in isolation.
- Adds per-model peak/off-peak scheduling. Some providers price by wall clock —
  DeepSeek doubles its rate during peak hours — and until now Crew had no way to
  express that, so an operator could not steer expensive work away from the
  expensive window. Each model in a priority list now carries its own rule:
  **block** skips it during peak so the next candidate serves the job, **warn**
  keeps using it and flags the choice in the selection trace, and an unlisted
  model is unrestricted. One shared schedule holds the windows, the days they
  apply to, and a fixed UTC offset (default UTC+8); the defaults are DeepSeek's
  published peak hours — UTC 01:00-04:00 and 06:00-10:00, Mon-Fri — expressed in
  that offset as 09:00-12:00 and 14:00-18:00. Windows may cross midnight, and a
  window's early-morning half belongs to the weekday it started on.
- The schedule is matched per `{provider, model}`, so the same model name on two
  providers is restricted independently, and a rule is inert outside peak.
- Malformed config fails **open**, never toward restriction. A missing field gets
  its documented default, but a field that is present and unusable — a string
  where a list belongs, a non-integer offset such as `"480garbage"` — makes the
  schedule inert instead of substituting defaults, because substituting would
  switch on restrictions the operator never asked for. A broken field empties only
  the axis that activates restrictions; the fields and per-model rules that still
  parse are kept, so corruption is not also collateral damage. Inside a valid
  container, an unparseable window is dropped rather than widened to all day, and
  an unknown mode is not a rule.
- The panel uses `src/model-schedule.mjs` directly instead of keeping a
  hand-maintained copy of its normalization and peak test. The module imports
  nothing, so both realms can share it; a copy that accepted less than the server
  would rewrite a server-valid config differently on the next save, because the
  panel writes the normalized schedule as a whole.
- Every path that resolves a model now honours the schedule. Besides the catalog
  paths, this covers the strict `deepseek-official` dispatch, the standalone
  `jobs.mjs` dispatch, and the extension and provider projections the panel reads;
  a projection that ignored the schedule would report a model routing would skip.
  Model resolution also reads the clock once per resolution rather than per
  candidate, so a resolution that straddles a peak boundary cannot judge its
  candidates against different instants.
- The panel can configure a rule for any model the router can select, not only
  those in the flat tier mirrors. The Pro mirror exposes worker-escalation *or*
  reviewer priority — whichever is set — so a reviewer-only model was routable but
  unconfigurable. More models are now offered: both roles' primary and escalation
  lists, Harness Default, and the catalog.
- Records a `warn` verdict on the job as `peak_advisory`, matching the routing
  result, and gives a peak-blocked strict dispatch the same structured trace and
  provider/model evidence the catalog path produces. The timezone selector offers
  real-world minute offsets, so a stored offset always has a matching option.
- Fixes three defects found in review. A `warn` model selected through the
  multi-provider preferred-default path lost its advisory, because only the
  surviving candidate object was kept while the verdict was discarded. Filtering
  that left exactly one admissible candidate could still report no model
  available when the removed candidate was the one matching the Harness Default
  provider, since both the deterministic and adaptive choices came back empty.
  And a candidate already rejected for a concrete reason was recorded a second
  time as ambiguous, contradicting its own trace entry.
- The strict `deepseek-official` dispatch path, which names its model directly
  instead of walking a catalog, now honours a peak `block` too. Previously the
  whole feature was silently inert on every dispatch using that provider mode.

## 1.4.0 — 2026-09-11

- Scopes cleanup by who created the session. A Crew worker's session and the
  operator's own session are otherwise indistinguishable — one shared store, the
  same header shape, and no field recording who asked for it — so the previous
  range selector could only offer "everything", which removed the operator's own
  conversations along with Crew's. The hub now records the session id of every
  dispatch in an append-only ledger (`session-origins.jsonl`), and the panel
  defaults to a new **Crew-created only** scope. **Crew worktrees** narrows
  further to isolated-workspace sessions, and **everything** keeps the old
  behaviour for deliberate use. A session the ledger cannot vouch for is the
  operator's: absence is never treated as Crew authorship, so neither a session
  predating the ledger nor a lost line can widen the range.
- Stops the maintenance runner from being killed by the stop it requested, which
  left cleanup stranded. The runner stops 3210, rewrites the session store, then
  starts it again, so it must outlive the hub; but the supervisor stops a service
  by killing that service's whole tracked process tree, walked through
  `ParentProcessId`, and a runner spawned directly by the hub sits inside it. The
  runner is now launched through an intermediate that exits immediately, leaving
  it parented to a dead process and outside the tree. Previously a cleanup could
  freeze in `STOPPING` with a stale update lock and no operator-side way to
  finish it, recoverable only by running `dsh-crew history recover` by hand.
- Stops the history cleanup admission fence from latching on forever. The fence
  treated a non-empty agent registry as "a conversation is in use", but the
  session controller resumes a session into that registry as soon as the web UI
  opens it and never releases it — so on any machine whose UI had ever shown a
  session, every cleanup transaction stayed blocked behind `ACTIVE_SESSIONS`
  with no way to clear it. Registration is not activity: only an agent whose
  status is `running` now fences the operation, and a creation still awaiting
  publication is guarded separately as before.

## 1.3.2 — 2026-09-11

- Stops the history cleanup admission fence from latching on forever. The fence
  treated a non-empty agent registry as "a conversation is in use", but the
  session controller resumes a session into that registry as soon as the web UI
  opens it and never releases it — so on any machine whose UI had ever shown a
  session, every cleanup transaction stayed blocked behind `ACTIVE_SESSIONS`
  with no way to clear it. Registration is not activity: only an agent whose
  status is `running` now fences the operation, and a creation still awaiting
  publication is guarded separately as before.

## 1.3.1 — 2026-09-11

- Reads the 0.1.5 session-storage surface. The jsonl backend replaced
  `listSnapshots()` with `listArtifacts()` and dropped `supportsRawArtifacts`,
  and one artifact per Session format generation is now named `session.vN.jsonl`
  rather than `session.jsonl`. The cleanup inventory understood neither, so
  every preview failed with `HISTORY_STORAGE_UNSUPPORTED`; it now reads either
  inventory surface and both the inventory and the archive guard accept the
  versioned generation name.
- Stops a profile from resolving its web bundles out of a foreign cohort. A
  profile first installed against a source checkout records `dsh-base` and
  `dsh-web-app` as links into that checkout; switching the CLI to another
  cohort left those links behind, and because they sit in the profile's own
  `node_modules` they shadowed the matching packages installed beside it. The
  host then composed the web app of one cohort while the client plugin table
  came from another, so a plugin added by the newer cohort died at require time
  with `client-modules: require(...) missed the module table` and the UI
  rendered "Failed to load plugins". Registration now unshadows such an entry
  whenever the package installed beside the profile provably resolves to the
  pinned cohort, and leaves a deliberately different cohort pin untouched.

## 1.3.0 — 2026-09-11

- Moves the pinned Harness cohort from `0.1.2-rc.1` to `0.1.5-rc.2`.
- Adapts the worker overlay to the 0.1.5 profile contract: `system-prompt`'s
  `persona` key is renamed to `personaPrefix`, and the `fs-local` provider that
  sdk-minimal no longer ships becomes a Crew-owned insert row (the Crew tool
  suite still injects the `fs` service).
- Derives the history runtime's cohort checks from `src/dsh-cohort.mjs` instead
  of hardcoding the pinned version in `src/history/`.
- Rebases the Windows launcher on the Crew-managed Harness entry. The CLI is now
  selected as `DSH_CREW_DSH_CLI` → the Crew npm runtime → a source cohort
  validated against its own manifest, and the 3080 frontend boots that same
  entry instead of a hardcoded alpha source tree. No cohort value is pinned in
  the launcher, so a cohort bump no longer needs a matching launcher edit.

## 1.2.0-rc.6 — 2026-09-07

- Aligns the runtime identity with the published Crew release so Windows
  supervisor handoff verification can complete after npm installation.

## 1.2.0-rc.5 — 2026-09-07

- Fixes Windows PowerShell 5.1 parsing of the official 3080 overlay during
  desktop startup.
- Makes model activity telemetry preserve unknown roles and labels its count as
  qualifying jobs rather than inferred model calls.

## 1.2.0-rc.4 — 2026-09-05

- Reports complete standalone Reviewer evidence without requiring a Worker
  outcome, preserving failure, cancellation, incomplete-review and mutation gates.

## 1.2.0-rc.3 — 2026-09-05

- Preserves the caller's task for explicit Reviewer workflows while keeping
  automatic post-Worker review on its bounded candidate evidence capsule.

## 1.2.0-rc.2 — 2026-09-05

- Applies session-level review-pipeline, automatic-review, and escalation
  overrides to canonical v4 configuration without overwriting model priority,
  fallback, adaptive routing, health gates, or provider selection.

## 1.2.0-rc.1 — 2026-09-04

- Makes Windows launcher upgrades automatic and crash-resumable: install,
  update, and rollback reserve supervisor ownership before releasing the
  payload transaction, hand off the exact watcher PID, and verify the new
  3210 Crew/DSH runtime identity.
- Adds bounded maintenance discovery, exact PowerShell/process/helper
  provenance, durable STOPPED-session recovery, and safe resume across every
  watcher handoff checkpoint.
- Keeps supervisor assets in a hash-bound Crew-owned manifest so unfinished
  handoffs survive global package refreshes and legacy retained payloads remain
  valid rollback targets.

## 1.1.1 — 2026-09-04

- Supports the multiline flow-style Provider settings emitted by Harness
  0.1.2-rc.1, including bounded materialization, safe add/remove operations,
  and native user-layer deletion visibility.
- Treats a fresh empty Harness profile patch as valid and stabilizes the
  update-lock contention regression under heavily parallel Windows test runs.

## 1.1.0 — 2026-09-04

- Consolidates the Crew configuration control plane onto 3210: the native
  harness page is now the single full control plane; the official 3080 page
  is an optional narrow quick-controls panel (master switch, flash/pro
  model priority, vision/imagegen toggles).
- Durable supervisor control channel: the hub writes restart/maintenance
  requests, the Windows launcher executes them (heartbeat-gated, lease-
  paired, one-shot). The 3080 bridge no longer spawns or owns 3210.
- 3080 bridge slimmed to a least-privilege allowlist (quick-config,
  quick-status, runtime/restart-request, runtime/restart-status); legacy
  supervisor endpoint returns 410 Gone.
- Independent full (3210) and quick (3080) client bundles; quick bundle is
  capability-light by construction.

## 1.0.4 — 2026-09-03

- Upgrades the pinned DeepSeek Harness cohort from 0.1.2-alpha.5 to
  0.1.2-rc.1 (single source of truth in src/dsh-cohort.mjs).
- Makes cross-cohort payload updates a coordinated payload + runtime
  transaction: the 3210 never runs an unsupported payload/cohort pair, and
  the swap is covered by the durable update journal with synchronous
  crash recovery.
- Retains swapped-out runtime cohorts under retained-runtimes/ so rollback
  across cohorts (rc.1 -> alpha.5) restores offline without a registry
  round-trip.
- Derives the rollback target cohort from the retained payload manifest
  instead of the running code's TARGET.
- Hardens the Windows supervisor health check to require the hub's reported
  dsh_version to match the disk runtime cohort (no stale-process boot).
- Makes scripts/setup.mjs fail closed when a Crew runtime cohort does not
  match the source tree.
- Retires the legacy official-bridge E2E as a release gate (diagnostic only).

## 1.0.3 — 2026-09-02

- Makes profile-to-user Provider migration recoverable and exposes native
  deletion after a Provider is materialized in Harness user settings.
- Keeps the isolated 3210 execution plane and explicit model-priority routing
  intact across the 3080 bridge, Codex, Claude, and ZCode integrations.

## 1.0.2 — 2026-09-01

- Fresh installs now contain only the built-in DeepSeek routing default. User
  provider/model priorities and multimodal adapters remain opt-in local state.
- Hardens provider recovery and mutation-lock ownership against unreadable or
  malformed lock metadata and terminal-job cleanup races.

## 1.0.1 — 2026-09-01

- Preserves every structured Worker/Reviewer execution row in the Hub
  extension readiness snapshot so an approved complete Reviewer run is not
  mistaken for the Worker primary row.

## 1.0.0 — 2026-09-01

- Hardens Provider lifecycle recovery with semantic rollback verification,
  tombstone-aware installer reconciliation, credential-reference inventory,
  and an independent guarded purge transaction for Crew-owned credentials.
- Adds a unified runtime readiness snapshot, v2 execution provenance events,
  retained-release rollback, and capability-gated lifecycle CLI commands.
- Locks production execution and all control-plane commands to the isolated
  3210 Crew Harness; Standalone remains legacy migration metadata only.
- Adds Provider lifecycle rollback UI and complete 3210 runtime provenance
  checks across bridge, CLI, MCP, and client readiness surfaces.

## 0.5.7 — 2026-08-31

- Makes the isolated 3210 Harness the only production execution path; the
  official 3080 surface remains a control-plane bridge.
- Persists and verifies 3210 supervisor ownership across 3080 restarts, and
  hardens bridge provenance and runtime identity checks.
- Adds bounded real Harness provider probes that follow configured model
  priority, plus live-profile parsing for nested model declarations.
- Requires 3210 execution provenance for readiness evidence and updates the
  Windows launcher to let the 3080 bridge own the 3210 child.

## 0.5.6 — 2026-08-30

- Removes Node's Windows `DEP0190` warning from packaged install/update flows
  by replacing `shell: true` npm calls with a bounded explicit command-processor
  invocation that preserves argv quoting, including paths containing spaces.
- Adds a real Windows npm integration test in addition to the deterministic
  invocation-shape and injection-rejection checks.

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
