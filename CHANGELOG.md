# Changelog

## Unreleased

- **The CI rows of the readiness matrix can now be evidenced.** `linux_deterministic`,
  `windows_regressions` and `macos_smoke` were `NOT_RUN` on every machine, always:
  the matrix is deliberately inert — it never reads files, GitHub or the network —
  and nothing supplied the platform evidence it accepts. It reads as "unvalidated"
  when the truth was "nobody wired it up". `src/ci-evidence.mjs` is that missing
  higher layer: it resolves the running version's tag to its commit, reads that
  commit's CI run, and evidences each platform row from *its own* job. It fails
  closed everywhere — an untagged version, a missing run, a missing job, a job
  that did not pass, a timeout, an HTTP error all produce no evidence and leave
  the rows `NOT_RUN` — because promoting a row on anything less than a green run
  at the exact commit being validated is the failure it exists to prevent. The
  commit is recorded in each row's `evidence_ref` so the mapping is auditable,
  and the anonymous API is used: no credential is read, required, or logged.
- Rows are judged per job rather than by the run's overall conclusion, so one
  platform's red job cannot withdraw another platform's evidence.
- **`macos-smoke` joins CI.** A platform row with no job behind it can never be
  evidenced, which is why `macos_smoke` had no path to `PASS`. The new job runs
  the portable core plus the client build on macOS.

## 2.1.5 — 2026-09-16

- **An approving reviewer was recorded as `partial`.** `parseDeliveryReport`
  reads the delivery contract off the headings a message carries, and only a
  coding report has a Tests obligation — but `buildOutcome` parsed the `## Tests`
  section unconditionally, so a reviewer that also listed its own coverage had an
  honest `NOT RUN — <check> — <reason>` row read as the worker's test evidence.
  `classifyTaskStatus` turned that into `partial`, and `evidenceStatus` turned
  that into `PARTIAL` / `TESTS_NOT_RUN` on a job whose verdict was `approve`: the
  role was penalised for the disclosure the contract requires. The coding Tests
  rule now applies only to coding reports, and the `deliveryMeta.tests_status`
  fallback can no longer reinstate a verdict the format gate dropped.
- **`evidenceStatus` judged a reviewer by its contract, not its verdict.** Its
  reviewer branch was keyed on `outcome == null`, so the Hub — which always builds
  an outcome — took the generic path, where a complete contract was enough for
  `PASS` even when the verdict was `inconclusive`. A reviewer is now judged by
  `approve`, matching the acceptance gate.
- **An automatic reviewer could only re-read the worker's summary of what ran.**
  The capsule embeds the worker's reported changes and tests and tells the
  reviewer to inspect the workspace, which is impossible for transient work that
  was created, run and removed before the review started; the reviewer's only
  options were trusting the summary or running an equivalent check of its own. It
  now carries a pointer to the reviewed attempt's persisted execution record (the
  Hub session id plus the Crew harness session store), so it can read the original
  `tool/result` entries — the bytes a write produced, and the captured output and
  exit code of every command — from the attempt that actually ran.
- `harness/sessions` was written out in three shapes: an absolute path helper for
  that pointer, a POSIX literal for `pathInside`, and a compiled regex for the
  artifact filter. All three now derive from one constant, so moving the store
  can not update the walk and silently leave the filter behind. Behavior is
  unchanged: the compiled pattern is identical and the resolved directory is the
  same under both path semantics.
- Verified live rather than in tests only: a combined worker → automatic reviewer
  workflow on an activated payload finished `completed / reviewed: true` with the
  worker `done/success` and the reviewer `done/success/approve` — no `partial` —
  after the reviewer read the worker's raw execution record and confirmed the
  script source, the exit code, the stdout bytes and the cleanup.

## 2.1.4 — 2026-09-15

- **2.1.3 stopped the hub and left the frontend running.** The window request
  names its option `refresh_frontend` in the durable document the launcher reads
  and `refreshFrontend` in the client that writes it; the history operation called
  the client with the launcher's spelling, so the flag was dropped and the stop
  went ahead without the frontend. Found by running the cleanup it was written
  for: the maintenance reported DONE, the 48 rows stayed gone, and the STOPPED
  receipt said `frontend_stopped: false` with the frontend still holding port
  3080. The shipped claim from 2.1.3 was therefore false in the field even though
  every test passed — the seam between the two names was the one thing nothing
  asserted.
- Both halves of that boundary are now pinned: the client must turn
  `refreshFrontend` into `extra.refresh_frontend` in the request, and the
  operation must pass `refreshFrontend` for every stop it issues. Both assertions
  fail on the spelling that shipped in 2.1.3.
- Verified against the live machine rather than in tests only: a maintenance-stop
  carrying the flag stopped both servers (`frontend_stopped: true`, ports 3210 and
  3080 free), and the matching start brought the hub back verified and the
  frontend back serving on 3080.

## 2.1.3 — 2026-09-15

- **A workspace whose sessions are already gone can be cleaned up.** The planner
  selected a workspace only when every one of its sessions was in the selection,
  so a workspace whose sessions had already been removed matched no scope at all —
  not `crew`, not `worktree`, not `before`, not even `all`. After an earlier
  cleanup deleted the sessions while something else put the workspace rows back,
  48 of them stayed in the sidebar forever, each opening nothing: `dsh-crew`'s own
  preview offered to remove 2 of the 51. A child that is gone from the session
  store now counts as covered when the provenance ledger recorded Crew creating
  it — the same evidence that makes a live session Crew's makes a removed one
  Crew's — and `archiveHistory` proves the session really is absent before the
  record goes, because a live session named as already gone would drop its
  workspace and leave the artifact behind.
