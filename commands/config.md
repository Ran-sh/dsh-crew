---
description: 查看或设置本会话的 DSH worker 配置（默认档位/effort/模式/超时/开关）
---

用户输入：$ARGUMENTS

把用户输入解析为 key=value 对（可用键：enabled=true|false, tier=flash|pro, effort=off|high|max, mode=auto|hub|standalone, timeout=秒数, policy=auto|flash-only|pro-only, escalate=true|false, reset）。映射到 `dsh_worker_config` 工具的参数（tier→default_tier, effort→default_effort, timeout→default_timeout_seconds, policy→tier_policy, escalate→escalate_on_failure）后调用它；如果没有任何参数，就不带参数调用（只读当前配置）。

然后用一个紧凑的中文表格展示返回的完整配置（含 hub_reachable），如果本次有修改，指出改了哪几项。不要做任何其他事。
