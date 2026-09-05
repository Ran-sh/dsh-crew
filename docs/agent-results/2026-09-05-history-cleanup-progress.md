# History cleanup implementation — NOT ENABLED

User approved a 3210-only maintenance feature: archive (default, restorable) or
delete workspace registrations and session logs, all or created-before an
explicit instant, with preview and confirmation. The user accepted briefly
stopping/restarting 3210 while 3080 and project source directories stay untouched.
This approval is for implementing the feature, not deleting current user data.

## Implemented internal primitives

- `src/history/cleanup-plan.mjs`: bounded deterministic selection, strict
  timezone-aware creation cutoff, active-session blocking, snapshot revision.
- `src/history/admission-gate.mjs`: optional public agent-create wrapper with
  in-flight counting, ownership checks and fail-closed live-agent inventory.
- `src/history/archive-store.mjs`: offline allowlisted registration/log archive,
  conflict-aware restore, interrupted-operation rollback, verified-restart
  deletion finalization, atomic/exclusive file publication, symlink rejection.
- Three test files: 25 passing tests. Earlier coverage run before the last
  hardening patch: 100% lines, 85.22% branches, 94.12% functions for these modules.

These modules have NO production imports/callers yet. No user data was archived
or deleted. They have not been packaged into the running installation.

## Independent review

- Architecture review `wf-mtog3ko3-d34pg0`: requires a stopped maintenance lease,
  exclusive update lock, durable recovery/admission fence, confined paths,
  archive journal and conflict-aware restore before exposing writes.
- Code review `wf-mtogyhm8-6v0sw9` of `12965f3`: changes requested. Subsequent
  commits fixed ancestor link rejection, unrelated workspace removal preservation,
  canonical equality, manifest validation, final restore CAS, exclusive atomic
  artifact publication and admission wrapper ownership. Follow-up acceptance is
  still required; do not present the review as approved.

## Required continuation before enablement

1. Read the actual official 0.1.2-rc.1 services in this checkout, not the isolated
   reviewer worktree (which has no node_modules). Workspace package is under
   `node_modules/.pnpm/node_modules/@deepseek-ai/dsh-workspace`; session persistence
   exposes listSnapshots/locate but no delete. Workspace JSON format is unit
   workspace/version2 with global.workspaceIds/archivedSessionIds and a workspaces
   table. Official archive has no restore control. Never edit official package files.
2. Native snapshot adapter must use official persisted session headers/revisions
   and locators, validate all artifacts under Crew-owned harness/sessions, include
   orphan sessions and conservative parent/child protections, and reject unsupported
   storage formats rather than guessing. The pure planner does not validate paths.
3. Add durable operation state + preview TTL/CAS, binding plan IDs to runtime
   identity, operation, exact selections, file hashes and maintenance lease.
4. Add an out-of-process executor (the Hub cannot finish after stopping itself)
   reusing createCrewSupervisor + exclusive update lock. Persist admission gating
   before idle checks; require zero live AND pending native/Crew agent creations.
   Starter must refuse unsafe unfinished history states; provide explicit recovery.
5. Wire guarded local-only 3210 API endpoints, never through the 3080 quick bridge.
   Enforce confirmations server-side. Surface partial/recovery failures without
   restarting into inconsistent state or declaring successful deletion.
6. Add 3210 UI entry with default archive, all/before selection, local time clearly
   converted to UTC, preview counts/identities, distinct delete confirmation,
   archive list/restore, progress/reconnect handling and recovery instructions.
7. Add integration/crash/race/browser tests with disposable profiles only, review
   again, then install/update and verify live read-only UI. Actual bulk cleanup of
   the user's history needs their explicit selection/confirmation.

No npm publication, main merge, runtime restart or configuration mutation in this
implementation phase. Existing production frontend remains the previous UI build.
