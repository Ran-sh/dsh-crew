# Short Triggers

All compatible executors use the same authoritative task:

`docs/agent-tasks/ACTIVE_TASK.json`

Executor choice never changes permissions, scope, validation, or mode semantics.

## Canonical trigger

```text
Execute ACTIVE_TASK.json according to Agent Workflow Protocol.
```

That is the normal user-facing trigger for Codex, ZCode, Claude Code, DeepSeek Harness, or another compatible executor.

The trigger intentionally contains no project requirements. The repository workflow and Task Contract contain all execution rules.

## Chinese trigger

```text
执行 ACTIVE_TASK.json，按 Agent Workflow Protocol 完成即可。
```

## Completion signal back to ChatGPT

After the executor commits/pushes its result, the user only needs to say something like:

```text
Codex finished. Check GitHub.
```

or:

```text
Codex 做完了，检查 GitHub。
```

ChatGPT should read the Result Contract and repository state directly rather than asking the user to paste the report.

## Human companion

`docs/agent-tasks/ACTIVE_TASK.md` may exist as a non-authoritative human-readable companion. If it conflicts with `ACTIVE_TASK.json`, the JSON Task Contract wins.
