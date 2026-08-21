<p align="center">
  <img src="./docs/images/dsh-crew-logo.png" alt="DSH Crew" width="120" />
</p>

<h1 align="center">DSH Crew</h1>

<p align="center">
  <strong>让 Codex Desktop / Claude Code 负责统筹，把编码任务交给 DeepSeek Harness 中的 worker 角色（另有独立的 reviewer 角色），由可配置的 Worker Model Policy 决定用哪个模型。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md"><b>简体中文</b></a>
</p>

## 功能

- Codex Desktop / Claude Code 作为主统筹 Agent
- **角色（Role）**：worker（实现 / 修复 / 测试 / 搜索）与 reviewer（独立审查 + 结论）
- **模型策略（Model Policy）**：每个角色独立解析有序 provider/model 候选（首选 → 优先级 → 升级 → Harness Default）
- 旧版 Flash Only · Pro Only · Balanced · Review Pipeline 自动迁移到角色模型
- Follow DSH Provider
- DSH Hub 一等公民会话（Web UI 可见、异步任务带进度）
- 可选的视觉 / 生图（独立开关）

## 工作方式

```
Codex Desktop / Claude Code
          │
          ▼
       dsh-crew
          │
     Workflow（run 与 spawn 共用同一套状态机）
          │
     ┌────┴────┐
     │         │
   worker    reviewer
     │         │
  Model Policy  │  （各角色独立解析 provider/model；
  cheap→strong  │   升级基于证据：FAIL 测试、缺失交付、阻塞任务）
     │          │
     └────┬────┘
          │
          ▼
   DeepSeek Harness
          │
          ▼
   DSH 当前选择的 provider/model
```

主 Agent 决定**做什么**并负责接受 / 拒绝 / 要求修改；Workflow 决定**何时 / 状态**；
**角色**决定**谁来做**（worker 执行、reviewer 审查）；**模型策略**决定**用哪个模型**
（永不与角色绑定）；工作区隔离决定**在哪里做**（每个 coding worker 跑在独立临时
git worktree，并行 worker 不会互相踩 working tree）；验证 / reviewer 决定**是否接受**。

## 安装

前置条件：带 npm/npx 的 Node.js、Git 和 pnpm。

> **官方 Harness 隔离** — dsh-crew 安装到它自己的专用 DSH home
> （`~/.config/dsh-crew/harness`）和专用 profile（`dsh-crew`），永远不会安装
> 到官方 DSH home（`~/.dsh`）或官方 `web` profile。你的正常 DeepSeek Harness
> 安装不会被修改。

从本仓库克隆后，跨平台安装：

```bash
node scripts/setup.mjs install
```

Windows：

```bat
install.cmd
```

然后打开 **设置 → DSH Crew**，在 Codex 一行点击 **安装**。Claude Code 集成是可选项，有独立的安装按钮。

安装器会把本检出以 `@ran-sh/dsh-crew` 方式链接到专用 `dsh-crew` profile，并把 Crew Hub 指向自己的端口；不会改动官方 web profile 或任何官方凭据存储。本 fork 不发布到 npm registry。

### 更新

重新执行源码安装器：

```bash
git pull
node scripts/setup.mjs install
```

更新后重启 DSH。

### 迁移旧版 fork 安装

旧版发布把 Crew 安装进官方 DSH `web` profile，这些安装不在受支持路径内。请先用源码卸载器卸载旧版 Crew（见“卸载”），再执行上述源码安装器，它会安装到专用 Crew home/profile。

### 旧版 web-profile 命令（不支持 — 仅作参考）

