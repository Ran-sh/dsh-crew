<p align="center">
  <img src="./docs/images/dsh-crew-logo.png" alt="DSH Crew" width="120" />
</p>

<h1 align="center">DSH Crew</h1>

<p align="center"><strong>Let Codex Desktop or Claude Code coordinate isolated DeepSeek Harness workers and reviewers.</strong></p>

<p align="center"><a href="./README.md"><b>English</b></a> · <a href="./README.zh.md">简体中文</a></p>

## What you get

- A `worker` for implementation, fixes, tests, and repository inspection.
- A read-only `reviewer` with its own model priority.
- Ordered provider/model routing for both roles.
- Temporary Git worktrees by default, so workers do not edit your main workspace directly.
- A live settings and jobs panel inside DeepSeek Harness.

## Install

Requirements: Node.js; Git is required for worktree isolation.

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
```

Use the global launcher. Transient `npx` execution is not the supported install path on npm versions affected by npm/cli#9870.

## Start Harness

Windows PowerShell:

```powershell
$env:DSH_HOME = "$HOME\.config\dsh-crew\harness"
& "$env:DSH_HOME\runtime\node_modules\.bin\dsh.cmd" --profile dsh-crew --port 3210
```

macOS / Linux:

```bash
DSH_HOME="$HOME/.config/dsh-crew/harness" \
  "$HOME/.config/dsh-crew/harness/runtime/node_modules/.bin/dsh" \
  --profile dsh-crew --port 3210
```

Open <http://127.0.0.1:3210>, then go to **Settings → DSH Crew**.

## Configure

1. Install the Codex and/or Claude Code integration.
2. Click **Refresh Harness Models**.
3. Order the models used by Flash and Pro.
4. Keep `worker` on Auto for automatic delegation; keep `reviewer` on Manual unless you want automatic review.
5. Use `worktree` isolation for coding tasks.

The settings page is split into collapsible modules. Each closed module still shows its effective state and first-priority model.

## Use

Ask your coding host naturally:

```text
Use ds-worker to implement this change and run the tests.
Use ds-reviewer to review the result.
```

Legacy `ds-flash` and `ds-pro` aliases remain available, but new workflows should use `ds-worker` and `ds-reviewer`.

## Check, update, remove

```bash
dsh-crew status
dsh-crew update
dsh-crew uninstall
```

`uninstall` preserves configuration and backups. Add `--purge` only when you also want those removed.

For launchers at `<= 0.3.3`, the old updater cannot discover newer releases and cannot be retroactively fixed. Refresh the launcher first, then update the managed payload:

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew update
```

## Isolation and source installs

Crew owns a dedicated Harness home and profile:

```text
~/.config/dsh-crew/harness
profile: dsh-crew
```

Normal Crew operations do not modify `~/.dsh`, the official `web` profile, or official Harness credential stores.

Developer install:

```bash
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
node scripts/setup.mjs install
```

Developer uninstall:

```bash
node scripts/setup.mjs uninstall
```

## Development

```bash
pnpm install --frozen-lockfile
node --test test/*.test.mjs
pnpm run build:client
pnpm run verify:npm-install
```

More detail: [Changelog](./CHANGELOG.md) · [Readiness matrix](./docs/readiness-matrix.md) · [Architecture](./docs/v0.3-architecture-roadmap.md)

## License

MIT
