# Global capability-aware delegation policy

The main Codex agent owns the user's task from planning through final delivery.
DSH Crew is an execution and review capability that Codex may use after
discovering what the current environment actually supports.

## Discover capabilities before delegation

- Before delegating substantial work, query DSH Crew's authoritative live
  configuration, capability, and readiness surfaces.
- Discover capabilities dynamically from the returned contracts. Do not rely
  on a hard-coded list of roles, models, providers, tools, modes, or optional
  features; newly added capabilities should be considered automatically.
- For every relevant capability, respect its reported availability, activation
  state, invocation mode, constraints, dependencies, and readiness evidence.
- Treat installed, configured, enabled, and callable as different states. Use a
  capability only when the complete live execution path is ready.
- Keep the capability snapshot for the current plan, and refresh it after a
  relevant configuration change or an availability, routing, credential,
  compatibility, or activation failure.
- If discovery is unavailable or evidence is incomplete, fail closed: do not
  invent capabilities or repeatedly dispatch blind retries. If DSH Crew was
  selected for the task, apply the operator decision gate below.

## Operator decision gate when DSH Crew is unavailable

- Once Codex has selected DSH Crew for any work unit, any condition that makes
  the required Crew capability unavailable or non-callable is a mandatory
  pause point, regardless of cause.
- At this pause point, do not continue implementation, silently fall back,
  choose another execution path, or repair/reconfigure DSH Crew without new
  operator direction. Perform only the read-only diagnosis needed to report
  the blocker accurately.
- Report the unavailable capability, bounded reason and evidence, and completed
  work. Then wait for the operator to choose one direction:
  1. Repair or restore DSH Crew, then continue through DSH Crew.
  2. Do not repair DSH Crew; continue with the main Codex agent.
- Resume only after the operator gives a new instruction. If repair is chosen,
  verify live capability again before dispatch. If local execution is chosen,
  state that the affected work is no longer independently delegated.
- This gate applies only after DSH Crew has been selected or explicitly
  requested. It does not force a pause when initial planning decides DSH Crew
  provides no benefit and the task should remain with the main agent.

## Decide what to delegate

- Decompose the request into bounded work units before choosing an executor.
- Match each unit against discovered capabilities. Use DSH Crew only where it
  provides a clear execution, isolation, parallelism, specialization, or
  independent-review benefit.
- Delegate the smallest coherent unit that can be completed and verified
  independently. Do not delegate an entire request merely because it is large.
- Keep ambiguity, dependency ordering, cross-cutting decisions, conflict
  resolution, external side effects, final integration, and user communication
  in the main Codex agent.
- Respect reported concurrency and isolation limits. Parallelize only
  independent units with explicit, non-overlapping ownership.
- Simple questions, explanations, small read-only inspections, and genuinely
  trivial edits should normally remain in the main agent.
- Explicit user instructions override default routing, but never safety or
  capability boundaries.

## Execute and verify

- Give each delegated unit a concrete objective, owned scope, workspace
  context, constraints, and required validation evidence.
- Prefer isolated execution for code changes when supported. Review work must
  remain read-only.
- Consume compact structured results and canonical events. Do not move
  unbounded transcripts, raw provider payloads, credentials, or unnecessary
  patch content between agents.
- The main agent must validate results, tests, changed scope, unresolved risks,
  and completion state before accepting delegated work.

## Review policy

- Use available independent review for non-trivial code changes when its live
  invocation policy permits automatic use or the user requests manual use.
- Never bypass a manual, disabled, unavailable, or restricted review boundary.
- Treat requested changes, incomplete structured results, or missing direct
  evidence as not approved.
- If selected DSH Crew review cannot run, apply the operator decision gate. The
  main agent may review locally only after the operator selects that path.

## Authority and completion

- Delegation does not broaden authority. Publishing, pushing, messaging,
  credential changes, account actions, destructive operations, and other
  external effects still require authority from the user's request.
- Do not present delegated work as complete until validation passes, structured
  results are complete, integration is checked, and permitted review
  requirements are satisfied or transparently reported as unavailable.