- **The maintenance window covers the second server on the DSH home.** The
  Crew-managed frontend on 3080 boots from the same Crew-managed entry as the hub,
  so it runs on the same home, and DSH's JSON storage replaces each unit file
  whole with last-write-wins. Stopping only the hub is what let a cleanup be
  undone: the last maintenance deleted 49 workspaces and 64 sessions, the sessions
  stayed gone, and the workspace rows were back on disk minutes after the
  operation reported DONE, written by the frontend from the copy it still held in
  memory. A history maintenance now asks the launcher for that server too
  (`refresh_frontend`), stops it **before** the backend so a failure aborts with
  everything still running, records it in the STOPPED session, and starts it again
  after the new runtime is verified. The npx lifecycle sends no such flag — a
  runtime-tree swap does not touch that store.
- **The window is re-probed, not taken on the launcher's word.** 3210, and 3080
  when the session records that the frontend was stopped, must both be free;
  the executor re-checks this every time it re-checks its lease, so a server that
  starts mid-transaction stops the write rather than racing it.
- **A cleanup that is undone anyway is reported, not reported as done.** The store
  is compared against the manifest's own removals after the runtime is verified;
  a writer that put them back produces FAILED with
  `HISTORY_STORE_CHANGED_AFTER_APPLY` and the number of returned rows, instead of
  DONE. FAILED is terminal, so the backend is not fenced and nothing needs
  recovering — there is nothing half-applied to recover.
- The launcher stops the frontend only when it can prove it is the managed one,
  using the same listener proof the start path already requires. A Crew-patched
  3080 it did not start is refused (it is on a Crew home either way), and a
  listener that is not Crew-patched — the legacy official frontend on its own
  home, or anything unrelated — is left running.

## 2.1.2 — 2026-09-15

- **A desktop launch returns as soon as Crew is supervised, instead of waiting
  for 3210.** `--open` opened the frontend on 3080 and then blocked on
  `Ensure-CrewSupervisorRunning`, which requires a live heartbeat *and* a ready
  3210 — so the operator's window was held for the whole first boot of the
  backend. On this machine that was the entire launch: 71.5s of a 71.5s cold
  start, 31.2s of a 32.3s cold start, 0.15s of a 3.9s warm start. The interactive
  entry now waits for a supervisor to exist (`Wait-CrewSupervisorStarted`, bounded
  at 30s, satisfied by the heartbeat the watcher publishes before it first touches
  the port) and reports where 3210 actually is. Nothing is skipped: the watcher
  performs the readiness wait either way, and 3080 is already serving when the
  decision is made. Blocking entries keep the readiness wait unchanged — the
  `--open` branch is the only caller of the new helper, and a test pins that.
- The two entries share one spawn path (`Start-CrewSupervisorProcess`), so the
  legacy-watcher refusal and the "already running" answer cannot drift apart.
- **A slow hub is no longer reported as a failed launch.** A first boot on a
  loaded machine took 78s here; the operator saw a deadline message for a system
  that was coming up correctly. The launch now says 3210 is still starting, and
  says so in one line without the log prefix.
- **A maintenance-fenced launch no longer reports an empty reason.** The fence
  branch clears `LastError` because it never consults health, so the startup wait
  printed `dsh-crew:3210 ()` — naming neither the cause nor the state. It now
  names the fence.
- The managed launcher skips its `pause` when `DSH_CREW_LAUNCHER_NO_PAUSE=1`,
  which a wrapper that reports the failure itself sets; without it the operator
  pressed a key twice for one failure.

## 2.1.1 — 2026-09-15

- **A cross-cohort update no longer commits a release it leaves marked
  incomplete.** The coordinated path writes the pointer itself and never goes
  through `beginReleaseActivation`, which is where the stage marker was cleared —
  so a cohort swap committed a payload still carrying `.dsh-crew-incomplete`.
  `validateInstalledPayload` rejects that, which is how `dsh-crew status` reported
  the running payload of the 2.1.0 swap as `unverifiable/damaged`: healthy and
  serving, read as broken, and permanently, since nothing else clears the file.
  The marker is now cleared on that path too, at the same point in the order —
  after the journal, before the commit — with a test that stages a candidate
  carrying the marker and asserts the committed release validates.

## 2.1.0 — 2026-09-15

- **Moves the pinned Harness cohort from `0.1.5-rc.2` to `0.1.6-alpha.1`.** The
  overlay composes unchanged: every `sdk-minimal` base row Crew overrides still
  exists, every package it inserts is still published at the new cohort, and the
  `agents.create` / `sessions.flush` / `webServer` surface the hub mounts on is
  unchanged. The cohort adds `mcp-resources` to the base profile and drops `e2b`
  and `code-runtime`, neither of which Crew names. The base-row contract test pins
  the new set, so a future cohort that renames a row Crew overrides fails there
  instead of at boot.
- Crew names nothing that 0.1.6 renamed or removed: the `agent/session-start`
  event, the PTC packages and the `workflow-ptc` executor, Ralph, the deprecated
  session history readers, `SandboxProvider.confine`, or `ShellExecutor.start`.
- Verified by booting `sdk-minimal` with Crew's `worker.cordis.yml` against the new
  cohort: exit 0 with empty stderr, where the same boot with an overlay naming an
  unknown row and package fails with `plugin tree failed to load`.

## 2.0.15 — 2026-09-15

- **The module scan understands regular-expression literals, so one can no longer
  desynchronise it.** 2.0.14 taught the snapshot check to follow local imports
  transitively, but read the source with a token scan that had no regex branch: the
  quote inside `/^['"]/` — and the ones in the TOML matchers further down the same
  file — opened a phantom string literal that swallowed text up to the next quote
  anywhere in the file. Two consequences, one of them shipped. It read this healthy
  machine as "needs repair", because the source between two quoted keywords came
  back as a specifier named `, ` and nothing resolves that. And it could hide a real
  import behind the phantom literal, so a snapshot that genuinely cannot load could
  read as ready — the more dangerous half, and the reason this is a scanner fix
  rather than a filter on the results. Tokens now come from a scanner that handles
  line and block comments, string and template literals, regex literals chosen by
  what the previous token can end, identifiers and punctuation; a shape check then
  drops anything that is not a path or a package name, so a scan artefact can never
  be resolved as a dependency. On this machine the entry's transitive walk reads
  21 files in ~180ms and the integration is ready.

