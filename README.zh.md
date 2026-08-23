<p align="center">
  <img src="./docs/images/dsh-crew-logo.png" alt="DSH Crew" width="120" />
</p>

<h1 align="center">DSH Crew</h1>

<p align="center">
  <strong>让 Codex Desktop 或 Claude Code 做总控，把编码任务分发给隔离运行的 DeepSeek Harness worker 与 reviewer。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md"><b>简体中文</b></a>
</p>

## 它做什么

DSH Crew 在你的编码宿主和 DeepSeek Harness 之间增加一层轻量编排：

- **worker** — 实现、修复、测试、搜索、分析；
- **reviewer** — 独立审查 worker 的结果并给出结论；
- **模型策略** — 每个角色独立解析 provider / model 优先级，并可按证据升级；
- **隔离执行** — 编码 worker 默认运行在临时 git worktree；
- **实时任务** — Hub 可查看进度、结果、取消、路由轨迹和 readiness 信息。

```text
Codex Desktop / Claude Code
            │
            ▼
         DSH Crew
       ┌────┴────┐
       │         │
    worker    reviewer
       │         │
       └────┬────┘
            ▼
     DeepSeek Harness
```

## 安装

需要：**Node.js**（编码 worker 隔离需要 **Git**）。

推荐直接通过 npm/npx 管理，无需克隆仓库：

```bash
npx @ran-sh/dsh-crew@latest install
```

后续管理使用同一 CLI：

```bash
npx @ran-sh/dsh-crew@latest status
npx @ran-sh/dsh-crew@latest update
npx @ran-sh/dsh-crew@latest uninstall        # 加 --purge 才会同时删除配置/备份
```

npx 安装会把已构建好的包持久化到 Crew 自有状态（`~/.config/dsh-crew/app`）后再注册，安装不依赖临时的 npx 缓存，也不需要 pnpm、lockfile 或任何构建步骤。

开发者 / 源码安装（备选路径）：

```bash
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
node scripts/setup.mjs install
```

Windows 源码检出也可以直接运行：

```bat
install.cmd
```

DSH Crew 使用自己独立的 Harness home 和 profile：

```text
~/.config/dsh-crew/harness
profile: dsh-crew
```

受支持的 Crew 工具不会修改正常的 `~/.dsh`、官方 `web` profile 或官方 DSH 凭据存储。

## 30 秒上手

1. 正常启动 DeepSeek Harness。
2. 打开 **Settings → DSH Crew**。
3. 安装 Codex 集成；Claude Code 集成为可选项。
4. 需要时刷新 Harness 模型，并设置各角色优先级。
5. 集成变更后重启编码宿主。

然后直接说：

```text
Use ds-worker to implement this change.
Use ds-reviewer to review the implementation.
```

## 角色与路由

| 角色 | 用途 |
|---|---|
| `worker` | 实现、修复、测试、搜索、分析 |
| `reviewer` | 独立审查与 verdict |

每个角色都有自己的 provider / model 候选顺序。用户显式配置始终优先；只有工作流拿到明确证据时才会自动升级到更强模型。

旧的 `ds-flash` / `ds-pro` 仍保留兼容，但新提示词建议使用 `ds-worker` / `ds-reviewer`。

## 隔离

`execution.isolation` 默认是 `worktree`。

编码 worker 会在目标 revision 上创建临时 git worktree，因此并行 worker 不会写入同一个工作目录。worker 返回可审计的 change candidate，由总控决定接受、拒绝或继续修改；Crew 不会偷偷把改动合进主工作区。

## 更新 / 卸载

npx 安装使用 update 原地升级（配置、凭据和备份保留；候选包先暂存校验再切换）：

```bash
npx @ran-sh/dsh-crew@latest update
```

卸载 npx 安装：

```bash
npx @ran-sh/dsh-crew@latest uninstall
```

源码安装的更新方式：

```bash
git pull --ff-only
node scripts/setup.mjs install
```

卸载源码安装：

```bash
node scripts/setup.mjs uninstall
```

Windows：

```bat
install.cmd
uninstall.cmd
```

`~/.config/dsh-crew` 下的 Crew 配置和备份默认保留。

## 开发

```bash
pnpm install --frozen-lockfile
node --test test/*.test.mjs
pnpm run build:client
pnpm run verify:npm-install
```

更多文档：

- [架构路线图](./docs/v0.3-architecture-roadmap.md)
- [Readiness Matrix](./docs/readiness-matrix.md)
- [Agent Workflow](./docs/agent-workflow.md)
- [Changelog](./CHANGELOG.md)

## License

MIT
