<p align="center">
  <img src="./docs/images/dsh-crew-logo.png" alt="DSH Crew" width="120" />
</p>

<h1 align="center">DSH Crew</h1>

<p align="center">
  <strong>让 Codex Desktop / Claude Code 负责统筹，把编码任务交给 DeepSeek Harness 中的 V4 Flash / Pro 子 Agent。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md"><b>简体中文</b></a>
</p>

## 功能

- Codex Desktop / Claude Code 作为主统筹 Agent
- DeepSeek V4 Flash / Pro 子 Agent
- Flash Only · Pro Only · Balanced · Review Pipeline
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
     ┌────┴────┐
     │         │
   Flash      Pro
     │         │
     └────┬────┘
          │
          ▼
   DeepSeek Harness
          │
          ▼
   DSH 当前选择的 provider
```

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
3. 保持新安装默认的 **Flash Only** 工作流：Codex → Flash 编码 worker → Codex。
4. 需要时用 **刷新 Harness 模型** 为 Flash / Pro 分别设置有序模型优先级。
5. 重启 Codex Desktop / Claude Code。

然后直接说：

- “用 ds-flash 实现这个改动。”
- “用 ds-pro 审查这个实现。”

## 模式

| 模式 | 行为 |
|---|---|
| Flash Only | 委派编码都走 Flash |
| Pro Only | 委派编码都走 Pro |
| Balanced | Flash 处理常规工作，Pro 处理高难度推理 / 审查 |
| Review Pipeline | Flash 实现，Pro 审查 |

Custom 模式可分别配置 Flash / Pro 的状态与职责。

## Provider

Crew 会读取 DeepSeek Harness 当前注册的全部 provider 与模型。Flash / Pro 分别使用不限数量的有序模型优先级；新配置默认偏好 `deepseek-v4-flash` / `deepseek-v4-pro`，并以 Harness Default 兜底。

- **Follow DSH Provider** — 从 Harness 模型目录解析各档的 provider/model 优先级（新配置默认值）。
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

## 版权与许可

本 fork 基于 [ZSeven-W](https://github.com/ZSeven-W/dsh-crew) 的原始 DSH Crew，保留原 MIT 许可与署名，并增加可配置的 Harness 模型优先级、Codex → Flash → Codex 默认链路、可审计交付等工作流能力。

MIT License —— 见 [LICENSE](LICENSE)。
