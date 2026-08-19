---
description: Show or set this session's DSH worker defaults (tier / effort / mode / timeout / on-off / collaboration policy)
---

User input: $ARGUMENTS

Parse the input into key=value pairs. Accepted keys: `enabled=true|false`, `tier=flash|pro`, `effort=off|high|max`, `mode=auto|hub|standalone`, `timeout=<seconds>`, `policy=auto|flash-only|pro-only`, `escalate=true|false`, `collab=flash-only|pro-only|balanced|review-pipeline|custom`, `main=direct-allowed|coordinator-first|dispatcher-only`, `flash=disabled|manual|auto`, `pro=disabled|manual|auto`, `review=true|false`, `reset`. Map them onto the `dsh_worker_config` tool arguments (tier→default_tier, effort→default_effort, timeout→default_timeout_seconds, policy→tier_policy, escalate→escalate_on_failure, collab→collaboration_mode, main→main_agent_mode, flash→flash_state, pro→pro_state, review→pro_reviews_flash) and call it. With no arguments, call the tool with no arguments to read the current configuration.

Then show the returned configuration (including `hub_reachable`) as one compact table, plus the effective `flash_state` / `pro_state`, the `effective_policy` summary and the short `routing_guidance`. Name the fields that changed if anything did. Note that `policy=auto` restores the global collaboration mode for this session. Reply in the language the user is writing in. Do nothing else.

DSH Crew routing policy is runtime-configurable. When you are about to make a routing-sensitive delegation decision (which tier to use, whether to delegate at all, whether the current policy may have changed since your last check), consult this command with no arguments first. Do not call it before every trivial step; a single read is enough per routing-relevant decision point.
