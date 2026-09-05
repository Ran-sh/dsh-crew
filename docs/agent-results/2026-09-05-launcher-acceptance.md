# Launcher acceptance — 2026-09-05

Final implementation: `bda8fe40109f4daf690122bf7eea0a70a3ab4124`.

Daily startup no longer waits for the optional legacy 3080 bridge probe.
When waiting for the supervised 3210 service, it logs progress every five
seconds. Existing extension health, cohort, ownership and timeout checks remain.

Measured on this machine with 3210 already running:

- Before: 3996 ms total, 2.6 s reported by the script.
- After, preserved health protocol: 1764 ms total.
- Installed desktop entry `启动 DSH Crew.cmd`: exit 0, 1788 ms total,
  browser open requested for 3210, 0.6 s reported by the script.
- Repeated launch retained supervisor PID 18036.

The Crew-owned startup installer updated the managed helper, hash manifest and
login startup entry. Exact supervisor handoff returned VERIFIED and live runtime
ID `11ecb312-9b86-438c-b5c1-b94829830fe5`. Installed helper matches repository
content by SHA-256. Crew payload version remains 1.2.0-rc.4; these are launcher
asset changes, not an npm release. No official web profile changes were made.

Validation: 29 ownership/distribution/maintenance tests and 30 startup/control/
adapter tests passed. After reducing the endpoint-change scope, the final
ownership/distribution suite passed again (22 tests). Independent DSH review
`wf-mto5a9eh-q8eams` returned PASS/approve with complete delivery.

Initial review requested changes to a proposed lightweight health endpoint;
that endpoint switch was removed from the final change. The original extension
protocol is preserved. Measurements cover warm launch, not a fresh Windows login.
The several-minute full payload update remains separate from this startup fix.

Future installation from an older retained payload may restore its bundled
launcher assets; install from this GitHub revision to retain this optimization.
