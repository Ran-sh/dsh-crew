# Installation plan

DSH Crew is a plugin for the official DeepSeek Harness and uses an explicit
installer. Merely installing the npm package does not mutate the host.
The managed production supervisor is currently supported on Windows; Linux and
macOS are not yet production runtime targets.

## Recommended path

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
```

The installer registers the plugin in a dedicated official Harness
`profile: dsh-crew` served on 3210. This is the canonical Crew control and
execution surface; it is not a separate or forked Harness product.

Desktop `--open` starts or reuses the separately installed official CLI's web
frontend on 3080, then ensures Crew runs hidden on 3210. It never opens the 3210
browser automatically. Install the official CLI separately so `dsh.cmd` is on
PATH. Login startup and `--background` remain Crew-only.
The launcher adds a Crew-owned overlay pointing to an immutable small frontend
snapshot. It supplies the simple panel and the link to 3210; the backend links
back to 3080. An already-running official instance without that overlay must be
reloaded when idle; the desktop launcher does not terminate existing official work.

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
| Crew plugin runtime | Official DeepSeek Harness isolated in `~/.config/dsh-crew/harness`, profile: dsh-crew, with the Crew plugin registered | Plugin registration removed; config kept unless `--purge` |
| Codex MCP and roles | Points Worker, Reviewer, and MCP to the installed release | Only DSH Crew entries are removed |
| Global Codex policy | Managed block inside `~/.codex/AGENTS.md` | Only the managed block is removed |
| ZCode MCP, agents and commands | Installs `~/.zcode/AGENTS.md`, `agents/{ds-worker,ds-reviewer}.md`, commands and a source-aware `dsh-crew` MCP entry | Only DSH Crew-owned files/entry are removed |
| Windows login startup | `DSH Crew.vbs`, `start-dsh-crew.cmd`, `start-dsh-crew.ps1`, the exact process controller, and its hash manifest | Only DSH Crew-owned files are removed; foreign pre-existing content at those exact paths is preserved or fails closed |
| Official 3080 UI | Desktop launch starts/reuses the official program; Crew installer does not register plugins in its profile | Left running and untouched by Crew uninstall |

The Windows launcher supervises only the Crew-owned 3210 service, so provider
restart and rollback operations have one verifiable supervisor. The official
3080 surface never starts, owns, or supervises 3210. The launcher does not
store credentials.

`dsh-crew install`, `update`, and `rollback` automatically perform an exact,
crash-resumable watcher handoff after the payload transaction. The updater
reserves handoff ownership before releasing its update lock, resumes any
unfinished handoff first, and succeeds only after the isolated 3210 runtime
reports the expected Crew and DSH versions.

Both the update lock and the handoff lock record the owning process's start
time alongside its PID, and a lock is reclaimed only when the PID is gone or
when that PID is provably a different process than the one that took the lock.
Without it, a recycled PID — the operating system handing a dead owner's PID to
an unrelated process — made a stale lock look alive for as long as the stranger
ran, and no contender could ever reclaim it. Where the platform cannot report a
process start time the check falls back to the PID alone, so a lock is never
stolen on a guess.

The update transaction itself is an ordered state machine, recorded in the
journal's `runtime.state` and advanced one checkpoint at a time:

| State | Meaning |
| --- | --- |
| `before-stop` | Intent journaled; the owned runtime has not been touched |
| `stopped` | A stop completed, so the runtime tree may be mutated |
| `restarted` | A start was **initiated** — written before the start call |
| `verified` | The candidate is running and its dual identity checked out |
| `committed` | The release pointer moved; terminal |

`restarted` is written before the start happens, on purpose: a crash between
the start and the verification is then indistinguishable from a completed
start, which is the safe direction. Recovery uses this to decide whether the
runtime tree may be replaced at all — replacing it under a live process is the
damage the record exists to prevent. Journals written by earlier versions
(`staged`, `starting`) are still read under their new names.

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

## Harness CLI selection

The Crew launcher and the 3210 Hub boot from one Crew-managed Harness entry,
chosen in this order:

1. `DSH_CREW_DSH_CLI`, when set to an explicit `@deepseek-ai/dsh` entry.
2. The Crew-managed npm runtime at `<crew home>/runtime` (the normal install
   path, written by `dsh-crew update`). It carries whatever cohort the installed
   Crew release pinned; the launcher never substitutes a different version.
3. A Crew-managed source cohort, discovered through a
   `<crew home>/runtime-source-<label>.json` sidecar. The sidecar's recorded
   `version` must equal the checkout's own `apps/cli/package.json`, so a stale
   sidecar can never pin a half-updated tree.

For the npm runtime the launcher uses the Crew home as `DSH_HOME`; a source
cohort is its own home, because its profiles, sessions and settings live inside
that tree. The launcher then derives `dsh_version` from the verified
`@deepseek-ai/dsh` manifest and requires the Hub to report that same version, so
a process left over from a previous cohort is never treated as healthy.

Only override `DSH_CREW_DSH_CLI` deliberately — it wins over the managed runtime.
Never point it at the official `~/.dsh` tree, which the Crew launcher treats as a
read-only boundary.

To build a source cohort instead of the npm runtime (for example to test an
unpublished tag), clone the tag into `<crew home>/runtime-source-<label>`, build
its CLI, and write the matching sidecar. On Windows a source install needs the
native toolchain for its `fs-ext` dependency; a failed native build is reported
as a runtime failure rather than silently falling back to another cohort.

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