## 2.0.14 — 2026-09-15

- **The snapshot check follows local imports, rather than only the entry's first
  line of them.** `src/server.mjs` is the MCP server Claude Code launches, and a
  copy interrupted anywhere in the module graph it reaches — not only in the files
  it names directly — leaves a snapshot that cannot start while every compared file
  is present. The check now walks relative imports transitively, through
  re-exports, and terminates on cycles. Specifiers are read from a token stream
  that consumes comments and string literals whole, so the word `import` inside
  either is not mistaken for a declaration; builtins are recognised by `isBuiltin`
  rather than by an assumed `node:` prefix; a CommonJS `require` is followed as
  well; and nothing is executed to find out — the fixture that proves this throws
  if it ever is. The bounds are unchanged in kind: 512 entries and 8 MiB, of which
  the shipping plugin uses about a fifth. The real machine reads ready in ~140ms
  warm, and the walk is still rooted inside the snapshot and refuses symlinks.

## 2.0.13 — 2026-09-15

Seven findings from a review of 2.0.12's install path. Two are P1 and were
introduced by 2.0.11's managed-child change; the rest pre-date it.

- **A step's output is drained.** Both streams were piped and only stderr was
  read, so a step printing more than a pipe buffer (64 KiB) blocked on its own
  write and was killed at the ceiling for being talkative rather than for being
  stuck. Both are read now, keeping a bounded tail for the report.
- **A termination that does not land still ends the step.** The step resolved only
  from the child's close event, so a `taskkill` that failed — or hung — left it
  pending forever with the failure ignored. The kill is bounded as well, and the
  result reports `terminated: false` rather than waiting on a close that is not
  coming.
- **The "already current" fast path asks what the status surface asks.** It checked
  the files but not whether the snapshot can load, so one tree got two answers:
  `ok: true` / "already current" from the installer and "not ready" from
  `dsh-crew status`.
- **The dependency check asks the entry, not the manifest.** `src/server.mjs`
  imports `@modelcontextprotocol/sdk/server/mcp.js`, `.../stdio.js` and `zod`, and
  those are what must resolve, from the entry. Requiring the *declared* list to
  resolve was wrong twice over: it names 28 dependencies including meta-packages
  the server never imports from here, and two of them resolve by no means at all
  while the integration demonstrably works — so the rule read this healthy machine
  as needing repair. Resolution now goes through the entry's own `require`, which
  keeps subpath specifiers intact: the bare package name does not resolve through
  its `exports`, the subpaths do.
- **The `claude` executable is the one the machine has.** `where claude` reports
  the extensionless shim, `claude.cmd` and `claude.exe`; execution hardcoded
  `.cmd`, so a host with only the native binary was detected and then could not be
  run. A native executable is preferred and started directly, with no command
  processor to quote for.
- **A failed marketplace registration no longer uninstalls the plugin.** The
  uninstall exists so the install re-copies rather than no-oping; doing it after
  the step that says where the plugin comes from has failed leaves the machine with
  neither, and that is the shape a refused path produces — where nothing was even
  attempted. `marketplace add` exits 0 when the marketplace is already registered
  (measured on this machine), so a failure there is a real one.
- **Directory enumeration is bounded while it runs**, not after: `readdirSync`
  materialised the whole listing before any limit applied. The earlier test for
  this built trees with no plugin manifest, so the walk returned at its first
  `add` and the bounds were never exercised — it asserted the right answer for the
  wrong reason.

## 2.0.12 — 2026-09-14

- **The copying step gets a ceiling that fits the copy.** 2.0.11 gives each
  `claude` step a managed child killed with its tree on timeout, which is what
  stops a timed-out `uninstall` from deleting the plugin the next step registered.
  It also removed the accident that had been hiding a mis-sized ceiling: an
  orphaned `install` used to finish its copy minutes after its shell gave up, so
  300s *looked* adequate while every refresh was in fact outliving it. With the
  tree killed instead, 300s is a genuinely broken integration, and the first
  activation under the new code produced exactly that — reported honestly, with no
  process left behind. The copy measures 163s idle, ~360s under an activation and
  407s on the run that produced this change, so `install` — the step that copies —
  now has 900s, while `marketplace add` and `uninstall` measure ~3s and keep the
  short one.

## 2.0.11 — 2026-09-14

Seven findings from a review of 2.0.10's install, snapshot verification and
supervisor recovery paths. Several pre-date that release; the Hub being AVAILABLE
does not mean these branches had fired.

- **A timed-out step can no longer act after the next one.** `uninstall` and
  `install` ran through `execSync`, whose timeout kills the shell but not the
  `claude` process beneath it — on Windows that grandchild is outside the shell's
  process tree. An `uninstall` left running finished *after* the install that
  followed and deleted the plugin the install had just registered. Each step now
  runs as a managed child that is killed **with its whole tree** on timeout, and
  the step does not report finished until nothing of it can still be running.
  Waiting longer does not fix this; the process has to be accounted for.
- **A corrupt settings file is reported, not overwritten.** `readJson(file, {})`
  treated "unparseable" as "no settings yet" and rebuilt an empty configuration,
  taking the operator's settings with it. A present-but-unreadable file now fails
  the integration with `CLAUDE_SETTINGS_UNREADABLE` and is left exactly as it was.
