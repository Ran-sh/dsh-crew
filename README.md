# DSH Crew

<!-- logo: assets/logo.png（设计中，待补） -->

把子任务派给 **DeepSeek V4 Flash / V4 Pro** 驱动的 **DSH worker**，同时保留 Claude Code / Codex 的**原生子代理进度 UI**。

![DSH Crew 设置页](assets/settings-panel.png)

*上图为 DSH 设置页里的 DSH Crew 配置面板。*

```
Claude Code / Codex (orchestrator，模型随宿主选择)
  └─ ds-flash / ds-pro  ← 原生子代理壳（进度显示在任务 UI）
       └─ MCP: dsh_run_worker(tier, effort, cwd)
            └─ dsh-jsonrpc-agent runtime (worker.cordis.yml)
                 └─ DeepSeek V4 Flash / Pro（DSH SDK，事件流→进度/token 统计）
```

## 功能一览

- **原生进度 UI**：子代理派发、执行进度、token 统计实时显示在 Claude Code / Codex 的任务面板
- **灵活档位选择**：Flash（快速、经济）/ Pro（强推理），按任务需要选模型
- **推理强度配置**：effort 可选 `off` / `high` / `max`，满足不同复杂度需求
- **预设与失败升档**：按 tier 挂载 Agent 预设，支持任务失败自动升档重试
- **Hub 模式**：worker 会话显示在 DSH Web UI，按工作目录归类管理
- **可视化配置**：DSH 设置页集中配置多模态、Provider、API 凭据等
- **多模态桥接**：
  - 看图（`describe_image`）：借用 Claude / Codex / Grok / Antigravity 视觉能力
  - 出图（`generate_image`）：调用 Codex / Grok / Antigravity 生图 API 或自定义 CLI
  - 会话贴图：DSH 里贴图自动转文字供模型理解
  - 自定义 Provider：支持 OpenAI 兼容 API 与本地命令，附连通测试
- **状态栏实时段**：Claude Code statusline 显示运行中的 worker 档位、耗时、token 统计（需 claude-hud）

## 准备

### 1. 安装依赖

```bash
pnpm install
```

若沙箱/pty 报原生模块问题，跑一次：

```bash
pnpm approve-builds
```

### 2. 配置 DeepSeek API 凭据

建立配置目录：

```bash
mkdir -p ~/.config/dsh-crew
```