旧版发布和工具曾使用直接 `--profile web` 命令把 Crew 安装进官方 DSH `web` profile。这些命令**不受支持**，不得用于新的安装、更新或卸载 — 受支持的 Crew 工具绝不会修改官方 web profile：

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:Ran-sh/dsh-crew
npx -y @deepseek-ai/dsh plugin --profile web remove @ran-sh/dsh-crew
npx -y @deepseek-ai/dsh plugin --profile web remove @zseven-w/dsh-crew
```

`ZSeven-W/dsh-crew` 是上游项目标识；本 fork 是 `Ran-sh/dsh-crew`。请改用源码安装/卸载器（`node scripts/setup.mjs install|uninstall`）。

### 从 Flash / Pro 迁移（v0.1 → v0.2 角色）

v0.2 保留所有旧配置字段继续生效。`collaboration_mode`、`tier_policy`、
`flash_state` / `pro_state`、`flash_model_priority` / `pro_model_priority`、
`escalate_on_failure`、`pro_reviews_flash` 都会被读取，迁移逻辑集中重建角色模型：

- `flash-only` → worker auto、reviewer disabled、`economy` 策略。
- `pro-only` → worker auto（强模型类）、reviewer disabled。
- `balanced` → worker auto、reviewer manual（点名时可用）。
- `review-pipeline` → worker auto + reviewer auto（`auto_review` 开启）；
  reviewer 使用旧 Pro priority。
- `escalate_on_failure` → worker 升级策略 `enabled`。
- `pro_reviews_flash` → worker 成功后自动追加一次复查。

旧的 `ds-flash` / `ds-pro` 子代理保留为**弃用别名**：它们映射到 worker 角色并带上
历史模型类提示，旧 prompt 照常可用；新 prompt 请改用 `ds-worker` / `ds-reviewer`。
同时传 role 与冲突的 legacy tier 会被明确拒绝（`ROLE_TIER_CONFLICT`），绝不静默猜测。

### 故障排查：`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`

pnpm 11 有默认供应链策略（`minimum-release-age`，24 小时）：最近一天内发布的
lockfile 条目会被拒绝，除非列入 `minimumReleaseAgeExclude`。全新 profile 安装
dsh-crew 不受影响；但如果你 profile 里已带刚发布的 DSH 插件（例如可选的
`dsh-plugin-image-mind`），安装会报此错。

解除方法：在 profile 的 `pnpm-workspace.yaml` 里加**不带版本号**的包名排除，然后重跑 add：

```yaml
# ~/.dsh/profiles/web/pnpm-workspace.yaml
minimumReleaseAgeExclude:
  - dsh-plugin-image-mind
  - '@ran-sh/dsh-vision@0.1.0'
```

注意：用不带版本的裸包名——同名多条 `pkg@version` 只认第一条（先命中先赢），可能把
新版本漏掉。排除项要放在 `pnpm-workspace.yaml`，校验器不读 `.npmrc`。该策略只针对
发布不到一天的 registry 包（git 托管的 dsh-crew 本身从不做 age 校验），所以问题通常
在 24 小时内自动消失。

## 卸载

DSH Crew 与 Codex / Claude Code 宿主集成是两层：

1. 在 **设置 → DSH Crew** 中，对已安装的 Codex / Claude Code 集成点击 **还原**。
2. 移除 profile plugin：

```bash
node scripts/setup.mjs uninstall   # Safe uninstall: see the canonical Uninstall section of README.md (official web profile is never modified).
```

只移除 profile plugin 不会隐式修改 `~/.codex` 或 `~/.claude`。Crew 配置、备份、凭据和其他 DSH bundle 都会保留。

## 开发 / 源码安装

源码安装器继续保留，供贡献者与本地 checkout 开发使用。

Windows：

```bat
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
install.cmd
```

以后更新：

```bat
git pull
install.cmd
```

跨平台：

```bash
node scripts/setup.mjs install
```

源码安装器会：

- 把本仓库以 link 方式装进 DSH web profile（`link:<repo>`）
- 安装 Codex Desktop 集成（**不需要** `codex` CLI）
- 检测到 `claude` CLI 时自动安装 Claude Code 集成（可选）
- 幂等，可安全重复执行

Windows 源码卸载：

```bat
uninstall.cmd
```

跨平台源码卸载：

```bash
node scripts/setup.mjs uninstall
```

它会移除：

- DSH web profile 中的 DSH Crew
- Codex Desktop 集成
- Claude Code 集成

它会保留：

- 仓库
- Crew 配置（`~/.config/dsh-crew`）
- 备份与凭据

## 快速开始

1. 照常启动 DSH：`npx -y @deepseek-ai/dsh web`
2. 打开 **设置 → DSH Crew**。
3. 保持新安装默认工作流：Codex → **worker** 角色 → Codex（reviewer 关闭）。
4. 需要时用 **刷新 Harness 模型** 为各角色分别设置有序模型优先级。
5. 重启 Codex Desktop / Claude Code。

然后直接说：

- “用 ds-worker 实现这个改动。”
- “用 ds-reviewer 审查这个实现。”

## 角色

- **worker** — 执行角色：实现、修复、测试、搜索、分析。任意编码请求的默认角色。它是薄派发器；后台用哪个模型由 Worker Model Policy 决定。
- **reviewer** — 独立审查角色：检查实现结果、工作区 diff、测试与风险，给出结论。默认只读，不做二次实现。
- **ds-flash / ds-pro** 保留为弃用别名（见上面的迁移说明）。

角色状态为 `disabled | manual | auto`：disabled 拒绝一切请求；manual 只在显式点名时运行；auto 可被 orchestrator 自动选择。未采用 canonical 配置时，生效状态来自旧协作模式。

## 模型策略

各角色通过实时 Harness 目录独立解析有序候选：

- attempt 0 → 角色首选（便宜 / 快）优先级；
- attempt ≥ 1 → 升级（强）优先级——升级基于**证据**（FAIL 测试、交付缺失、阻塞 / 未完成任务、工作区 diff 与 worker 报告不一致），并非只看失败，且不超 `max_attempts`（0..max-1，总尝试次数）；
- 否则 → Harness Default。

基础设施失败（缺 API key、Hub 不可达、worktree 隔离下非 Git 工作区）**不会**靠“换更强模型”解决，而是以稳定错误码失败。Flash / Pro 只作为历史模型类提示存在，不再是角色。

## 工作流

每次派发——`dsh_run_worker`（阻塞）与 `dsh_spawn_worker`（异步）、Hub 或 Standalone——都走**同一套** workflow runtime：

```
CREATED -> (繁忙时 QUEUED) -> RUNNING -> VERIFYING
  -> ESCALATING（证据驱动）-> RUNNING -> VERIFYING
  -> REVIEWING（自动审查）-> READY -> COMPLETED
  （或 FAILED / CANCELLED）
