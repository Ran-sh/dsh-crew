<p align="center">
  <img src="./docs/images/dsh-crew-logo.png" alt="DSH Crew" width="120" />
</p>

<h1 align="center">DSH Crew</h1>

<p align="center"><strong>让 Codex Desktop 或 Claude Code 统一调度隔离运行的 DeepSeek Harness Worker 与 Reviewer。</strong></p>

<p align="center"><a href="./README.md">English</a> · <a href="./README.zh.md"><b>简体中文</b></a></p>

## 能做什么

- `worker`：实现、修复、测试和仓库检查。
- `reviewer`：使用独立模型顺序进行只读审查。
- 为两个角色分别设置 Provider / Model 优先级。
- 默认使用临时 Git worktree，不直接修改主工作区。
- 在 DeepSeek Harness 中查看设置、进度和结果。

## 安装

需要 Node.js；worktree 隔离还需要 Git。

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
```

请使用全局启动器。对于受 npm/cli#9870 影响的 npm 版本，临时 `npx` 不是受支持的安装方式。

## 启动 Harness

Windows PowerShell：

```powershell
$env:DSH_HOME = "$HOME\.config\dsh-crew\harness"
& "$env:DSH_HOME\runtime\node_modules\.bin\dsh.cmd" --profile dsh-crew --port 3210
```

macOS / Linux：

```bash
DSH_HOME="$HOME/.config/dsh-crew/harness" \
  "$HOME/.config/dsh-crew/harness/runtime/node_modules/.bin/dsh" \
  --profile dsh-crew --port 3210
```

打开 <http://127.0.0.1:3210>，进入 **Settings → DSH Crew**。

## 配置

1. 安装 Codex 和/或 Claude Code 集成。
2. 点击“刷新 Harness 模型”。
3. 分别排列 Flash 与 Pro 的模型调用顺序。
4. Worker 保持 Auto 即可自动委派；Reviewer 建议默认 Manual，需要自动复审时再开启。
5. 编码任务建议使用 `worktree` 隔离。

设置页已按模块折叠；关闭后仍会显示当前状态和第一优先模型。

## 使用

直接告诉编码宿主：

```text
使用 ds-worker 实现这个改动并运行测试。
使用 ds-reviewer 审查结果。
```

旧的 `ds-flash`、`ds-pro` 别名仍兼容，但新工作流建议使用 `ds-worker`、`ds-reviewer`。

## 检查、更新、卸载

```bash
dsh-crew status
dsh-crew update
dsh-crew uninstall
```

普通卸载会保留配置和备份；只有确实要一起删除时才加 `--purge`。

对于 `<= 0.3.3` 的旧启动器，旧 updater 无法发现更新版本，也无法被追溯修复。先刷新启动器，再更新托管载荷：

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew update
```

## 隔离与源码安装

Crew 使用独立的 Harness home 和 profile：

```text
~/.config/dsh-crew/harness
profile: dsh-crew
```

正常操作不会修改 `~/.dsh`、官方 `web` profile 或官方 Harness 凭据存储。

开发者安装：

```bash
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
node scripts/setup.mjs install
```

开发者卸载：

```bash
node scripts/setup.mjs uninstall
```

## 开发

```bash
pnpm install --frozen-lockfile
node --test test/*.test.mjs
pnpm run build:client
pnpm run verify:npm-install
```

详细资料：[Changelog](./CHANGELOG.md) · [Readiness Matrix](./docs/readiness-matrix.md) · [架构](./docs/v0.3-architecture-roadmap.md)

## License

MIT