- **A snapshot whose runtime dependencies do not resolve is not ready.** The
  comparison covered source and configuration but not `node_modules`, and
  `src/server.mjs` — the MCP server Claude Code launches — imports its runtime
  dependencies by bare specifier. A copy interrupted between `src/` and
  `node_modules/` therefore read as ready while the server could not start. The
  dependencies the snapshot's own `package.json` declares must now resolve from
  the snapshot itself.
- **An earlier step's timeout survives a later step's ordinary failure.** The
  timeout evidence was a single variable overwritten by whichever step failed
  last, so a timed-out `marketplace add` followed by a plain install failure
  settled for zero. The widest window any step asks for is kept.
- **The CLI is invoked with an argument array, never a shell string.**
  `JSON.stringify` quotes for JSON, not for a command processor: a path containing
  `%NAME%` arrived expanded, so the install reported success and acted on a
  different directory. Windows still reaches the CLI through a command processor —
  a `.cmd` shim cannot be executed directly — so an argument the processor would
  act on is refused rather than escaped.
- **The snapshot walk is bounded before it reads**, and by more than bytes: a file
  is size-checked before being loaded rather than after, and directory count and
  recursion depth are bounded too.
- **A Hub outliving its watcher can be recovered.** The supervisor wrote nothing
  to disk about the process it owned, so when a watcher exited while the Hub kept
  serving, a later watcher could never take over — it retried forever, or the
  interactive launch gave up after 90s, and the orphan had to be stopped by hand.
  What is not recoverable is adopting on port health, which would put a process
  Crew does not own within reach of `Stop-OwnedListener`. The identity is now
  persisted when it is established and re-proven field by field — PID, start time,
  port ownership, profile, Crew home and the live `runtime_id` — before a later
  watcher adopts it. Anything that does not match is refused, and the record is
  cleared when ownership is dropped.

## 2.0.10 — 2026-09-14

Findings from an independent review of the 2.0.6–2.0.9 Claude Code integration
work. The 2.0.9 change itself was judged sound; these are defects in the code it
relies on.

- **A project-scope record no longer stands in for the user-scope install.** The
  installer writes user scope, so that is the scope whose record means the
  integration is installed — but the snapshot check accepted any scope, so a
  project-scope record that happened to match made a missing user-scope snapshot
  read as present and let the installer skip the CLI step it still needed. The
  installer and `dsh-crew status` now require the scope they write.
- **The snapshot comparison covers what the plugin loads, not just what names
  it.** It compared `.claude-plugin/plugin.json`, `package.json`, `agents/`,
  `commands/` and `src/`; `worker.cordis.yml` is required before any dispatch
  (`src/jobs.mjs` throws without it) and the statusline scripts are named by the
  settings this installer writes, so a snapshot missing either read as current.
  `skills/`, `statusline/` and `worker.cordis.yml` are compared too.
- **An unwritable settings path fails the integration instead of throwing out of
  it.** Both install entries branch on `ok === false` and neither could ever see
  it, because the settings write threw past both of them — a failure branch with
  no producer.
- **The settle wait is gated on `ETIMEDOUT` alone.** `ENOBUFS` reports `SIGTERM`
  as well, so matching the signal spent the window on a child that had stopped.
- **A timed-out `marketplace add` or `uninstall` now reaches that gate.** Both are
  caught so the install can follow, and that catch was hiding a timeout too.
- **A host without `claude` is described as such.** The managed entry probed
  nothing, so it printed a repair command naming a CLI that is not installed; it
  now reports the CLI as not detected, which is what the checkout entry already did.

## 2.0.9 — 2026-09-14

- **The post-attempt wait is limited to the case that can still be writing.** 2.0.8
  waited 180s for the plugin snapshot whenever the CLI attempt had not left it
  current — including when `claude` is not installed at all, where no process was
  ever started and there is nothing to wait for. The managed `dsh-crew update` path
  runs the integration unconditionally, so a machine without Claude Code paid a
  fixed three minutes on every update. The wait now applies only to a timed-out or
  signalled attempt, which is the one that can leave a copy running past the
  shell's ceiling; a missing CLI exits with status 1 and a failing CLI with its own
  non-zero status, and both are now reported immediately. Measured on the reported
  branch — stale snapshot and no `claude` on PATH — the same call went from 184.6s
  to 0.6s while still reporting the integration as not loaded.

## 2.0.8 — 2026-09-14

- **The Claude Code refresh is watched to completion, not just timed.** 2.0.7
  raised the shell ceiling to 300s from a measurement that the post-uninstall
  copy took 163s. That measurement was taken on an idle machine; during an
  activation the same copy took about six minutes, so the update still reported
  the integration as not loaded — while the timed-out `claude` process, which on
  Windows is not in the shell's process tree and so is not reached by the kill,
  went on writing and finished the job minutes later. The step now polls the
  snapshot it is actually judged by, for up to 180s past the ceiling, so a copy
  that is still landing is reported as landing. A refresh that genuinely fails
  still reports degraded, one settle window later.

## 2.0.7 — 2026-09-14

- **The Claude Code refresh is given time to finish.** The step runs
  `claude plugin uninstall` first, so that the snapshot is re-copied rather than
  left stale — but the copy that follows is not the ~6s no-op an already-installed
  plugin gets. Measured on the machine that hit this: `marketplace add` 3s,
  `uninstall` 3s, `install` 163s, against a 120s ceiling. Every version update
  therefore killed the install partway *after* removing the plugin, and left
  Claude Code uninstalled; since 2.0.5 that is reported rather than checkmarked,
  but it should not happen at all. The ceiling is now 300s, which the measured
  copy fits in with room to spare.

## 2.0.6 — 2026-09-14

