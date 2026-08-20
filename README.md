<p align="center">
  <img src="./docs/images/dsh-crew-logo.png" alt="DSH Crew" width="120" />
</p>

<h1 align="center">DSH Crew</h1>

<p align="center">
  <strong>Use Codex Desktop or Claude Code as the orchestrator, and dispatch coding work to DeepSeek V4 Flash / Pro through DeepSeek Harness.</strong>
</p>

<p align="center">
  <a href="./README.md"><b>English</b></a> · <a href="./README.zh.md">简体中文</a>
</p>

## Features

- Codex Desktop / Claude Code as the main orchestrator
- DeepSeek V4 Flash / Pro workers
- Flash Only · Pro Only · Balanced · Review Pipeline
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
     ┌────┴────┐
     │         │
   Flash      Pro
     │         │
     └────┬────┘
          │
          ▼
   DeepSeek Harness
          │
          ▼
   DSH selected provider
```

## Install

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

The installer:

- links this local checkout into the DSH web profile (`link:<repo>`)
- installs the Codex Desktop integration (no `codex` CLI required)
- installs the Claude Code integration automatically when the `claude` CLI is detected (optional)
- is idempotent — safe to re-run

It never touches your credentials or DSH provider settings, and it does not start DSH for you.

## Uninstall

Windows:

```bat
uninstall.cmd
```

Cross-platform:

```bash
node scripts/setup.mjs uninstall
```

Removes:

- DSH Crew from the DSH web profile
- Codex Desktop integration
- Claude Code integration

Keeps:

- the repository
- Crew config (`~/.config/dsh-crew`)
- backups and credentials

## Quick Start

1. Start DSH as usual: `npx @deepseek-ai/dsh web`
2. Open **Settings → DSH Crew**.
3. Keep the fresh default **Flash Only** workflow: Codex → Flash coding worker → Codex.
4. Use **Refresh Harness Models** to choose an ordered Flash or Pro model priority when needed.
5. Restart Codex Desktop / Claude Code.

Then just say:

- “Use ds-flash to implement this change.”
- “Use ds-pro to review this implementation.”

## Modes

| Mode | Behavior |
|---|---|
| Flash Only | Delegated coding uses Flash |
| Pro Only | Delegated coding uses Pro |
| Balanced | Flash handles routine work, Pro handles harder reasoning / review |
| Review Pipeline | Flash implements, Pro reviews |

Custom mode configures Flash / Pro states and responsibilities directly.

## Provider

Crew reads every provider and model currently registered in DeepSeek Harness. Flash and Pro each have an unlimited ordered model priority list; their fresh preferences are `deepseek-v4-flash` / `deepseek-v4-pro`, with Harness Default as fallback.

- **Follow DSH Provider** — resolve the tier's provider/model priority from the Harness catalog (fresh default).
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

## Credits & License

This fork is based on [ZSeven-W/dsh-crew](https://github.com/ZSeven-W/dsh-crew) and retains the original MIT license and attribution.

MIT License — see [LICENSE](LICENSE).
