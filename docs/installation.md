# Installation plan

DSH Crew uses an explicit installer. Merely installing the npm package does not mutate the host.
The managed production supervisor is currently supported on Windows; Linux and
macOS are not yet production runtime targets.

## Recommended path

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
```

3210 is the canonical full Crew control and runtime. All production
Worker/Reviewer model execution runs on the isolated 3210 Crew Harness.

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
| Windows login startup | `DSH Crew.vbs`, `start-dsh-crew.cmd`, and `start-dsh-crew.ps1` | Only DSH Crew-owned files are removed; foreign pre-existing content at those exact paths is preserved or fails closed |
| Official 3080 UI | External read-only optional legacy diagnostic; never installed or required by Crew | Nothing to remove; Crew never owns the official profile |

The Windows launcher supervises only the Crew-owned 3210 service, so provider
restart and rollback operations have one verifiable supervisor. The official
3080 surface never starts, owns, or supervises 3210. The launcher does not
store credentials.

On Windows, installation registers login startup. To start immediately and
open the Crew control:

```powershell
& "$env:USERPROFILE\.config\dsh-crew\launchers\start-dsh-crew.cmd" --open
```

Then verify <http://127.0.0.1:3210/> answers the Crew extension contract.

```bash
dsh-crew status
dsh-crew inspect
```

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

## Rollback vs uninstall

```bash
dsh-crew releases list
dsh-crew rollback <version>
```

Use `dsh-crew rollback <version>` to switch the retained payload and verify the
3210 runtime. Use `dsh-crew uninstall` only to remove managed files (backups and
config are kept unless `--purge` is passed).

```bash
dsh-crew uninstall
```

Use `dsh-crew uninstall --purge` only when configuration and backups should also be deleted.
