Read or update this session with dsh_worker_config. With no arguments, pass {}.
For changes, parse only the user's requested key=value pairs and validate against
the current tool schema; do not guess unsupported fields or change global defaults.

Aliases → tool fields:
- enabled → enabled; tier → default_tier; effort → default_effort
- mode → mode; timeout → default_timeout_seconds; policy → tier_policy
- escalate → escalate_on_failure; collab → collaboration_mode; main → main_agent_mode
- flash → flash_state; pro → pro_state; review → pro_reviews_flash
- reset → reset: true

Current writable modes are auto|hub; standalone is legacy read/migration only.
Crew effort is off|high|max, not the host model's reasoning setting.
Other values must match the live schema. Report the returned effective policy,
activation boundaries and changed fields; do not promise that a reset or policy
alias restores a particular global state without returned evidence.
Use a compact response in the user's language. No unrelated actions.

$ARGUMENTS
