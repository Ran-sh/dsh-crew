# Installation plan

DSH Crew uses an explicit installer. Merely installing the npm package does not mutate the host.

## Recommended path

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
dsh-crew integrate
dsh-crew status
```

To test GitHub `main` before an npm release:

```bash
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
node scripts/setup.mjs install
node scripts/setup.mjs status
```

## Managed surfaces

| Surface | Installed behavior | Uninstall behavior |
| --- | --- | --- |
| Crew runtime | Isolated in `~/.config/dsh-crew/harness`, profile: dsh-crew | Registration removed; config kept unless `--purge` |
| Codex MCP and roles | Points Worker, Reviewer, and MCP to the installed release | Only DSH Crew entries are removed |
| Global Codex policy | Managed block inside `~/.codex/AGENTS.md` | Only the managed block is removed |
| ZCode MCP, agents and commands | Installs `~/.zcode/AGENTS.md`, `agents/{ds-worker,ds-reviewer}.md`, commands and a source-aware `dsh-crew` MCP entry | Only DSH Crew-owned files/entry are removed |
| Windows login startup | `DSH Crew.vbs` plus a Crew-owned CMD launcher | Only those two managed files are removed |
| Official 3080 UI | Optional lightweight bridge after `integrate` | `detach` removes the bridge; a backup is kept |

The Windows login launcher starts the official UI on 3080 and the isolated Crew backend on 3210. It does not open a browser and does not store credentials.

ZCode uses `~/.zcode/cli/config.json` when it already has native MCP servers. If
that native list is empty, the installer uses `~/.agents/mcp.json`; unrelated
servers are preserved and a conflicting unowned `dsh-crew` entry fails closed.

## Verification

```bash
dsh-crew status
dsh-crew inspect
dsh-crew jobs list
```

Source checkout verification:

```bash
node --test test/*.test.mjs
pnpm run build:client
npm pack --dry-run
```

## Rollback

```bash
dsh-crew detach
dsh-crew uninstall
```

Use `dsh-crew uninstall --purge` only when configuration and backups should also be deleted.