从 [platform.deepseek.com](https://platform.deepseek.com) 获取 API key，创建 `~/.config/dsh-crew/.env` 写入：

```
DEEPSEEK_API_KEY=sk-...
```

（worker runtime 独立于 Web 版 DSH 的凭据体系；这个 key 只读 `.env`，不会写进别处）

### 3. 验证配置

```bash
node scripts/smoke.mjs
```

十几秒内看到 `smoke test passed — configuration OK` 即表示配置成功。失败时会打印具体原因，常见是 API key 未填或无效。

## 背景与术语

- **DSH**（DeepSeek Harness）：DeepSeek 的开源 agent harness，Web UI 形态的编码代理，类似 Claude Code 但驱动 DeepSeek 模型。
- **MCP**（Model Context Protocol）：Anthropic 的 AI 工具接入协议，让 LLM 安全调用外部工具与数据源。
- **Cordis bundle**：DSH 的插件格式，本项目既可作独立 MCP 服务，也可装进 DSH Web 成为 hub 模式。
- **tier**：工作量档次，`flash` = V4 Flash（快速省成本，适合简单任务），`pro` = V4 Pro（推理能力强，适合复杂问题）。
- **effort**：推理强度，`off` = 不用推理，`high` = 高投入推理，`max` = 最大推理投入。

## Claude Code

### 安装

一键安装（二选一）：

- **DSH 设置页**（已装 hub 模式时）：设置 → DSH Crew → "安装到 Claude Code"
- **命令行**：`node src/install/cli.mjs all`

两者做同样的事：注册本地 marketplace（父目录 `dsh-plugins/` 为 marketplace 根） + `claude plugin install` + MCP 工具权限白名单 + claude-hud worker 状态段配置（改动前自动备份 settings.json，幂等）。**安装后重启会话生效**。

### 使用

- 直接在对话中说 "把 X 派给 ds-flash" 或 "把 X 派给 ds-pro"，子代理会执行任务
- 派发数量与实时进度显示在 Claude Code 的任务 UI
- **HUD 状态栏段**：`⚙dsh 1▶pro 2m14s 21.7k/606 ✓3`（当前档位 / 耗时 / token 占用 / 完成计数）
  - 本地开发用 `statusline/statusline.sh` 或 `statusline/worker-segment.sh` 可独立集成
- **超长任务**：CC 对 MCP 调用有超时限制（`MCP_TOOL_TIMEOUT` 可调），长任务可让 orchestrator 用 `dsh_spawn_worker` + `dsh_worker_result(wait_seconds)` 轮询
- **本地开发调试**：`claude --plugin-dir /path/to/dsh-crew` 临时加载

## Codex

### 安装

推荐用安装器（自动按本机路径渲染，并复制 `/dsh-config`、`/dsh-status` 命令）：

```bash
node src/install/cli.mjs codex
```

或手工复制（复制后需自行修改路径）：

```bash
cp codex/agents/*.toml ~/.codex/agents/    # 全局或项目级 .codex/agents/
```

角色文件内已预配：

- MCP server 挂载配置
- `default_tools_approval_mode = "approve"`（**必须**，否则 exec 模式下工具调用被自动取消）
- `tool_timeout_sec = 3600`

**注意**：手工复制时，role 文件中 `args` 的绝对路径需按实际安装位置修改；用安装器则无需手改。

### 使用

- 交互 TUI 里选 "spawn ds-pro to ..." 派发任务，Active/Done 面板显示进度
- `codex exec` 模式也可直接调 `dsh_run_worker`

## MCP 工具

| 工具 | 说明 |
|---|---|
| `dsh_run_worker` | 阻塞式派任务（`tier`: flash/pro，`effort`: off/high/max，`cwd`），等返回结果 |
| `dsh_spawn_worker` | 异步派发任务，返回 job id（用于并行 fan-out） |
| `dsh_worker_status` | 查询全部 job 的实时进度（turn/step/当前工具/token） |
| `dsh_worker_result` | 取结果，可指定 `wait_seconds` 等待 |
| `dsh_worker_cancel` | 取消指定 job，终止其 runtime 进程 |

进度同时镜像到 `~/.config/dsh-crew/status.d/`（每个写入方一个分片文件，statusline / 外部监控可读）。

## 多模态：视觉与生图

**DeepSeek 是纯文本模型**，不支持图片输入与生图输出。本插件通过 MCP 工具把这两项能力外借过来：

| 工具 | 说明 |
|---|---|
| `describe_image` | 看图回答问题（截图、设计稿、图表等），结果按 provider + 模型 + 图片 + 问题缓存 |
| `generate_image` | 按文字描述出图，保存到指定绝对路径；输出为平面位图（需要图层编辑用 OpenPencil） |

**会话贴图**：在 DSH 里把模型切到 `DeepSeek (视觉) ◉` 即可直接贴图。图片会留在会话里正常显示，插件在其后附上一段转写文字，并在发送前把图片剥离——你看图、模型读字。

### 配置

在 **DSH 设置页 → DSH Crew → 多模态**（或直接编辑 `~/.config/dsh-crew/config.json`）配置：

**视觉 provider**（看图）：

- `claude-code`（默认，用 haiku，便宜）
- `codex`（用 GPT，可指定具体模型）
- `grok`（用 Grok）
- `agy`（Antigravity）
- `自定义`（OpenAI 兼容 API 或本地命令）
- `off`（禁用）

**生图 provider**（出图）：

- `codex`（`$imagegen`，gpt-image-2）
- `agy`（Nano Banana）
- `grok`（Imagine）
- `自定义`（OpenAI 兼容 API 或本地命令）
- `off`（禁用）

### 自定义 Provider

两种接入方式：

**API**：任何 OpenAI 兼容端点
- 填 Base URL、API Key、模型列表
- 视觉走 `/chat/completions` 图片 base64 内联
- 生图走 `/images/generations`
- **必须填"生图模型"才具备生图能力**，否则该 provider 只出现在视觉选择里

**CLI**：本地命令模板，占位符经安全引用后代入
- 视觉：`{image} {question} {model}` → stdout 作为答案
- 生图：`{prompt} {output} {size}` → 命令须写出文件到 `{output}`
- 两条命令至少填一条；填了哪条就具备哪项能力

**连通测试**：每个自定义 provider 都有测试按钮
- API：检查端点可达性、鉴权，真发一次视觉请求验证
- CLI：检查可执行文件，真跑一次命令验证
- 生图：仅校验配置，不实际出图

**借用的订阅 CLI**（claude / codex / grok / agy）需要你本机已登录，插件不会替你绕过它们的权限。

## Hub 模式

本包同时是合法的 DSH bundle（`dsh.bundle` + `cordis.patch.yml`）。执行 `dsh plugin add dsh-crew` 装进 DSH Web profile 后：

- **Worker 会话一等公民化**：以 first-class session 运行在 DSH host 里（`agents.create` + per-session model/effort waterfall + 默认 preset），出现在 Web UI 会话列表，随时可点开围观完整执行过程
- **按工作目录归类**：Web UI 中按 cwd 管理 worker 会话
- **Loopback API**：
  - `POST/GET /_dsh/dsh-crew/jobs`：spawn 任务、列表、长轮询结果、cancel
  - `GET /_dsh/dsh-crew/ping`：健康探测（MCP shim 靠它判断 hub 是否在跑）
  - `POST /_dsh/dsh-crew/install`：一键安装 Claude Code / Codex 集成（即 `src/install/` 的后端）
- **自动探测**：CC/Codex 的 MCP shim 自动探测 hub（`DSH_CREW_HUB` 环境变量，默认 `http://127.0.0.1:3080`）
  - DSH Web 在跑 → job 进 hub 模式（`mode: "hub"`）
  - 没跑 → 回落 standalone runtime

## 方案选择与限制

### 日常订阅用户 → 壳 subagent 方案（推荐）

- **现状**：Claude Code 壳子代理用 haiku 中转，每次派发多花几百~几千 token
- **权衡**：用少量 Anthropic token 换取原生任务 UI、进度实时显示、无需额外配置
- **建议**：如果你已订阅 Claude Pro 或用 Claude Code，用这套——省事且透明

### 按量付费 / CI 环境 → Router 直连方案

- **现状**：Claude Code 子代理的 frontmatter 不支持直连第三方模型；本仓库 scratchpad 里的 router 实验方案需要 API-key 凭据的 Claude Code，但订阅 OAuth 会被 Anthropic 上游 403
- **建议**：
  - 如果用 API-key 凭据（非 OAuth）且想省 Anthropic token，可在本地跑 router 直连 DeepSeek
  - CI 环境通常也是 API-key，该方案更经济（全部用 DeepSeek token）
  - 需要自行测试 router 集成（非官方支持）

### 跑着 DSH Web → Hub 模式自动启用

- **现状**：若 `dsh plugin add dsh-crew` 装进 DSH Web profile，job 以一等公民会话跑在 host 里，出现在 Web UI 会话列表
- **建议**：本地开发迭代时推荐启用 hub 模式，worker 进度可在 Web UI 完整围观；跨机器协作或无 Web UI 环境用 Claude Code / Codex 壳方案

### 已知事项

- Codex 角色理论上可试 `model_provider` 直指 DeepSeek（未验证）；本桥不依赖它
- 生图输出为平面位图，需要分层编辑用 OpenPencil
- **运行时依赖**：仅 `@modelcontextprotocol/sdk` 与 `zod`；`@deepseek-ai/*` 为 peerDependencies（由 DSH 宿主提供）
- **Codex 必须配置**：`default_tools_approval_mode = "approve"`，否则工具调用被自动取消

---

架构决策、实现细节与踩坑记录不随仓库分发，见团队文档中心的 **dsh-plugin** 页。
