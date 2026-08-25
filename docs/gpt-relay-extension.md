# GPT-first extension integration

DSH Crew is an optional DeepSeek Harness capability extension for Codex,
Claude Code, ZCode, or another top-level executor. It is not itself a top-level
executor and does not choose the next project-wide step.

## Discover

With the isolated Hub running on 3210:

```bash
dsh-crew inspect
```

The same versioned JSON is available at:

```text
GET http://127.0.0.1:3210/_dsh/dsh-crew/extension
```

An orchestrator should check `capabilities.deepseek.worker` or
`capabilities.deepseek.reviewer`, then inspect `readiness.status` and its
components. `DEGRADED` is not `READY`; a model catalog proves discoverability,
not successful authentication or execution.

## Dispatch and observe

Codex and Claude normally call the six MCP tools. `dsh_run_worker` and
`dsh_spawn_worker` accept the backward-compatible fields plus:

- `job_id`: optional caller id, echoed separately from Crew's internal id.
- `profile`: a Worker/Reviewer profile id.
- `workspace`: per-job `repo_root`, `branch`, and `worktree` policy.
- `constraints`: per-job timeout and fallback override.
- `workspace_id`: a registered Workspace Context id.
- `context_refs`: extra workspace-relative instruction references.

Poll `dsh_worker_result` with `after_sequence` to receive only newer canonical
events. HTTP consumers can use:

```text
POST /_dsh/dsh-crew/jobs
GET /_dsh/dsh-crew/jobs/:id/contract?after=0
GET /_dsh/dsh-crew/jobs/:id/events?after=0
```

CLI consumers use `dsh-crew jobs list|get|watch|cancel|submit`; `submit`
accepts a versioned JSON Job Request through `--request`.

The compact Contract is the automation surface. Full prose and patches require
an explicit `detail=full` recovery/debug request.

## Profiles

Profiles live in `~/.config/dsh-crew/profiles.json`:

```json
{
  "schema_version": 1,
  "profiles": {
    "worker-fast": {
      "role": "worker",
      "routing": "priority",
      "isolation": "worktree",
      "fallback": false,
      "timeout_seconds": 300,
      "review_strictness": "standard"
    }
  }
}
```

The built-ins are `worker-default` and `reviewer-default`. The registry can be
read or atomically replaced through loopback-only `GET/POST
/_dsh/dsh-crew/profiles`. Invalid documents are rejected before replacement.

## Workspace Context

Workspace facts live in `~/.config/dsh-crew/workspaces.json`:

```json
{
  "schema_version": 1,
  "workspaces": {
    "dsh-crew": {
      "repo_root": "D:/work/dsh-crew",
      "default_branch": "main",
      "instruction_files": ["AGENTS.md"],
      "validation_hints": ["node --test test/*.test.mjs", "pnpm run build:client"]
    }
  }
}
```

Only bounded path references and hints cross the hand-off. Crew never copies
instruction-file contents into the registry. Use loopback-only `GET/POST
/_dsh/dsh-crew/workspaces` to read or atomically replace it.

## Failure handling

Every structured failure includes a `family` and `disposition`. Dispositions
are `retry`, `fallback`, `human`, or `terminal` (`none` for success), allowing
the GPT-first controller to decide the next step without parsing logs.