```

阻塞与异步的唯一区别是调用方是否等待。coding worker 默认在独立临时 git worktree 中执行；返回 `change candidate`（base revision、committed + 未提交 + 新增文件、有界脱敏 patch、指纹）供 orchestrator 接受 / 拒绝 / 要求修改——runtime 绝不自动合并进你的 working tree。

### 隔离

`execution.isolation` 默认为 `worktree`：worker 角色在 HEAD 的分离 worktree 上工作，主工作区永不被动（即使它是 dirty 的；未提交的主工作区改动不会混入 candidate）。如果目标工作区**不是** git 仓库，worktree 隔离任务会 **fail closed**（`NOT_GIT_REPOSITORY`）而不是静默共享——需要旧的就地行为请显式设 `execution.isolation: "shared"`。

## 模式

| 模式 | 迁移后的角色行为 |
|---|---|
| Flash Only | worker auto、reviewer disabled、economy 模型策略 |
| Pro Only | worker auto（强模型类）、reviewer disabled |
| Balanced | worker auto、reviewer manual（点名时可用） |
| Review Pipeline | worker auto + reviewer auto（`auto_review` 开启） |

Custom 模式可分别配置 worker / reviewer 状态。

## Provider

Crew 会读取 DeepSeek Harness 当前注册的全部 provider 与模型。各角色独立解析候选：**worker** 使用首选（便宜）优先级 + 升级（强）模型池，**reviewer** 有独立审查优先级——旧版新鲜偏好为 `deepseek-v4-flash` / `deepseek-v4-pro`，以 Harness Default 兜底。

- **Follow DSH Provider** — 从 Harness 目录解析角色的 provider/model 优先级（新配置默认值）。
- **DeepSeek Official** — 为兼容旧配置保留内置固定路由。

凭据始终由 DSH 的 provider 配置管理。已在 OpenAI 兼容的 OpenCode Go 网关实测。Standalone 模式（无 DSH 运行）始终使用 DeepSeek Official + `DEEPSEEK_API_KEY`。

## 宿主

- **Codex Desktop** 通过共享的 `~/.codex` 配置直接受支持，**不要求** `codex` CLI；CLI 只是可选的补充宿主 / 管理接口。
- **Claude Code** 为可选；一键安装检测到 Claude CLI 时自动安装其集成。

## 备注

- Main Agent Mode 是路由指引，不是对宿主工具的硬沙箱。
- Standalone 只使用 DeepSeek Official。
- Crew Vision 的工具注册改动可能需要重启 DSH。
- 集成内容改动后请重启 Codex Desktop。
- 每个 worker 都会返回可审查的交付报告（`## Diff` / `## Tests` / `## Risks`），隔离候选捕获有界、脱敏的 patch，方便在接受前核对改动。
- 阻塞与异步任务执行**同一套** workflow（证据驱动升级 + 自动审查）；异步只是立刻返回 workflow id 并在后台继续。
- `dsh_worker_status` / `dsh_worker_result` / `dsh_worker_cancel` 以 workflow id（`wf-…`）为主；旧的 `hub-…` / `job-…` id 仍兼容。
- Standalone 以 `node <dsh-sdk-jsonrpc-demo/lib/bin.js>` 启动 worker（Windows 安全；pnpm 的 `.bin` sh shim 无法被 Node spawn）。Standalone 默认 DeepSeek Official + `DEEPSEEK_API_KEY`，但支持 `DEEPSEEK_BASE_URL`——已配置在 `~/.dsh` 的 OpenAI 兼容网关（如 `opencode-*`）可通过同时设置这两个环境变量来支撑 Standalone worker。
- 设置 UI 在本过渡构建里仍展示旧的 Flash/Pro 兼容控件；新 worker/reviewer 角色策略与 `execution.isolation` 的写回是后续项。

## 版权与许可

本 fork 基于 [ZSeven-W](https://github.com/ZSeven-W/dsh-crew) 的原始 DSH Crew，保留原 MIT 许可与署名，并增加可配置的 Harness 模型优先级、worker/reviewer 角色、统一任务工作流、git worktree 隔离、可审计交付等工作流能力。

MIT License —— 见 [LICENSE](LICENSE)。
