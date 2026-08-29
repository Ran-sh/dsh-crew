<p align="center"><img src="./docs/images/dsh-crew-logo.png" alt="DSH Crew" width="112" /></p>

# DSH Crew

Workers and independent reviewers for Codex Desktop and Claude Code, with daily controls inside the official DeepSeek Harness UI.

[English](./README.md) · [简体中文](./README.zh.md)

## Quick start

Requirements: Node.js; Git is also required for worktree isolation.

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
dsh-crew integrate
```

On Windows, installation also creates a per-user login-start entry. It starts the isolated Crew backend on 3210 and the official UI on 3080 without opening a browser. Open <http://127.0.0.1:3080> when you need the console.

```bash
dsh-crew status
dsh-crew inspect
```

- **3080**: daily console, Crew settings, Codex/Claude readiness, jobs.
- **3210**: isolated Crew backend, Providers, Harness Models, low-level Harness settings.
- **Codex**: installation adds a managed capability-aware policy block to `~/.codex/AGENTS.md`. Existing user instructions remain untouched.

## Configure and use

In **Settings → DSH Crew**, refresh Harness Models and order the Worker and Reviewer model lists. One configured model is used directly; several models are tried in your chosen order. Worker can run automatically. Reviewer defaults to manual.

Ask Codex or Claude naturally:

```text
Use ds-worker to implement this change and run its tests.
Use ds-reviewer to review the result.
```

Codex first discovers the live Crew capability/readiness contract. If it selected Crew and Crew becomes unavailable, it pauses and asks whether to repair Crew or continue locally; it does not silently fall back.

## Commands

```bash
dsh-crew status                    # installation and integration health
dsh-crew inspect                   # live capabilities and readiness
dsh-crew jobs list                 # jobs and Result Contracts
dsh-crew jobs watch <id> --after 0
dsh-crew update                    # update and repair enabled integrations
dsh-crew integrate                 # add the official 3080 bridge
dsh-crew detach                    # remove only the 3080 bridge
dsh-crew uninstall                 # remove managed files; keep config/backups
dsh-crew uninstall --purge         # also remove config/backups
```

The official `web` profile receives only a lightweight bridge. The Crew runtime, models, config, and credentials stay isolated under:

```text
~/.config/dsh-crew/harness
profile: dsh-crew
```

## Install from source

Use this path to install the current GitHub `main` before it is published to npm:

```bash
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
node scripts/setup.mjs install
node scripts/setup.mjs status
```

Verify and remove it with:

```bash
node --test test/*.test.mjs
pnpm run build:client
node scripts/setup.mjs uninstall
```

For launchers at `<= 0.3.3`, refresh the launcher first. The old updater cannot discover newer releases and cannot be retroactively fixed:

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew update
```

Installation ownership and rollback details: [Installation plan](./docs/installation.md). Architecture contracts: [UI surfaces](./docs/ui-surfaces.md) · [Readiness](./docs/readiness-matrix.md) · [Jobs and information flow](./docs/job-contracts.md).

MIT
