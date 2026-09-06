---
name: dsh-crew-development
description: Implement or review changes in the DSH Crew plugin repository, selecting focused tests and preserving official-Harness isolation. Not a general coding skill or permission to alter user runtime settings.
---

# DSH Crew development

Use the repository root `AGENTS.md` for task authority and isolation boundaries.
Do not apply the external handoff contract to ordinary user-directed development.

## Locate the changed boundary

- Worker dispatch and result flow: `src/server.mjs`, `src/mcp-runtime.mjs`,
  `src/workflow-runtime.mjs`, `src/hub/index.mjs`.
- User history and recovery: `src/history/`, `windows/start-dsh-crew.ps1`.
- Install/update/host adapters: `src/install/`; instruction templates in
  `codex/`, `zcode/`, `agents/`, `commands/` must remain independently installable.
- UI: `src/client/`; the quick 3080 bundle must not gain 3210 lifecycle authority.

Search the relevant area first; do not load every historical agent result or README
translation. Read `docs/job-contracts.md` when changing result/prompt boundaries;
read `docs/installation.md` for installer ownership; read `docs/ui-surfaces.md`
for frontend/backend responsibilities. Resolve these paths from the repository root.

## Choose evidence, then complete the change

Use Node 22 and the existing pnpm lockfile (CI uses pnpm 10). Dependency installation,
when needed: `pnpm install --frozen-lockfile`. There is no configured lint script.

| Change | Starting validation |
| --- | --- |
| Logic | `node --test test/<affected>.test.mjs` and relevant adjacent tests |
| Codex/ZCode templates | `node --test test/codex-install.test.mjs test/zcode-install.test.mjs test/host-dispatcher-contract.test.mjs` |
| UI | `pnpm run build:client`; `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.client.json`; affected browser journey |
| Broad integration | CI-equivalent test matrix in `.github/workflows/ci.yml` |

Tests should verify behavior or a meaningful invariant. Storage/lifecycle changes
need disposable fixtures, conflict/failure/recovery checks and required review.
Do not use production cleanup, real provider spending or a service restart as a
substitute for a fixture test. Exact paths and authorization must be known first.

Keep the existing Worker/Reviewer model policy; the host's GPT-6 Astra setting is
not a reason to replace providers, cheap dispatchers or fallback roles. Runtime tool
schemas, not examples in a skill, determine valid mode/effort arguments.

After a bounded delegated result, integrate and finish the user's remaining scope.
Report actual checks and limitations; a commit or passing subtask alone is not
completion. Publication and installation are separate, authorized actions.
