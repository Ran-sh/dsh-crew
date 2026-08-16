把用户在本命令后输入的参数解析为 key=value 对（enabled=true|false, tier=flash|pro, effort=off|high|max, mode=auto|hub|standalone, timeout=秒数, policy=auto|flash-only|pro-only, escalate=true|false, reset），映射到 dsh_worker_config 工具参数（tier→default_tier, effort→default_effort, timeout→default_timeout_seconds, policy→tier_policy, escalate→escalate_on_failure）并调用；无参数则不带参数调用（只读）。然后用紧凑表格展示返回配置，如有修改指出改动项。不要做任何其他事。

$ARGUMENTS
