# Official frontend / Crew backend acceptance

Code candidate: `ca82f2b989d1160c88b5c38b38f8c0ea89c95bbb` on
`codex/official-frontend-launcher`. No npm publication.

## Delivered behavior

- Desktop launcher opens official Harness on 3080 with the small Crew panel.
- The quick panel links to the 3210 backend; the full backend panel links back
  to the official 3080 frontend.
- Frontend assets are immutable Crew-owned snapshots loaded with the official
  CLI's `--patch` argument. No plugin installation or registration in the
  official web profile is performed.
- Only the dedicated Crew supervisor owns 3210 lifecycle. Quick controls expose
  configuration/status, not restart or maintenance actions.

## Verification

- Build and TypeScript client checks passed.
- Local startup, overlay, bridge, distribution, ownership and client-contract
  suite: 65 passed, zero failed/skipped.
- GitHub CI at the candidate passed:
  https://github.com/Ran-sh/dsh-crew/actions/runs/33966496481
- Independent DSH review `wf-mtodokj6-4t5rab`: PASS/approve, complete structured
  delivery, no changed files, review worktree released. The reviewer ran
  isolated tests, not live UI tests.
- A broader concurrent Windows/Node 24 test attempt failed with an `EPERM`
  temporary runtime-directory rename in `lifecycle-p1.test.mjs` (registry
  fallback prepare-only migration). The exact failing case passed when rerun
  alone. This is not recorded as a clean full-suite pass.
- Isolated official Harness on temporary port 33210 loaded the overlay and its
  client module in authenticated HTML. Its test process was stopped afterwards.
- Real 3080 `/bridge-status` reports the installed frontend revision; its
  `/quick-status` succeeds and returns the same configuration as real 3210.
- A foreign-origin request to the 3080 quick API was rejected with HTTP 403.
- Installed frontend/full client artifacts contain the correct reciprocal
  button labels; the quick client contains no supervisor restart endpoint.

## Installed and reloaded

The local tarball updated the global CLI; the Crew-owned updater activated
managed release `20260905T125308Z-22924-1-1.2.0-rc.4`. Both remain version
`1.2.0-rc.4`. Official Harness remains `0.1.2-rc.1`.

Source, global CLI and managed payload first-party content digest:
`7578c31de17fda7c8b73b3f3657f2e1cd17a2ff4257ce2eb33b2481f7ce14c1d`.

Frontend revision:
`8776e78db59f455063971699656317b862a231cb041159f393302be294c70e80`.

The Crew updater completed its own 3210 activation first. After the operator
confirmed the official frontend was idle, only the verified old official
3080 process was stopped and relaunched with the overlay. During that separate
3080 reload, 3210's runtime ID stayed
`0e92308f-1288-4d0b-b567-f77c688b5935`.

The user's Crew configuration and Harness settings SHA-256 hashes remained
unchanged. Codex, ZCode, Claude and Windows startup installation checks passed;
these checks do not claim fresh end-to-end model execution by every native host.

## Limits and follow-ups

- Computer Use stopped because its Windows browser-URL safety check could not
  establish the current URL. No alternative GUI automation was used. Actual
  rendered appearance and interactive clicks are therefore not visually
  accepted by this report.
- The CLI's deprecated legacy-bridge status is separate from the new runtime
  overlay; live overlay readiness was checked directly above.
- Review suggested non-blocking follow-ups: backend availability if official
  startup fails, explicit overlay feature detection instead of a source-string
  marker, clearer frontend URL variable names, and quick-panel accessibility.
- This accepts the startup/navigation slice, not all remaining audit items or
  an npm release.
