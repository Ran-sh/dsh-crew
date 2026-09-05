# Claude update cache reuse — 2026-09-05

Implementation: `3a90bb240ff403bd0ed067e82a2eb625356aaff2`.

The installer previously invoked marketplace registration, uninstall and install
even when the user-scoped cached plugin already matched the requested payload.
It now skips those CLI operations only when both registered directory paths match
the requested root and the existing bounded content-manifest check confirms a
matching user-scoped snapshot. Settings and permissions are still reconciled.

Validation:

- Reproducer failed before implementation.
- Installer, setup and integration suites: 41 passed.
- Added project-only scope regression; integration suite: 22 passed.
- Real current-payload invocation of the changed installer function: 56 ms,
  returned the explicit cache-current skip action. No Claude CLI reinstall ran.
- Read-only installed payload validation: 41 ms, passed.
- Independent DSH review `wf-mto68uhz-b169y7`: PASS, approved, delivery complete.

These measurements cover an already-current cache, not a new-version upgrade.
New or changed snapshots still take the existing CLI refresh path. Synchronous
old-release cleanup is another candidate for profiling, not a measured cause yet.

This change is in GitHub/source installer code. The immutable installed RC4
payload was not overwritten or republished; a future payload incorporating this
commit will include the optimization in its packaged installer. The live test
used this source module against the existing installed payload.