- **The checkout install entry reports an unloaded integration too.** 2.0.5 taught
  `installClaudeCode` to say when it had left Claude Code without the plugin, and
  the managed `dsh-crew update` path to print it — but `scripts/setup.mjs` has its
  own Claude step that only tested `ok`, so `node scripts/setup.mjs install` kept
  printing `✓ Claude Code integration` for the same degraded result. Both entries
  now render through one function, `claudeIntegrationLine`, so a result one of
  them handles cannot be checkmarked by the other. The checkout step is extracted
  as `runClaudeIntegrationStep`, which also makes it testable without running a
  real dependency install and client build.

## 2.0.5 — 2026-09-14

- **A host integration that did not load is no longer reported as a checkmark.**
  `installClaudeCode` keeps `ok: true` on purpose — a machine without the `claude`
  CLI is a supported install, and its settings are written either way — but the
  caller branched on `ok` alone, so the `✗ Claude Code integration failed` line
  could never print. On this machine `claude plugin install` hit the installer's
  120-second ceiling *after* the step had already removed the previous
  registration: Claude Code was left with the plugin uninstalled, the update
  printed `✓ Claude Code integration`, and `dsh-crew status` read "needs repair"
  afterwards. The install now verifies the snapshot Claude Code will actually
  load, and reports the resulting state — `- Claude Code integration registered,
  but not loaded: …` — naming the command that fixes it. The update still
  succeeds; it just stops claiming something it never checked.

## 2.0.4 — 2026-09-14

- **A reviewer's read-only-ness is verified in every isolation mode.** The role's
  whole contract is that it changed nothing, and that was the one claim the
  acceptance gate stopped checking outside a worktree: `runReviewerAttempt`
  skipped both fingerprint captures whenever the job was not isolated, so in a
  shared workspace no before- or after-image existed, no mutation could be
  detected, and a reviewer that edited the tree it was reviewing was accepted as
  `approve`. Reviewer evidence is no longer exempted by isolation — a shared
  workspace is fingerprinted around the attempt, and a reviewer whose workspace
  moved is refused with `REVIEW_CHANGES_REQUESTED` exactly as it would be in a
  worktree. This is detection, not prevention: the default `readonly` profile
  still keeps a reviewer out of the primary tree, so an explicit shared override
  can no longer pass unnoticed, but it can still write.
- **A shared workspace no longer reports a retention that never happened.**
  `workspace_retained` was set whenever evidence capture failed, but a shared
  workspace is the caller's own and was never Crew's to keep. The allocator
  comment now says what the code does: `readonly` profiles take the disposable
  worktree, and an explicitly shared workspace is fingerprinted rather than
  exempted.

## 2.0.3 — 2026-09-14

- **An authorised zero-change task can be verified outside a Git repository.**
  `constraints.allow_no_changes: true` covers work that is meant to leave no net
  change — read-only inspection, or a bounded smoke that creates a temporary file
  and removes it again. The Hub could only prove that from a clean Git baseline,
  so the same task a repository certifies came back `partial` with
  `workspace_evidence_ok: null` when it ran in a plain directory. A non-Git
  workspace whose initial tree holds only directories can now be baselined by
  walking it — paths and entry kinds, never file contents — and the after-run
  walk is compared against it. A tree that already contains files, links or
  special entries stays unverifiable and fails closed, and a reviewer's approval
  is invalidated when such a workspace changes under it.
- **A Git failure is no longer reported as "not a Git repository."** Every runner
  error became `NOT_A_GIT_REPOSITORY`, which named the wrong cause — and it was
  the single condition the new directory fallback keys on. A non-zero `git` exit
  now surfaces as `GIT_ERROR`, and the fallback applies only when every baseline
  read agreed the directory is not a repository.

## 2.0.2 — 2026-09-14

- **One test no longer skips on Windows.** `reopening rejects a symlinked
  manifest before reading it` needs a *file* symlink, which Windows grants only
  with `SeCreateSymbolicLinkPrivilege`; without it the test skipped, and the
  property it guards — the provider-delete guard refuses a manifest reached
  through a link — went uncovered on the host that needs it most. The guard does
  not care which kind of link it is: it walks every path segment and refuses when
  any of them is a reparse point, and a directory junction is a reparse point
  Windows grants without privilege. The same property is now asserted through a
  junction, so it runs here; the file-symlink test still runs where file
  symlinks are permitted.

## 2.0.1 — 2026-09-14

Found by trying to make the readiness matrix green on a machine where the work
had actually been done.

- **Three target rows had no producer at all.** `cancellation_timeout_escalation`
  and `deepseek_flash` / `deepseek_pro` were listed in the matrix and nothing
  could ever fill them, so they read `NOT_RUN` no matter what the machine did —
  a row that cannot pass is not a conservative row, it is a dead one. They now
  read the job records: a run that was cancelled or that timed out is exactly the
  evidence the cancellation row asks for, and a DeepSeek execution is what the
  two provider rows ask for. An unverified run still counts for nothing.
- **The Hub carried its own copy of the verdict rule.** The copies had drifted —
  the shared one learned to see through `**Approved**`, the Hub's did not — so
  the Hub recorded `inconclusive` for a review the workflow had accepted, which
  kept `reviewer_primary_callable` and `reviewer_pipeline` from ever seeing a
  real review. A guard test keeps the rule in one place now.

## 2.0.0 — 2026-09-14

A milestone, not a rewrite: no MCP tool, HTTP route, CLI command or config key
was removed, and journals written by 1.10.x are still read. What changed is that
the two rules a delegated job is judged by — what it delivered, and how far the
runtime transaction got — are now each defined once, as an explicit state
machine, and are verified through both dispatch paths instead of one.

**The delivery contract**

