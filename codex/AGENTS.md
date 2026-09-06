# Global capability-aware delegation policy

The main Codex agent owns the task through final delivery. DSH Crew is an optional
execution/review capability, not an automatic replacement for the main agent.

## Discover and choose

Before substantial delegation, read the live Crew configuration, capability and
readiness contracts. Discover roles, models, modes and constraints dynamically;
installed, configured, enabled and callable are different states. Refresh the
snapshot after relevant configuration or availability changes, not every small step.

Delegate bounded, independently verifiable units when isolation, specialization,
parallel work or independent review provides a benefit. Give each unit its objective,
owned files, workspace, constraints and acceptance evidence. Respect concurrency
limits and manual/disabled capabilities. Keep ambiguity, integration, external
effects and final communication in the main agent. Trivial work stays local.

## Operator decision gate when DSH Crew is unavailable

Once Crew is selected for a work unit, any required capability becoming unavailable
or non-callable is a mandatory pause, regardless of cause. Do not implement further,
repair/reconfigure Crew, silently fall back or switch execution paths. Perform only
bounded read-only diagnosis, report the evidence and completed work, and wait for
new operator direction: **repair Crew and continue through Crew**, or **do not repair
Crew and continue with the main agent**. After repair, verify live readiness again;
after local authorization, disclose that the affected work is not independently delegated.

This gate does not apply when initial planning chooses local work without selecting
Crew. A nonterminal wait is not an outage; continue the same workflow without duplicate
dispatch. Review findings and failing code tests are task results to address, not by
themselves evidence that Crew is unavailable.

## Verify and finish

Consume compact structured results and canonical events. Check changed scope,
delivery completeness, tests, risks and the actual review verdict. Use independent
review for non-trivial code when available and its invocation policy allows it;
never bypass manual/disabled review. Requested changes or missing evidence are not
approval. If selected review cannot run, use the operator gate above.

Continue authorized work after a successful subtask; do not stop at its checkpoint.
Delegation grants no new authority to push, publish, message, change credentials or
delete data. Do not forward credentials, raw provider payloads or unbounded transcripts.

## Harness upgrade redlines

- Never install, update, register, unlink, repair, or mutate anything under ~/.dsh.
- DSH Crew runtime upgrades must go through the Crew-owned installer and DSH_HOME.
- Never use direct pnpm/npm/dsh plugin operations against the official web profile.
- Preparing a Harness upgrade must not restart 3080 or 3210.
- Standalone workers launch through the official DSH SDK profile contract; dsh-sdk-jsonrpc-demo is obsolete.
- Legacy 3080 bridge must never be used for 3210 lifecycle/restart/rollback.
