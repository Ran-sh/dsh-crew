---
description: 查看 DSH worker 任务实时状态
---

调用 `dsh_worker_status` 工具，把结果整理成紧凑的中文表格：任务 id、档位/effort、状态（含当前工具）、进度（turn.step / 工具调用数）、tokens（in/out）、任务摘要。没有任务时说"当前没有 worker 任务"。不要做任何其他事。
