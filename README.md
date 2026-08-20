<p align="center">
  <img src="./docs/images/dsh-crew-logo.png" alt="DSH Crew" width="120" />
</p>

<h1 align="center">DSH Crew</h1>

<p align="center">
  <strong>Use Codex Desktop or Claude Code as the orchestrator, and dispatch coding work to DeepSeek Harness workers (with an independent reviewer role) over configurable Worker Model Policies.</strong>
</p>

<p align="center">
  <a href="./README.md"><b>English</b></a> · <a href="./README.zh.md">简体中文</a>
</p>

## Features

- Codex Desktop / Claude Code as the main orchestrator
- **Roles**: worker (implementation / fixes / tests / search) and reviewer (independent review + verdict)
- **Model Policy**: each role resolves its own ordered provider/model candidates (preferred → priority → escalation → Harness Default)
- Legacy Flash Only · Pro Only · Balanced · Review Pipeline modes migrate onto the role model automatically
- Follow DSH Provider
- First-class DSH Hub sessions (visible in the Web UI, async jobs with progress)
- Optional Vision / Image Generation (independently switchable)

## How it works

```
Codex Desktop / Claude Code
          │
          ▼
       dsh-crew
          │
     Workflow (run + spawn share one state machine)
          │
     ┌────┴────┐
     │         │
   worker    reviewer
     │         │
  Model Policy  │  (each role resolves its own provider/model candidates;
  cheap→strong  │   escalation steps on evidence: FAIL tests, missing
     │          │   delivery, blocked tasks)
     └────┬────┘
          │
          ▼
   DeepSeek Harness
          │
          ▼
   DSH selected provider/model
```

The orchestrator picks **what** to do and decides accept / reject / revise.
The workflow decides **when / state**. **Roles** decide **who** (worker executes,
reviewer reviews). **Model Policy** decides **which model** (never fixed to a
role). Workspace isolation decides **where** (each coding worker runs in its
own temporary git worktree, so parallel workers never write the same working
tree). Verification / reviewer decide **whether to accept**.

## Install

Prerequisites: Node.js with npm/npx, Git, and pnpm. The GitHub install path was tested with each prerequisite removed from the command environment: DSH needs `npx`, and its profile forwarder calls both Git and `pnpm`.

Install directly from this GitHub repository from any directory:

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:Ran-sh/dsh-crew
```

Start DSH:

```bash
npx -y @deepseek-ai/dsh web
```

Then open **Settings → DSH Crew** and click **Install** for Codex. Claude Code integration is optional and has its own Install button.

This installs Crew persistently in the DSH `web` profile. Crew is not published to the npm registry; `npx` only runs the DSH CLI, which installs Crew from GitHub.

### Update

Re-run the GitHub add command. DSH/pnpm refreshes the Git revision without adding a duplicate dependency or bundle entry:

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:Ran-sh/dsh-crew
```

Restart DSH after updating.

### Migrating an older fork install

Older versions of this fork used the upstream package identity `@zseven-w/dsh-crew`. Because the package name alone cannot distinguish this fork from the genuine upstream package, migration is deliberately not automatic.

Only if you have confirmed that the old package came from `Ran-sh/dsh-crew`, run:

```bash
npx -y @deepseek-ai/dsh plugin --profile web remove @zseven-w/dsh-crew
npx -y @deepseek-ai/dsh plugin --profile web add github:Ran-sh/dsh-crew
```

Do not remove `@zseven-w/dsh-crew` when it is an intentional installation of the upstream project.

### Migrating from Flash / Pro (v0.1 → v0.2 roles)

v0.2 keeps every old configuration field working. `collaboration_mode`,
`tier_policy`, `flash_state` / `pro_state`, `flash_model_priority` /
`pro_model_priority`, `escalate_on_failure` and `pro_reviews_flash` are all
still read, and a centralized migration rebuilds the role model from them:

- `flash-only` → worker auto, reviewer disabled, `economy` strategy.
- `pro-only` → worker auto (strong model class), reviewer disabled.
- `balanced` → worker auto, reviewer manual (available on request).
- `review-pipeline` → worker auto + reviewer auto (`auto_review` on);
  reviewer uses the old Pro priority.
- `escalate_on_failure` → worker escalation policy `enabled`.
- `pro_reviews_flash` → automatic review after a successful worker run.

The old `ds-flash` / `ds-pro` subagents remain as **deprecated aliases**: they
map to the worker role with a legacy model-class hint, so existing prompts
keep working, but new prompts should use `ds-worker` / `ds-reviewer`. A
request that names both a role and a contradicting legacy tier is rejected
with a clear `ROLE_TIER_CONFLICT` error — never silently guessed.

### Troubleshooting: `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`

pnpm 11 enforces a default supply-chain policy (`minimum-release-age`, 24h):
a lockfile entry published within the last day is rejected unless listed under
`minimumReleaseAgeExclude`. Installing Crew into a fresh `web` profile is
unaffected, but if your profile already contains a just-published DSH-plugin
(for example the optional `dsh-plugin-image-mind`), the install fails with
this error.

Unblock it by adding the package (bare name, no version) under
`minimumReleaseAgeExclude` in the profile's `pnpm-workspace.yaml`, then re-run
the add command:

```yaml
# ~/.dsh/profiles/web/pnpm-workspace.yaml
minimumReleaseAgeExclude:
  - dsh-plugin-image-mind
  - '@ran-sh/dsh-vision@0.1.0'
```

Notes: use a bare package name — listing multiple `pkg@version` entries for
the same name only honors the first (first-match-wins), which can leave newer
versions blocked. Keep the entries in `pnpm-workspace.yaml`; the verifier does
not read `.npmrc`. The policy only applies to registry packages younger than
one day (git-hosted installs like Crew itself are never age-checked), so the
failure is transient and self-heals within 24 hours.

