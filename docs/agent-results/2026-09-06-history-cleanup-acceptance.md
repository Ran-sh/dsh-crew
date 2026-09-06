# History cleanup and global MCP repair acceptance

The 3210 Settings → DSH Crew panel now includes workspace/session cleanup:
archive (default), delete, all/created-before selection, preview and confirmation,
archive restore, progress/reconnect and explicit maintenance recovery.

Only Crew-owned workspace registrations and session log artifacts are changed.
Project source files, attachments, model configuration and official 3080 data
are outside scope. Existing user history was NOT archived or deleted during
verification. Native runtime maintenance requires no live or pending agents.

## Verification

- Browser → HTTP handler → controller → offline executor → actual temporary
  files passed archive-all, restore, delete-before-date, confirmation guards and
  reconnect. The supervisor process boundary was simulated in this test; it was
  not a destructive cleanup test on the user's production profile.
- A 102-test regression batch passed before the optional-SDK follow-up; an
  81-test related batch passed with that follow-up. These batches overlap.
- Real Cordis service proxy test verifies admission ownership and both create
  and resume interception. Plain mock objects alone had missed this issue.
- Live official Harness prefix routing was checked; a trailing-slash bug was
  reproduced by normal-path 404 / double-slash 200 and fixed with a regression.
- Real installed 3210 UI was opened in isolated headless Chrome. Preview showed
  123 workspaces / 195 sessions at that observation; counts change with activity.
  Default action was archive, execute was disabled without consent, and there
  were zero uncaught page errors. No execution confirmation was submitted.
- Admission and operation reviews were approved by
  `wf-mtoj14vb-9b5jw8` and `wf-mtojs01j-sx63or`; earlier change requests were
  addressed or withdrawn with test evidence.
- Official 3080 PID 6604 stayed running while the Crew updater reloaded 3210.
- Crew config.json and Harness settings.yaml SHA-256 values remained unchanged.

## Global MCP startup repair

The npm package deliberately keeps host peers optional. `jobs.mjs` previously
imported the standalone SDK eagerly, causing global Hub-only MCP startup to
fail when optional peers were omitted. Commit `378ae17` defers SDK loading until
an actual standalone run, preserves the synchronous startJob contract, and
prevents cancellation-during-import from constructing a late worker.

This does not pretend the optional standalone SDK is installed globally. The
configured 3210 Hub path does not need that SDK; standalone use still requires
the matching official SDK in its installation and gets an explicit bounded
error when unavailable.

- Global npm MCP path completed initialize, listed all six tools, and read the
  compatible live Crew configuration.
- Real reviewer `wf-mtokwvoy-2ontxw` launched through the repaired GLOBAL npm MCP
  entry, used the operator's configured `muse-spark-1.3-contributor` via 3210,
  completed with PASS/approve, complete delivery and released its worktree.
- The lazy-loader tests passed: optional SDK absent, delayed load/close,
  cancellation before/during load, actionable missing-module errors, and
  preservation of unrelated errors. New helper coverage: 100% lines/branches,
  80% functions (default real import is intentionally not executed in unit tests).
- CI for the production fix passed at
  https://github.com/Ran-sh/dsh-crew/actions/runs/33977029322 .

## Installed state and use

Global CLI and managed payload remain `1.2.0-rc.4`; no npm publication or main
merge was performed. They were updated from the local candidate, and first-party
content digests match the checkout. Managed release:
`20260905T161318Z-21104-1-1.2.0-rc.4`.

Refresh an existing 3210 tab, open Settings → DSH Crew → workspace/session
cleanup. Preview the scope, review counts, and explicitly confirm. Delete also
requires typing `DELETE`. If maintenance is interrupted, use the recovery UI;
when 3210 is unavailable, run `dsh-crew history recover`. Do not manually remove
maintenance markers or edit archive manifests.

Compatibility is deliberately restricted to the audited official
`0.1.2-rc.1` default JSON workspace / JSONL session layout. Unsupported or
ambiguous log encodings fail closed; conflicting restores never overwrite data.