- An explicitly authorized zero-change task succeeds. Four separate causes were
  fixed across 1.10.5–1.10.8, each found by running the previous release on a
  real task rather than by a unit test: two `## Tests` parsers that disagreed
  about whether the same section was evidence; an authorization the Hub granted
  only in an isolated worktree; a report that declared the workspace unchanged
  and then described the work it undid being read as a claim that the work
  remained; and a client that re-judged the Hub's verdict with no evidence of
  its own. The authorization stays load-bearing — the identical task and
  evidence without it still fails.
- A reviewer's verdict is read the way reviewers write it. `**Approved** —`,
  `- Approved` and `Verdict: approved` all read as `inconclusive`, which blocks
  acceptance, so enabling the automatic reviewer could reject correct work
  because the reviewer bolded its answer. The rule now lives in one place; the
  Hub used to carry a second copy that had already drifted from it.

**The runtime transaction**

- `before-stop / stopped / restarted / verified / committed`, one legal forward
  edge at a time, with `restarted` written before the start on purpose so an
  interrupted update is never mistaken for one that never started.
- Update and handoff locks identify their owner by process start time as well as
  PID, so a recycled PID can no longer keep a dead lock alive.

**Dispatch**

- A dispatched job is named `Crew_<date>_<time>_<purpose>` everywhere an
  operator sees it, and isolation belongs to whoever allocates the workspace —
  the client no longer leaves the Hub to resolve one and allocate a second.

**Reliability**

- Every runtime-tree move retries the transient Windows refusal it can hit
  immediately after a process releases the tree, and reports a permanent failure
  rather than a timing artifact.

Verified on the release machine: the success path and the guards (reply-only,
failing tests, missing authorization), the automatic reviewer end to end,
escalation to a second attempt, a timeout, cancellation, worktree and shared
isolation, the no-commits error, provider probing, the readiness matrix, job
naming, and both dispatch surfaces — through ZCode's MCP session and through a
Codex session that called the same tools.

## 1.10.9 — 2026-09-14

Found by turning on the two features the operator's configuration has off —
the automatic reviewer and attempt escalation — and running real work through
them. Both were verified live, and one of them was broken.

- **A reviewer's verdict is read the way reviewers write it.** The verdict line
  is prose, and reviewers decorate prose: `**Approved** — correct.`, `- Approved`
  and `Verdict: approved` all read as `inconclusive`, which *blocks* acceptance.
  An operator who enabled the automatic reviewer could therefore have correct
  work rejected because the reviewer bolded its answer. Recognized verdicts now
  survive emphasis, list bullets, quotes, heading marks and a `Verdict:` label,
  and anything not stated — including a negated verdict — is still inconclusive.
- **A transient Windows refusal during frontend asset install no longer fails the
  install.** It is the same refusal the runtime-tree moves already retry, in the
  third place it could bite: a rename refused for a moment because something else
  holds a handle under the destination. The snapshot rename keeps its tolerance
  for a concurrent installer that got there first.

Verified live while making this release: the automatic reviewer runs and
approves a verified worker (it failed before this fix), escalation runs a second
attempt with `escalation_reason: tests_failed` and a `model.fallback` event, and
a short `timeout_seconds` ends the attempt with `ATTEMPT_TIMEOUT` before the
escalated attempt runs and the workflow stops at `max_attempts_reached`.

## 1.10.8 — 2026-09-13

The 1.10.7 verification found two more reasons the same task could still fail
through the MCP client.

- **The declaration is recognized where a Worker actually writes it.** A report
  that ends its Diff section with `**Final state: no files changed.**` after
  describing the work it undid states the same thing as a bare `no changes`, and
  was read as a change claim. Sentence and clause boundaries are now tested, so
  the summary is found — while a no-change phrase inside an unrelated clause
  ("`src/app.mjs` was edited; no other files were touched") is still a change
  claim.
- **The MCP client's attempt runs where the client said.** Isolation belongs to
  the client, which allocates the workspace and passes its path as the cwd. The
  attempt dispatch said nothing about isolation, so the Hub resolved one from the
  role profile and allocated a second workspace — putting the work in a directory
  the client was not looking at and could not capture a candidate for. The
  dispatch now states that the workspace is already provided, and carries the
  same `allow_no_changes` authorization the client was given so both layers judge
  the evidence against the same contract.

## 1.10.7 — 2026-09-13

The zero-change fix of 1.10.6 was verified again through both dispatch surfaces
and only one of them was fixed.

- **An authorized zero-change task succeeds through the MCP client too, not only
  through `jobs submit`.** The Hub judges the workspace evidence where the
  evidence is — it can see the primary workspace — and a client only has evidence
  of its own when it captured a candidate, which it can only do in a worktree it
  owns. The client re-ran the same gate on the Hub's verdict with nothing to
  judge it against, which graded the identical report `partial` after the Hub had
  approved it. Where the client has no evidence, the verdict the Hub reached on
  evidence stands; where the client does have its own candidate, it still
  decides.

## 1.10.6 — 2026-09-13

Found by installing 1.10.5 and using it for real, one feature at a time. Each
defect was reproduced on the machine before it was fixed.

- **A correct install no longer reports "needs repair".** `status` judged the
  host integrations against the release directory while the installer writes the
  profile's loader link, so all three read as broken the instant the installer
  said they were installed. Readiness looks through the same link.
- **The authorized zero-change task succeeds.** The delivery gate compares the
  worker's report against git, and a report that declares the workspace unchanged
  and then describes the work it undid was read as a claim that the work was
  still there — which is why a task that created, verified and deleted a file
  failed with `WORKSPACE_MISMATCH` while every check passed. The declaration is
  now read as the net claim it is. This can only turn a mismatch into a match
  when git already proves the workspace is clean; a report that declares no
  changes while git reports real ones still fails.
- **The first job snapshot no longer claims an isolation the job does not run
  in.** The record is created before the workspace is allocated and defaulted to
  `shared`, so a caller was told the work would land in their own tree while it
  was about to land in a worktree.
