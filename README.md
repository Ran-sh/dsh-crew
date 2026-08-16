# dsh-crew

把子任务派给 **DeepSeek V4 Flash / V4 Pro** 驱动的 **DSH worker**，同时保住 Claude Code / Codex 的**原生子代理进度 UI**。

Orchestrator（Opus / GPT，模型随你在宿主里选）完全不动；worker 是真正的 DSH agent（自带 bash / fs / todo 工具与沙箱），按任务选模型与 reasoning effort。

```
Claude Code / Codex (orchestrator, 模型不变)
  └─ ds-flash / ds-pro  ← 原生子代理壳（进度出现在原生任务 UI）
       └─ MCP: dsh_run_worker(tier, effort, cwd)
            └─ dsh-jsonrpc-agent runtime (worker.cordis.yml)
                 └─ DeepSeek V4 Flash / Pro（DSH SDK，事件流→进度/token 统计）
```

## 背景与术语

- **DSH**（DeepSeek Harness）：DeepSeek 的开源 agent harness，Web UI 形态的编码代理，类似 Claude Code 但驱动 DeepSeek 模型。
- **MCP**（Model Context Protocol）：Anthropic 的 AI 工具接入协议，让 LLM 安全调用外部工具与数据源。
- **Cordis bundle**：DSH 的插件格式，本项目既可作独立 MCP 服务，也可装进 DSH Web 成为 hub 模式。
- **tier**：工作量档次，`flash`=V4 Flash（快而省，适合简单任务），`pro`=V4 Pro（强推理，适合复杂问题）。

## 准备

1. **安装依赖**
   ```bash
   pnpm install
   ```
   若沙箱/pty 报原生模块问题，跑一次 `pnpm approve-builds`。

2. **配置 API 凭据**
   - 建立配置目录：
     ```bash
     mkdir -p ~/.config/dsh-crew
     ```
   - 从 [platform.deepseek.com](https://platform.deepseek.com) 获取 API key。
   - 新建 `~/.config/dsh-crew/.env` 写入：
     ```
     DEEPSEEK_API_KEY=sk-...
     ```
     （worker runtime 独立于 Web 版 DSH 的凭据体系）

3. **验证配置成功**
   ```bash
   node scripts/smoke.mjs
   ```
   会真实派发一个最小 flash 任务；十几秒内看到 `smoke test passed — configuration OK` 即配置成功（失败时会打印具体原因，常见是 key 未填或无效）。

## Claude Code

一键安装（推荐，二选一）：

- **DSH 设置页**（已装 hub 模式时）：设置 → DSH Crew → "安装到 Claude Code"；
- **命令行**：`node src/install/cli.mjs all`。

两者做同样的事：注册本地 marketplace（父目录 `dsh-plugins/` 为 marketplace 根）+ `claude plugin install` + 五个 MCP 工具的权限白名单 + claude-hud 的 `--extra-cmd` worker 段接线（改动前自动备份 settings.json，幂等）。装完**重启会话**生效。

- 得到子代理 `ds-flash`（简单任务）/ `ds-pro`（难任务），对话里直接说"把 X 派给 ds-pro"即可；派发数量与状态显示在原生任务 UI。
- HUD/statusline 实时段：`⚙dsh 1▶pro 2m14s 21.7k/606 ✓3`（在跑的档位/耗时/token + 完成计数）。用 claude-hud 之外的 statusline 时，可直接用 `statusline/statusline.sh` 或把 `statusline/worker-segment.sh` 嵌进你自己的脚本。
- 本地开发调试可用 `claude --plugin-dir /path/to/dsh-crew` 临时加载。
- 长任务：CC 对 MCP 调用有超时（`MCP_TOOL_TIMEOUT` 可调）；超长任务让 orchestrator 用 `dsh_spawn_worker` + `dsh_worker_result(wait_seconds)` 轮询。

## Codex

```sh
cp codex/agents/*.toml ~/.codex/agents/    # 全局，或放 <project>/.codex/agents/
```

- 角色文件内已带 MCP server 挂载 + `default_tools_approval_mode = "approve"`（**必须**，否则 exec 模式下工具调用被自动取消）+ `tool_timeout_sec = 3600`。
- 交互 TUI 里 "spawn ds-pro to ..." 即派发，Active/Done 面板可见；`codex exec` 也可直接调 `dsh_run_worker`。
- 注意 role 文件中 `args` 的绝对路径需按实际安装位置修改。

## MCP 工具

| 工具 | 说明 |
|---|---|
| `dsh_run_worker` | 阻塞式：派任务（`tier`: flash/pro，`effort`: off/high/max，`cwd`），等结果 |
| `dsh_spawn_worker` | 异步派发，返回 job id（并行 fan-out 用） |
| `dsh_worker_status` | 全部 job 的实时进度（turn/step/当前工具/token） |
| `dsh_worker_result` | 取结果，可 `wait_seconds` 等待 |
| `dsh_worker_cancel` | 取消（终止该 job 的 runtime 进程） |

进度同时镜像到 `~/.config/dsh-crew/status.json`（statusline / 外部监控可读）。

## Hub 模式（DSH bundle）

本包同时是合法的 DSH bundle（`dsh.bundle` + `cordis.patch.yml`）。`dsh plugin add dsh-crew` 装进 web profile 后，host 内挂载 workers-hub：

- worker 以**一等公民会话**跑在 DSH host 里（`agents.create` + per-session model/effort waterfall + 默认 preset），**出现在 Web UI 会话列表**，可随时点开围观完整过程；
- loopback jobs API：`POST/GET /_dsh/dsh-crew/jobs`（spawn/列表/长轮询结果/cancel）、`/ping`、`POST /_dsh/dsh-crew/install`（一键安装 CC/Codex 集成，即 `src/install/` 的后端）；
- CC/Codex 的 MCP shim 自动探测 hub（`DSH_CREW_HUB`，默认 `http://127.0.0.1:3080`）：DSH 在跑 → job 进 host（`mode: "hub"`）；没跑 → 回落 standalone runtime。

> 架构决策、实现细节与踩坑记录不随仓库分发，见团队文档中心的 **dsh-plugin** 页。

## 方案选择与限制

### 日常订阅用户→壳 subagent 方案（推荐默认）

- **现状**：CC 壳子代理用 haiku 中转，每次派发多花几百~几千 token。
- **权衡**：用少量 Anthropic token 换取原生任务 UI、进度实时显示、无需额外配置。
- **建议**：如果你已订阅 Claude Pro 或用 CC，用这套——省事且透明。

### 按量付费/CI 环境→Router 直连方案

- **现状**：CC 子代理的 frontmatter 不支持直连第三方模型；本仓库 scratchpad 里的 router 实验方案需要 API-key 计费的 CC，但订阅 OAuth 会被 Anthropic 上游 403。
- **建议**：
  - 如果用 API-key 凭据（非 OAuth）且想省 Anthropic token，可在本地跑 router 直连 DeepSeek；
  - CI 环境通常也是 API-key，该方案更经济（全部用 DeepSeek token）。
  - 需要自行测试 router 集成（非官方支持）。

### 跑着 DSH Web→Hub 模式自动启用

- **现状**：若 `dsh plugin add dsh-crew` 装进 DSH Web profile，job 以一等公民会话跑在 host 里，出现在 Web UI 会话列表。
- **建议**：本地开发迭代时推荐启用 hub 模式，worker 进度可在 Web UI 完整围观；跨机器协作或无 Web UI 环境用 CC/Codex 壳方案。

### 其他已知事项

- Codex 角色理论上可试 `model_provider` 直指 DeepSeek（未验证）；本桥不依赖它。
