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

前置条件：带 npm/npx 的 Node.js、Git 和 pnpm。我们分别从命令环境中移除这些前置项做过真实测试：DSH 需要 `npx`，其 profile 转发器会直接调用 Git 和 `pnpm`。

在任意目录直接从本 GitHub 仓库安装：

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:Ran-sh/dsh-crew
```

启动 DSH：

```bash
npx -y @deepseek-ai/dsh web
```

然后打开 **设置 → DSH Crew**，在 Codex 一行点击 **安装**。Claude Code 集成是可选项，有独立的安装按钮。

Crew 会持久安装在 DSH 的 `web` profile 中。本 fork 不发布到 npm registry；`npx` 只负责运行 DSH CLI，再由 DSH 从 GitHub 安装 Crew。

### 更新

重新执行 GitHub add 命令。DSH/pnpm 会刷新 Git revision，不会重复添加 dependency 或 bundle：

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:Ran-sh/dsh-crew
```

更新后重启 DSH。

### 迁移旧版 fork 安装

旧版 fork 曾使用上游包名 `@zseven-w/dsh-crew`。仅凭包名无法区分本 fork 与真正的上游包，因此不会自动迁移。

只有在确认旧包来自 `Ran-sh/dsh-crew` 时，才执行：

```bash
npx -y @deepseek-ai/dsh plugin --profile web remove @zseven-w/dsh-crew
npx -y @deepseek-ai/dsh plugin --profile web add github:Ran-sh/dsh-crew
```

如果 `@zseven-w/dsh-crew` 是你有意安装的上游原版，请不要移除它。

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
npx -y @deepseek-ai/dsh plugin --profile web remove @ran-sh/dsh-crew
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
- attempt ≥ 1 → 升级（强）优先级——升级基于**证据**（FAIL 测试、交付缺失、阻塞 / 未完成任务、工作区 diff 与 worker 报告不一致），并非只看失败，且不超 `max_attempts`；
- 否则 → Harness Default。

Flash / Pro 只作为历史模型类提示（`deepseek-v4-flash` / `deepseek-v4-pro`）存在，不再是角色。

## 模式

| 模式 | 迁移后的角色行为 |
|---|---|
| Flash Only | worker auto、reviewer disabled、economy 模型策略 |
| Pro Only | worker auto（强模型类）、reviewer disabled |
| Balanced | worker auto、reviewer manual（点名时可用） |
| Review Pipeline | worker auto + reviewer auto（`auto_review` 开启） |

Custom 模式可分别配置 worker / reviewer 状态。

## Provider

Crew 会读取 DeepSeek Harness 当前注册的全部 provider 与模型。Flash / Pro 各自使用不限数量的有序模型优先级；新配置默认偏好 `deepseek-v4-flash` / `deepseek-v4-pro`，并以 Harness Default 兜底。

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
- 每个 worker 都会返回一份可审查的交付报告（`## Diff` / `## Tests` / `## Risks`），并由 hub 捕获一份只读、已脱敏、仅存内存的工作区 diff，方便你在接受结果前核对改动内容。
- 阻塞（`dsh_run_worker`）与异步（`dsh_spawn_worker`）任务共用同一套工作流状态机与证据规则；异步升级 / 复查通过相同的结构化 outcome 暴露。
- coding worker 默认以独立临时 git worktree 执行，并行任务不会写同一个 working tree；orchestrator 收到变更候选（base revision、name status、有界脱敏 patch）后再决定是否接受。

## 版权与许可

本 fork 基于 [ZSeven-W](https://github.com/ZSeven-W/dsh-crew) 的原始 DSH Crew，保留原 MIT 许可与署名，并增加可配置的 Harness 模型优先级、worker/reviewer 角色、统一任务工作流、git worktree 隔离、可审计交付等工作流能力。

MIT License —— 见 [LICENSE](LICENSE)。
