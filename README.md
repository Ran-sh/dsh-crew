# DSH Crew

A Crew orchestration plugin for the official DeepSeek Harness. It adds
Worker/Reviewer dispatch, model priorities, job tracking, and a capability-aware
safety gate for Codex Desktop, ZCode, and Claude Code.

[简体中文](./README.zh.md)

## Quick start

Requirements: Windows, Node.js, and Git. Managed 3210 supervision is currently
supported on Windows; Linux and macOS are not yet production runtime targets.

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
```

DSH Crew is installed as a plugin in a dedicated official DeepSeek Harness
profile named `dsh-crew`, served on 3210. That profile is the canonical Crew
control and execution surface.

The official 3080 surface is outside Crew ownership and optional for Crew.
Crew treats its profile as read-only and never starts, owns, or supervises it.

On Windows, installation registers login startup. To start immediately and
open the Crew control:

```powershell
& "$env:USERPROFILE\.config\dsh-crew\launchers\start-dsh-crew.cmd" --open
```

Or open <http://127.0.0.1:3210/> after startup.

Install, update, and rollback also converge the Windows watcher automatically:
the exact old watcher is handed off, and completion is reported only after the
new 3210 Crew and DSH versions are verified. No 3080 restart is involved.

```bash
dsh-crew status
dsh-crew inspect
```

Fresh installs contain only the built-in DeepSeek route. Add your own provider
credentials, model priorities, and optional integrations in the local Settings;
they are never bundled into this package.

| Surface | Purpose |
| --- | --- |
| `3080` | Official Harness `web` profile outside Crew ownership; optional for Crew |
| `3210` | Official Harness `dsh-crew` profile with the DSH Crew plugin |

In **Settings → DSH Crew**, refresh Harness Models and order the Worker and
Reviewer model lists. Then ask a host agent:

```text
Use ds-worker to implement this change and run its tests.
Use ds-reviewer to review the result.
```

Codex, ZCode, and Claude use the installed managed integration. The policy
checks live Crew capabilities before dispatch; if a selected Crew capability
becomes unavailable, the host pauses for an operator decision instead of
silently falling back.

## Useful commands

```bash
dsh-crew inspect          # live capabilities and readiness
dsh-crew jobs list        # jobs and Result Contracts
dsh-crew providers list   # 3210 Harness provider inventory (secret-free)
dsh-crew providers migration-status # detect legacy base providers; no automatic migration
dsh-crew providers migrate-plan <provider>
dsh-crew providers migrate <provider> --plan <id> --confirm # writes user layer, restarts 3210, verifies
dsh-crew providers rollback-migration <provider> --plan <id> --confirm
dsh-crew providers probe <provider-id>
curl http://127.0.0.1:3210/_dsh/dsh-crew/credential-references  # references/orphans only
dsh-crew credentials list  # secret-free reference inventory
dsh-crew credentials purge-plan env:NAME
dsh-crew credentials purge env:NAME --plan <plan-id> --expected-revision <sha256> --confirm
dsh-crew providers delete-plan <provider-id> --replacement-default <provider-id>
dsh-crew providers delete <provider-id> --plan <plan-id> --expected-revision <sha256> --confirm
dsh-crew releases list     # retained validated payloads
dsh-crew rollback <version> # switch payload and verify the 3210 runtime
dsh-crew update           # update and repair enabled integrations
dsh-crew uninstall        # remove managed files, keep backups/config
```

The dedicated official Harness runtime state is isolated under
`~/.config/dsh-crew/harness` with `profile: dsh-crew`; DSH Crew itself remains a
plugin, not a fork or replacement of DeepSeek Harness. The official `web`
profile is outside Crew ownership and read-only to Crew; in other words, the
official `web` profile is never mutated. An old 3080 bridge, if present, is
only reported as a deprecated diagnostic.

## Legacy launcher migration

For launchers at `<= 0.3.3`, refresh the launcher first. The old updater cannot discover newer releases and cannot be retroactively fixed:

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew update
```

## Install from source

```bash
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
node scripts/setup.mjs install
node scripts/setup.mjs status
node scripts/setup.mjs uninstall
```

Run tests with `node --test test/*.test.mjs`. See [installation](./docs/installation.md),
[UI surfaces](./docs/ui-surfaces.md), [readiness](./docs/readiness-matrix.md),
and [job contracts](./docs/job-contracts.md) for details.

MIT
