Protocol: Agent Handoff Protocol v1
Agent: ZCODE
Mode: IMPLEMENT
Source Branch: <branch>
Source Commit: <sha | LATEST | LATEST_MAIN | LATEST_DEFAULT_BRANCH>
Result Path: docs/agent-results/<agent>-<task>-report.md
Delete Active Task On Completion: YES

# Goal

Describe the exact implementation outcome.

# Context

Provide only the architecture, history, constraints, and known risks needed for this task.

# Allowed Changes

- <path/**>

# Forbidden Changes

- Any path not listed above.
- Unrelated refactors.
- Package/version/release changes unless explicitly requested.
- CI changes unless explicitly requested.
- Credential/provider configuration unless explicitly requested.

# Required Work

1. <step>
2. <step>
3. <step>

# Required Tests

- `<command>`
- `<command>`

If a required test cannot run, report `BLOCKED` or `NOT RUN` with the concrete reason.

# Acceptance Criteria

- <criterion>
- <criterion>

# Result / Report Contract

Create the result report only if requested. Include source SHA, files changed, tests executed, failures/blockers, and concise implementation notes.

# Completion Commit Contract

The final commit may contain only:

- paths explicitly allowed above;
- the requested result report, if any;
- deletion of `docs/agent-tasks/ACTIVE_ZCODE_TASK.md`.

Before commit, inspect `git status --short` and `git diff --cached --name-only`. Remove unrelated staged files before committing.
