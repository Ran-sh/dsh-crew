<p align="center"><img src="./docs/images/dsh-crew-logo.png" alt="DSH Crew" width="120" /></p>

<h1 align="center">DSH Crew</h1>

<p align="center"><strong>让 Codex Desktop 和 Claude Code 使用 Worker / Reviewer，并统一显示在官方 DeepSeek Harness 界面中。</strong></p>

<p align="center"><a href="./README.md">English</a> · <a href="./README.zh.md"><b>简体中文</b></a></p>

## 快速开始

需要 Node.js；使用 worktree 隔离还需要 Git。

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
dsh-crew integrate
```

照常在 3080 端口启动官方 Harness：

```bash
npx -y @deepseek-ai/dsh web --host 127.0.0.1 --port 3080
```

打开 <http://127.0.0.1:3080>，进入 **设置 → DSH Crew**。3080 只显示官方界面；Crew 的任务与模型执行继续隔离在 `127.0.0.1:3210`，需要时由桥接在后台自动启动。

## 配置

1. 点击“刷新 Harness 模型”。
2. 分别设置 Worker 和 Reviewer 的模型顺序。
3. Worker 保持 **Auto**，即可自动委派。
4. Reviewer 默认 **Manual**；确实需要自动复审时再开启。
5. 编码任务建议保持 **worktree** 隔离。

只配置一个模型时，两个角色直接使用它。配置多个模型时，每个角色按自己的排序调用，失败后依次回退。设置模块可以展开/收起，收起后仍显示当前状态。

## 在 Codex 或 Claude 中使用

```text
使用 ds-worker 实现这个改动并运行测试。
使用 ds-reviewer 审查结果。
```

旧的 `ds-flash`、`ds-pro` 别名仍可使用。

## 结果与复审信息流

Crew 默认返回紧凑、机器可读的 Result Contract：状态、测试、改动文件、
Reviewer 结论、模型选择轨迹、候选引用和规范化生命周期事件。Worker 的
整段原始回答和完整 patch 不会在每次交接时重复传递；自动 Reviewer 只接收
有大小上限的证据胶囊，并直接检查隔离工作区。

MCP 调用方如需排障或恢复，可以在 `dsh_run_worker` 或
`dsh_worker_result` 中显式传入 `detail: "full"`。完整契约见
[任务契约与信息流](./docs/job-contracts.md)。

## 常用命令

```bash
dsh-crew status       # 查看安装与集成状态
dsh-crew update       # 更新并自动修复已启用的集成
dsh-crew integrate    # 将官方 3080 界面连接到隔离的 3210 Crew
dsh-crew detach       # 只移除 3080 桥接
dsh-crew uninstall    # 卸载 Crew，保留配置和备份
```

`dsh-crew uninstall --purge` 才会同时删除 Crew 配置和备份。

如果想继续使用完全独立的界面，先运行 `dsh-crew detach`，再直接启动隔离 profile：

```powershell
$env:DSH_HOME = "$HOME\.config\dsh-crew\harness"
& "$env:DSH_HOME\runtime\node_modules\.bin\dsh.cmd" --profile dsh-crew --host 127.0.0.1 --port 3210
```

桥接首次修改前会备份官方 `web` profile，并且只注册轻量代理/客户端包。完整 Crew Hub、模型执行、配置和凭据仍位于：

```text
~/.config/dsh-crew/harness
profile: dsh-crew
```

对于 `<= 0.3.3` 的旧启动器，请先刷新启动器；旧 updater 无法发现新版本，也无法被追溯修复：

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew update
```

## 源码开发

```bash
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
node scripts/setup.mjs install
node --test test/*.test.mjs
pnpm run build:client
node scripts/setup.mjs uninstall
```

更多资料：[Changelog](./CHANGELOG.md) · [Readiness Matrix](./docs/readiness-matrix.md) · [任务契约](./docs/job-contracts.md)

## License

MIT
