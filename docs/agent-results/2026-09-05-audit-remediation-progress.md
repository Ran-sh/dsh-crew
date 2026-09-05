# Audit remediation progress — 2026-09-05

This is a progress record, not full-product or release approval.
Implementation baseline: `f9198e357ad99a39144f92f7d23c49789d552a0b`.

## Completed in this batch

- A1: referenced, cleaned-up maintenance identity deadline; Node 22 tests complete,
  including a real HTTP server with a stalled response body.
- A2: explicit and automatic worktree reviewers require valid before/after
  fingerprints. Missing evidence fails with REVIEW_EVIDENCE_UNAVAILABLE and
  retains the workspace; no review success is fabricated.
- A3: same-version install/update compares distributed first-party content,
  stages changed content, retains prior payloads, and forces runtime activation.
  Staging consumes validated byte snapshots rather than reopening source paths;
  invalid file patterns, linked ancestors and unbounded snapshots are rejected.
  This source digest is not a third-party dependency tamper attestation.
- A4: this machine's global CLI was upgraded from 1.1.1 to the tested RC4 package.
  Global CLI, repository and managed payload now have equal first-party digests.
- A6: Antigravity image selection requires a unique fresh nonce match; it cannot
  substitute an unrelated recent image.
- A7: generated images use request-specific staging and signature/size checks,
  then replace the destination; a failed generation preserves the original file.
- A8: generated-image URL downloads enforce explicit time and streamed byte limits.
- A11: codex/* pushes now trigger CI before merging.
- Additional defect: installer boot-smoke text diagnostics no longer throw from
  the error-formatting path.

## Verification evidence

- Final code CI: Linux and Windows succeeded at
  https://github.com/Ran-sh/dsh-crew/actions/runs/33961579415 .
- Local full Node 22 run before the final activation-marker patch: 1127 tests,
  1126 passed, 0 failed/cancelled, 1 skipped.
- After activation-marker patch: 43 supervisor tests and 14 targeted lifecycle
  tests passed. Earlier complete lifecycle suite: 64 passed.
- Snapshot follow-up review: wf-mto8zy4p-v3lte5 — PASS/approve.
- Activation-contract follow-up: wf-mto9n7zy-2vipje — PASS/approve.
  Earlier requests for changes were evaluated and addressed or withdrawn with
  direct evidence; these follow-ups supersede those earlier verdicts.
- Core/image review: hub-2-mto7szmp — complete review, approve; inspected changed
  source and reported passing targeted tests. Its temporary clean review worktree
  was removed after review; no user code was removed.

## Installed state

Installed using a local tarball and the real global CLI with --candidate pointing
to this checkout. No npm publication occurred.

- Global CLI: 1.2.0-rc.4.
- Managed payload: 1.2.0-rc.4,
  `20260905T105922Z-20176-1-1.2.0-rc.4`.
- Official Harness: 0.1.2-rc.1, dsh-crew profile on 3210.
- Runtime ID changed from `11ecb312-9b86-438c-b5c1-b94829830fe5`
  to `4fcffefa-34c4-4733-80ae-5091a567e167`.
- Runtime activation marker was cleared after verification.
- Repository, global CLI and managed payload first-party digests match.
- Crew config.json and Harness settings.yaml hashes are unchanged.
- Codex, ZCode and Claude installation readiness checks passed.
- Operator's configured muse-spark-1.3-contributor route probe returned callable.
- Installed-path Codex reviewer smoke: wf-mtoa15f4-dmze1s — PASS, approve,
  complete delivery, new runtime ID, worktree released.
- Installed-path ZCode reviewer smoke: wf-mtoa2gpr-s615vf — PASS, approve,
  complete delivery, new runtime ID, worktree released.

## Remaining work owned by Codex

- A5/A10: official 3080 desktop frontend with hidden 3210 backend; correct all
  navigation, stale self-links, labels and tests. Do not silently install a
  plugin into the protected official profile.
- A9: bound multimodal CLI output and process lifetime/cancellation.
- A12: distinguish integration installation readiness from current model callability.
- A13: identify plugin-generated vision routes and expose their controlling switch.
- Consolidate the GitHub update workflow and install instructions; verify a clean
  GitHub installation, native client UI interaction, actual Windows login startup,
  model alternatives, and real multimodal generation/cancellation.
- Keep formal release and npm publication separate from incremental validation.
