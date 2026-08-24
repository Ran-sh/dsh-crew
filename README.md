<p align="center"><img src="./docs/images/dsh-crew-logo.png" alt="DSH Crew" width="120" /></p>

<h1 align="center">DSH Crew</h1>

<p align="center"><strong>Workers and reviewers for Codex Desktop and Claude Code, shown inside the official DeepSeek Harness UI.</strong></p>

<p align="center"><a href="./README.md"><b>English</b></a> · <a href="./README.zh.md">简体中文</a></p>

## Quick start

Requirements: Node.js; Git is required for worktree isolation.

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
dsh-crew integrate
```

Start the official Harness on port 3080 as usual:

```bash
npx -y @deepseek-ai/dsh web --host 127.0.0.1 --port 3080
```

Open <http://127.0.0.1:3080> and go to **Settings → DSH Crew**. The official 3080 process displays the UI; Crew work stays in an isolated backend on `127.0.0.1:3210`, which the bridge starts in the background when needed.

## Configure

1. Click **Refresh Harness Models**.
2. Set the model order for Worker and Reviewer.
3. Keep Worker on **Auto** for automatic delegation.
4. Reviewer defaults to **Manual**; enable automatic review only when wanted.
5. Keep **worktree** isolation for coding tasks.

With one configured model, both roles simply use that model. With several models, each role tries its ordered list and falls back to the next available model. Settings modules are collapsible and show their effective state while closed.

## Use from Codex or Claude

```text
Use ds-worker to implement this change and run the tests.
Use ds-reviewer to review the result.
```

Legacy `ds-flash` and `ds-pro` aliases remain compatible.

## Common commands

```bash
dsh-crew status       # installation and integration health
dsh-crew update       # update and repair enabled integrations
dsh-crew integrate    # connect official 3080 UI to isolated 3210 Crew
dsh-crew detach       # remove only the 3080 bridge
dsh-crew uninstall    # remove Crew, keep config and backups
```

`dsh-crew uninstall --purge` also removes Crew configuration and backups.

If you prefer a completely separate UI, run `dsh-crew detach`, then start the isolated profile directly:

```powershell
$env:DSH_HOME = "$HOME\.config\dsh-crew\harness"
& "$env:DSH_HOME\runtime\node_modules\.bin\dsh.cmd" --profile dsh-crew --host 127.0.0.1 --port 3210
```

The bridge backs up the official `web` profile before its first change and registers only a lightweight proxy/client package. The full Crew Hub, model execution, config, and credentials stay under:

```text
~/.config/dsh-crew/harness
profile: dsh-crew
```

For launchers at `<= 0.3.3`, first refresh the launcher because the old updater cannot discover newer releases and cannot be retroactively fixed:

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew update
```

## Source development

```bash
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
node scripts/setup.mjs install
node --test test/*.test.mjs
pnpm run build:client
node scripts/setup.mjs uninstall
```

More detail: [Changelog](./CHANGELOG.md) · [Readiness matrix](./docs/readiness-matrix.md)

## License

MIT