## Uninstall

DSH Crew and its Codex / Claude Code integrations are separate layers:

1. In **Settings → DSH Crew**, click **Restore** for Codex and Claude Code integrations that you installed.
2. Remove the profile plugin:

```bash
npx -y @deepseek-ai/dsh plugin --profile web remove @ran-sh/dsh-crew
```

Removing the profile plugin does not implicitly edit `~/.codex` or `~/.claude`. Crew configuration, backups, credentials, and other DSH bundles are preserved.

## Development / Source install

The source installer remains available for contributors and local checkout development.

Windows:

```bat
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
install.cmd
```

To update later:

```bat
git pull
install.cmd
```

Cross-platform:

```bash
node scripts/setup.mjs install
```

The source installer:

- links this local checkout into the DSH web profile (`link:<repo>`)
- installs the Codex Desktop integration (no `codex` CLI required)
- installs the Claude Code integration automatically when the `claude` CLI is detected (optional)
- is idempotent — safe to re-run

Source uninstall on Windows:

```bat
uninstall.cmd
```

Source uninstall cross-platform:

```bash
node scripts/setup.mjs uninstall
```

It removes:

- DSH Crew from the DSH web profile
- Codex Desktop integration
- Claude Code integration

It keeps:

- the repository
- Crew config (`~/.config/dsh-crew`)
- backups and credentials

## Quick Start

1. Start DSH as usual: `npx -y @deepseek-ai/dsh web`
2. Open **Settings → DSH Crew**.
3. Keep the fresh default workflow: Codex → **worker** role → Codex (reviewer off).
4. Use **Refresh Harness Models** to choose ordered per-role model priorities when needed.
5. Restart Codex Desktop / Claude Code.

Then just say:

- “Use ds-worker to implement this change.”
- “Use ds-reviewer to review this implementation.”

## Roles

- **worker** — the executing role: implementation, fixes, tests, search, analysis. The default role for any coding request. It is a thin dispatcher; which model backs it is the Worker Model Policy's job.
- **reviewer** — the independent review role: inspects the implementation outcome, the workspace diff, tests and risks, and returns a verdict. Review-only by default; it does not re-implement.
- **ds-flash / ds-pro** remain as deprecated aliases for compatibility (see migration above).

A role's state is `disabled | manual | auto`: a disabled role refuses every
request, a manual role runs only when explicitly named, an auto role may be
chosen by the orchestrator. The effective state comes from the legacy
collaboration mode until you adopt the canonical config.

## Model Policy

Each role resolves its own ordered provider/model candidates through the live
Harness catalog:

- attempt 0 → the role's primary (cheap/fast) priority;
- attempt ≥ 1 → the escalation (strong) priority — escalation happens on
  *evidence* (FAIl tests, incomplete delivery, blocked/incomplete task,
  workspace diff that disagrees with the worker's report), not on failure
  alone, and never beyond `max_attempts`;
- otherwise → Harness Default.

Flash / Pro survive only as legacy model-class hints (`deepseek-v4-flash` /
`deepseek-v4-pro`); they are not roles.

## Modes

| Mode | Mapped role behavior |
|---|---|
| Flash Only | worker auto, reviewer disabled, economy model strategy |
| Pro Only | worker auto on the strong model class, reviewer disabled |
| Balanced | worker auto, reviewer manual (available on request) |
| Review Pipeline | worker auto + reviewer auto (`auto_review` on) |

Custom mode configures worker / reviewer states directly.

## Provider

Crew reads every provider and model currently registered in DeepSeek Harness. Flash and Pro each have an unlimited ordered model priority list; their fresh preferences are `deepseek-v4-flash` / `deepseek-v4-pro`, with Harness Default as fallback.

- **Follow DSH Provider** — resolve the role's provider/model priority from the Harness catalog (fresh default).
- **DeepSeek Official** — use the legacy built-in fixed route for compatibility.

Credentials stay in the DSH provider configuration only. Tested with an OpenAI-compatible OpenCode Go gateway. Standalone mode (no DSH running) always uses DeepSeek Official + `DEEPSEEK_API_KEY`.

## Hosts

- **Codex Desktop** is directly supported through the shared `~/.codex` configuration. The Codex CLI is **not required**; it is an optional extra host / management interface.
- **Claude Code** is optional; the one-click setup installs its integration automatically when the Claude CLI is detected.

## Notes

- Main Agent Mode is routing guidance, not a hard sandbox for the host's tools.
- Standalone uses DeepSeek Official only.
- Crew Vision registration changes may require a DSH restart.
- Restart Codex Desktop after integration changes.
- Every worker returns an auditable Delivery Report (`## Diff` / `## Tests` / `## Risks`) and the hub captures a read-only, redacted in-memory workspace diff so you can verify what changed before accepting the result.
- Blocking (`dsh_run_worker`) and async (`dsh_spawn_worker`) jobs share the same workflow state machine and evidence rules; async escalation/review follow-up is exposed through the same structured outcome.
- A coding worker's default execution path is a temporary git worktree so parallel jobs never write the same working tree; the orchestrator receives a change candidate (base revision, name status, bounded redacted patch) before accepting.

## Credits & License

This fork is based on the original DSH Crew by [ZSeven-W](https://github.com/ZSeven-W/dsh-crew) and retains the original MIT license and attribution. It adds configurable Harness-backed model priorities, worker/reviewer roles, unified job workflows, git-worktree isolation, auditable delivery, and related workflow changes.

MIT License — see [LICENSE](LICENSE).
