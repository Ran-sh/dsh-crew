# DSH Crew

An isolated Crew Harness for Codex Desktop, ZCode, and Claude Code. It
provides Worker/Reviewer dispatch, model priorities, job tracking, and a
capability-aware safety gate.

[简体中文](./README.zh.md)

## Quick start

Requirements: Node.js and Git.

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
dsh-crew integrate
dsh-crew status
```

Open <http://127.0.0.1:3080> for the daily console. On Windows, installation
also registers login startup for the 3080 console; its official bridge starts
and owns the isolated 3210 Harness backend.

| Surface | Purpose |
| --- | --- |
| `3080` | Daily console, Crew settings, integrations, and jobs |
| `3210` | Isolated Crew Harness, Providers, Harness Models, and low-level settings |

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
dsh-crew providers probe <provider-id>
dsh-crew providers delete-plan <provider-id> --replacement-default <provider-id>
dsh-crew providers delete <provider-id> --plan <plan-id> --expected-revision <sha256> --confirm
dsh-crew update           # update and repair enabled integrations
dsh-crew uninstall        # remove managed files, keep backups/config
```

The runtime is isolated under `~/.config/dsh-crew/harness` with `profile: dsh-crew`;
the official `web` profile receives only the 3080 bridge.
All production Worker/Reviewer model calls are executed by the isolated 3210
Crew Harness; 3080 is a control-plane bridge only.

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
