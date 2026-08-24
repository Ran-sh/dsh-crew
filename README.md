<p align="center">
  <img src="./docs/images/dsh-crew-logo.png" alt="DSH Crew" width="120" />
</p>

<h1 align="center">DSH Crew</h1>

<p align="center">
  <strong>Use Codex Desktop or Claude Code as the orchestrator, and dispatch coding work to isolated DeepSeek Harness workers and reviewers.</strong>
</p>

<p align="center">
  <a href="./README.md"><b>English</b></a> · <a href="./README.zh.md">简体中文</a>
</p>

## What it does

DSH Crew adds a small orchestration layer between your coding host and DeepSeek Harness:

- **worker** — implements, fixes, tests, searches, and analyzes;
- **reviewer** — independently reviews the worker result and returns a verdict;
- **model policy** — resolves provider/model priorities per role and can escalate on evidence;
- **isolated execution** — coding workers run in temporary git worktrees by default;
- **live jobs** — Hub sessions expose progress, results, cancellation, routing trace, and readiness data.

```text
Codex Desktop / Claude Code
            │
            ▼
         DSH Crew
       ┌────┴────┐
       │         │
    worker    reviewer
       │         │
       └────┬────┘
            ▼
     DeepSeek Harness
```

## Install

Prerequisites: **Node.js** (Git is needed only for coding-worker isolation).

Recommended: install a stable, package-manager-installed launcher and manage DSH Crew with it:

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
```

Manage the installation later with the same CLI:

```bash
dsh-crew status
dsh-crew update
dsh-crew uninstall        # add --purge to also remove config/backups
```

The globally installed package is only the launcher/manager. The actual Crew runtime/plugin payload is persisted under Crew-owned state (`~/.config/dsh-crew/app`) before Harness registration, so runtime behavior never depends on npm cache paths.

> Known compatibility issue: transient `npx @ran-sh/dsh-crew …` execution is currently unreliable on some npm versions (npm/cli#9870: the npx cache bin is not put on the spawned command PATH). Until that upstream fix reaches your npm, use the global-launcher flow above instead.

An update of the managed payload does not require a clone or rebuild. When the launcher and payload versions match, `dsh-crew update` resolves the newest permitted package from your configured npm registry (or an explicit `--candidate <path>` override). When the running launcher is newer, its validated package payload is used first to converge the older managed payload. Every path stages and validates before switching. If the managed payload is newer than the launcher, it is never downgraded and the CLI prints the exact launcher-refresh command.

> Migration boundary for legacy `<= 0.3.3`: those immutable launchers cannot discover newer registry versions, so their old update behavior cannot be retroactively fixed. Refresh the launcher first, then converge the managed payload—no source checkout is required:
>
> ```bash
> npm install -g @ran-sh/dsh-crew@latest
> dsh-crew update
> ```

Developer / source setup (alternative path):

```bash
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
node scripts/setup.mjs install
```

Windows source checkouts can use:

```bat
install.cmd
```

DSH Crew uses its own Harness home and profile:

```text
~/.config/dsh-crew/harness
profile: dsh-crew
```

Supported Crew tooling does **not** modify the normal `~/.dsh` home, the official `web` profile, or official DSH credential stores.

## Quick start

1. Start DeepSeek Harness normally.
2. Open **Settings → DSH Crew**.
3. Install the Codex integration; Claude Code integration is optional.
4. Refresh Harness models and choose role priorities if needed.
5. Restart the coding host after integration changes.

Then ask the host naturally, for example:

```text
Use ds-worker to implement this change.
Use ds-reviewer to review the implementation.
```

## Roles and routing

| Role | Purpose |
|---|---|
| `worker` | Implementation, fixes, tests, search, analysis |
| `reviewer` | Independent review and verdict |

Each role resolves its own ordered provider/model candidates. Explicit user priorities remain authoritative; automatic escalation only happens when the workflow has evidence that stronger execution or review is needed.

Legacy `ds-flash` / `ds-pro` aliases remain for compatibility, but new prompts should use `ds-worker` / `ds-reviewer`.

## Isolation

`execution.isolation` defaults to `worktree`.

A coding worker receives a temporary git worktree at the requested revision, so parallel workers do not write into the same working tree. The worker returns an auditable change candidate for the orchestrator to accept, reject, or revise; Crew does not silently merge changes into your primary workspace.

## Update / uninstall

The managed Crew payload updates in place (config, credentials, and backups are preserved; the candidate is staged and validated before switching):

```bash
dsh-crew update
```

Uninstall the managed payload and integrations:

```bash
dsh-crew uninstall
```

Update a source install instead with:

```bash
git pull --ff-only
node scripts/setup.mjs install
```

Uninstall Crew from a source checkout:

```bash
node scripts/setup.mjs uninstall
```

Windows shortcuts:

```bat
install.cmd
uninstall.cmd
```

Crew config and backups under `~/.config/dsh-crew` are preserved unless you remove them yourself.

## Development

```bash
pnpm install --frozen-lockfile
node --test test/*.test.mjs
pnpm run build:client
pnpm run verify:npm-install
```

Useful docs:

- [Architecture roadmap](./docs/v0.3-architecture-roadmap.md)
- [Readiness matrix](./docs/readiness-matrix.md)
- [Agent Workflow](./docs/agent-workflow.md)
- [Changelog](./CHANGELOG.md)

## License

MIT
