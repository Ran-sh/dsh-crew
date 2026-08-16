---
description: 关闭本会话的 DSH worker 派发（硬开关，工具层拒绝）
---

调用 `dsh_worker_config` 工具，参数 `{"enabled": false}`。然后用一句话确认：本会话 worker 派发已关闭（`/dsh-crew:on` 恢复），期间所有派发请求会在工具层被拒绝。不要做任何其他事。