- **A plain `jobs submit` payload honours the role profile's isolation.** Only
  the advanced Job Request shape resolved it, so the same task ran shared through
  the simpler shape while the profile said `worktree`.
- **A transient Windows rename refusal no longer fails an upgrade, a rollback or
  a recovery.** Every runtime-tree move happens immediately after the process
  using it stopped, where `EPERM` is a timing artifact that passes on the next
  attempt. All of them now retry briefly; a permanent failure is still reported.
- **Codex no longer logs "Ignoring malformed agent role definition" about a Crew
  file.** Role stubs written before the roles were renamed to `ds-worker` and
  `ds-reviewer` were never cleaned up. Install and uninstall now remove them, and
  only when the file cannot be a real role — an operator's own role is untouched.

## 1.10.5 — 2026-09-13

Three reports from real use, each traced to its root cause before it was fixed.

- **A task that delivers zero changes can succeed.** A task that is explicitly
  authorized to change nothing — `constraints.allow_no_changes: true`, which is
  what "create something, verify it, delete it" is — was reported as blocked with
  `DELIVERY_INCOMPLETE` no matter what the evidence said, because the delivery
  gate required a non-empty diff and the Hub only granted the authorization in an
  isolated worktree. A shared workspace is an ordinary way to run, so that is
  where the case was reported from. Both are fixed: `allow_no_changes` now
  applies to a shared workspace against a clean, readable baseline, and the
  report is accepted when the tests pass and the workspace is verifiably
  unchanged. Nothing else moved — a missing evidence section, a failing test or a
  failed cleanup still fails.
- **The evidence sections are parsed once.** `delivery.mjs` and `workflow.mjs`
  each carried their own `## Tests` parser, and the stricter one — the one that
  decides `delivery.complete`, and therefore the failure code — rejected the
  entire section for a single line it did not recognize, while the looser one had
  already reported the same test rows as visible PASSes. That disagreement is why
  the same run could show passing evidence and `tests_status: null` at once. One
  parser now feeds both, so the aggregate status and the visible rows can no
  longer contradict each other.
- **A dispatched job is named the same thing everywhere.** The worktree, the
  Harness session and the status payload now all carry
  `Crew_<date>_<time>_<purpose>`; the Harness titles a session from the prompt it
  receives, and that prompt is built from the worktree's own name.
- **Locks identify their owner, not just its PID.** Update and handoff locks
  recorded a PID and asked the operating system whether that PID existed. A
  recycled PID — the system handing a dead owner's number to an unrelated
  process — therefore looked like a live owner, and the lock could not be
  reclaimed for as long as the stranger ran. Lock records now also carry the
  owner's process start time.
- **The update transaction is a state machine.** The coordinated update records
  `before-stop`, `stopped`, `restarted`, `verified` and `committed` in order, one
  legal forward edge at a time, so an interrupted update always leaves a journal
  that describes a transaction that actually followed that order. Recovery's one
  fatal question — may a start already have happened? — is answered from these
  states alone.

## 1.10.4 — 2026-09-13

Found by installing 1.10.3 from the registry into a throwaway project and asking
it to do something real.

- **A repository with no commits is reported as exactly that.** `git init`
  followed by asking Crew for something is how a new project starts, and it failed
  with a bare `GIT_ERROR` and a message about isolation — nothing an operator
  could act on, for a repository that is perfectly valid. It now reports
  `REPOSITORY_HAS_NO_COMMITS` and names the two ways forward: make an initial
  commit, or run with `execution.isolation: shared`. A repository with one commit
  behaves exactly as before.

## 1.10.3 — 2026-09-13

A review of the install and lifecycle layer — the largest area never previously
reviewed — plus eight rounds of adversarial verification. Every finding was
reproduced before it was fixed, and several fixes were themselves found to be
wrong by the next round and redone.

Host integrations point at the loader link, not at a release:

- The Codex, ZCode and Claude Code integrations recorded the absolute path of the
  release they were installed from. That path went stale the moment the release
  was pruned, and it was why removing an old release was unsafe. They now record
  the Crew profile's loader link, which registration re-points at whichever
  release is live: an upgrade needs no rewrite of your host configuration, and
  removing a release cannot leave a dangling reference. Existing installs carry
  absolute paths from earlier versions; the next upgrade rewrites them.

Crash recovery:

- **A runtime tree is no longer replaced while a process may be running from it.**
  Recovery decides by reading a state the update writes before it starts anything,
  and a stop that cannot be positively proven leaves the tree alone rather than
  guessing. An earlier version of this fix read "the supervisor could not obtain
  the runtime's identity" as "nothing is running" — which is equally what a live
  runtime with a timed-out request looks like — and would have swapped the tree
  out from under it.
- The maintenance window a coordinated update opens is recorded and resumed, so a
  crash after it stops the runtime no longer strands it stopped. The durable
  supervisor session is the authority, not the journal, because it exists from the
  moment the stop lands.
- A journal marked verified whose release pointer never moved is completed rather
  than rolled back: the candidate is what is running, and rolling back would swap
  the tree out from under it.
- Runtime cohort retention rotates rather than consumes, so rolling back and then
  forward again works instead of failing with the cohort it needed already gone.

Payload identity:

- The payload digest includes permission bits. A payload whose file mode changed
  with identical bytes compared equal, so the repair that was the point of the
  update was skipped.

Known, deliberately not changed:

- A first install that does not complete leaves everything in place and reports,
  because Crew cannot prove which host records are its own. Finishing it is a
  manual step, and the error names the candidate, the loader link and the journal.
- The update and supervisor-handoff locks decide a live owner from the process id
  alone, so a recycled pid can leave a stale lock looking live. The remedy is to
  delete the lock file.

