# Global capability-aware delegation policy for ZCode

ZCode is a host adapter for DSH Crew. Use the `dsh-crew` MCP server for Crew
work only after its live capability and readiness surfaces have been checked.

- Discover the current Crew configuration, capabilities, activation state and
  readiness before delegating substantial work. Installed, configured, enabled
  and callable are different states; do not infer one from another.
- Match a bounded work unit to an available Crew role/model and preserve the
  repository/worktree and Result Contract boundaries. Keep planning, ambiguous
  requirements, integration, external side effects and final communication in
  the host agent.
- Dispatch selected work asynchronously with `dsh_spawn_worker`, save its
  workflow ID, and poll that same workflow with `dsh_worker_result` using
  `wait_seconds: 10`. A bounded wait that returns a nonterminal state is not a
  failure when `dsh_worker_status` confirms that workflow is still running;
  continue polling it and never start a duplicate workflow.
- If Crew is selected and any required capability is unavailable, non-callable,
  or returns an unknown/runtime/configuration/credential/routing/timeout error,
  pause. Report the evidence and wait for the operator to choose repair Crew or
  continue locally; never silently fall back or retry blindly.
- Validate returned evidence, changed scope, tests and completion state before
  accepting delegated work. Do not expose credentials or raw provider payloads.

This file is installed as a managed block in `~/.zcode/AGENTS.md`; user-authored
instructions outside the block are preserved.