## 1.10.2 — 2026-09-13

A first adversarial review of the install and lifecycle layer — the largest area
never previously reviewed — found a data-destruction defect that 1.10.1 shipped,
along with four other issues. This release fixes the defect and three of the
others. **Two lifecycle issues are known and still open**, listed at the end
rather than omitted.

Upgrade and recovery:

- **Recovery could recursively delete any absolute path.** The update journal and
  the current-release pointer were validated only as *absolute* paths, and
  recovery then deletes the journal's candidate directory. A corrupt or tampered
  journal naming any directory — including the official `~/.dsh` tree this plugin
  must never touch — would have deleted it and reported the recovery as
  successful. Journal candidate and prior paths, and the pointer's release path,
  are now required to resolve inside the Crew-owned releases directory, recovery
  acts on the path that was checked rather than the string that was written, and a
  path that fails is treated exactly like a malformed journal: nothing is touched
  and the state is retained for inspection.
- **A rollback could ask the supervisor to start a tree it had not restored.**
  The removal error was swallowed, the restore was attempted over whatever
  remained, and the runtime was started regardless — so on Windows, where live
  handles are precisely what blocks a removal, the tree that had just failed
  verification could be started again. A failed removal now stops the recovery,
  and the restart is skipped unless the previous runtime is positively in place.
- **Rolling back consumed the cohort it displaced, so rolling back twice did not
  work.** After B→A the B runtime tree existed nowhere, and a later A→B failed
  with `RETAINED_MISSING`; a failed B→A could not compensate offline at all. The
  displaced cohort is now parked and retained under its own version, so retention
  rotates the way the forward path already did. An unreadable parked cohort is
  kept rather than deleted — it is the only copy of that cohort — and one parked
  by a failed retain is still found, so the failure costs a rename rather than the
  cohort.

Payload identity:

- The payload digest ignored permission bits, so a payload whose file mode
  changed from `0644` to `0755` with identical bytes compared equal and the
  repair that was the point of the update was skipped. The installer copies each
  file with the captured mode, so the mode is part of the payload and is now part
  of the digest.

Known and still open in this release:

- A crash between stopping 3210 and parking its runtime tree is not recoverable:
  the coordinated update journal does not record the maintenance lease and
  runtime id needed to resume that window, so recovery can leave the runtime
  stopped and a later ordinary stop is refused by the surviving session.
- Crash recovery repairs only the Crew profile registration, not the Codex,
  ZCode, Windows-startup and Claude Code integrations, so a crash before the
  release pointer commits can leave those pointing at a candidate directory that
  recovery then removes.

Both are failure-path issues in the upgrade transaction. Neither is reachable
without an interrupted upgrade. They are recorded here because a release note
that omits them would be describing a different release.

## 1.10.1 — 2026-09-13

Nine rounds of adversarial review (Oracle, GPT-5.6 Sol) over the worktree and
release-retention code from 1.10.0. Every finding was reproduced before it was
fixed, and the release ships with the reviewer's explicit ship decision and no
outstanding findings.

Worktree cleanup:

- **Background pruning no longer deletes.** `pruneWorktrees` reports by default
  and removes only when a caller passes `remove: true`. Three separate
  measurements said a "clean" worktree is not proof that removing it is safe:
  git removes a worktree whose only remaining content is *ignored* (build output,
  logs, local config); it removes one whose tracked file carries
  `assume-unchanged` or `skip-worktree`, which hides the modification from
  `status` and from every other query; and between validating a worktree and
  deleting it, the worktree can change. Nothing in Crew called this path, so the
  automatic capability bought nothing while risking the one thing Crew must not
  lose. Cleanup for a worktree whose job directly owns it is unchanged.
- **A worktree is removed only when ownership can be shown.** Crew records what
  it creates under `<worktree root>/.crew-owned/`, bound to the worktree's git
  administrative directory and to the revision Crew left it at. A name is not
  proof — `dsh-crew-backup-deadbeef` is a name a user could plausibly pick — so a
  worktree with no valid record is reported for a human to look at rather than
  deleted. A recorded worktree an operator has since committed in, or checked
  something else out in, is reported as taken over and left alone. Worktrees
  created by earlier releases have no record and are therefore reported, not
  removed; delete those by hand if they are finished with.
- Failed creation verifies deregistration instead of assuming it, and never
  deletes a directory git still tracks. Paths are compared through the
  filesystem, so a Windows temp directory spelled with an 8.3 alias is the same
  worktree as its long form rather than a stranger's.

Release retention:

- **A claim belongs to the mount that wrote it.** Claims were named by process
  id, so two mounts in one process published to the same pathname and whichever
  disposed first removed the other's protection — leaving a release a live mount
  was still executing open to pruning. Claims are now per mount, the Hub clears
  exactly the claim it holds, and a missing handle is not permission to remove
  anything.
- The Hub releases its claim when it is disposed, including when mounting fails,
  so a restart no longer leaves a claim behind.
- Liveness that cannot be determined suppresses pruning rather than being read as
  "nothing is running". This is deliberate: a release that keeps its files costs
  disk; a release deleted under a running Hub costs the Hub.
- Claims are written to a temporary name and renamed, so a reader never sees one
  mid-write, and a reader never unlinks one — checking liveness and then
  unlinking by pathname is a race that can delete a live process's protection.

The test suite no longer writes to the operator's real Crew state. Six files
reach the Hub's dispatch path, which appends session provenance to
`~/.config/dsh-crew/`; a full run added 30 entries to it and, because the history
service hashes that ledger into its plan revision, also caused an intermittent
`HISTORY_PREVIEW_CHANGED` failure under parallel load. Measured after the fix: a
full run adds none.

Publishing verifies the tarball against the tracked tree before release and pins
its toolchain exactly.

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
