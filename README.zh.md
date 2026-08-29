<p align="center"><img src="./docs/images/dsh-crew-logo.png" alt="DSH Crew" width="112" /></p>

# DSH Crew

让 Codex Desktop、Claude Code 和 ZCode 使用 Worker / Reviewer，并在官方 DeepSeek Harness 界面中完成日常控制。

[English](./README.md) · [简体中文](./README.zh.md)

## 快速开始

需要 Node.js；使用 worktree 隔离还需要 Git。

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
dsh-crew integrate
```

Windows 安装会同时创建当前用户的登录启动项：后台启动隔离的 3210 Crew 和官方 3080 界面服务，但不会自动弹出浏览器。需要时打开 <http://127.0.0.1:3080>。

```bash
dsh-crew status
dsh-crew inspect
```

- **3080**：日常控制台、Crew 设置、Codex/Claude 就绪状态、任务列表。
- **3210**：隔离 Crew 后端、Provider、Harness Models 和底层 Harness 设置。
- **Codex / ZCode**：安装程序会加入可卸载的能力感知规则区块和 dispatch 角色，不改动已有个人规则。
- **ZCode**：已有原生 MCP 服务时使用 `~/.zcode/cli/config.json`，否则兼容使用 `~/.agents/mcp.json`。

## 配置与使用

进入 **设置 → DSH Crew**，刷新 Harness Models，然后分别排列 Worker 和 Reviewer 的模型顺序。只配置一个模型时直接使用；配置多个模型时按你的排序依次尝试。Worker 可以自动调用，Reviewer 默认手动。

直接告诉 Codex 或 Claude：

```text
使用 ds-worker 实现这个改动并运行测试。
使用 ds-reviewer 审查结果。
```

Codex 会先读取 Crew 的实时能力与就绪合同。如果已经选择 Crew、但 Crew 变得不可调用，它会暂停并询问“修复 Crew 后继续”还是“由 Codex 本地继续”，不会静默降级。

## 常用命令

```bash
dsh-crew status                    # 安装和集成状态
dsh-crew inspect                   # 实时能力与就绪度
dsh-crew jobs list                 # 任务与 Result Contract
dsh-crew jobs watch <id> --after 0
dsh-crew update                    # 更新并修复已启用集成
dsh-crew integrate                 # 接入官方 3080
dsh-crew detach                    # 只移除 3080 桥接
dsh-crew uninstall                 # 移除受管文件，保留配置/备份
dsh-crew uninstall --purge         # 同时移除配置/备份
```

官方 `web` profile 只安装轻量桥接。Crew 运行时、模型、配置与凭据隔离在：

```text
~/.config/dsh-crew/harness
profile: dsh-crew
```

## 从源码安装

如果要在 npm 发布前安装 GitHub `main`：

```bash
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
node scripts/setup.mjs install
node scripts/setup.mjs status
```

验证与卸载：

```bash
node --test test/*.test.mjs
pnpm run build:client
node scripts/setup.mjs uninstall
```

对于 `<= 0.3.3` 的旧启动器，请先刷新启动器。旧 updater 无法发现更新，也无法被追溯修复：

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew update
```

安装归属与回滚细节见[安装方案](./docs/installation.md)。架构合同：[界面分工](./docs/ui-surfaces.md) · [就绪矩阵](./docs/readiness-matrix.md) · [任务与信息流](./docs/job-contracts.md)。

MIT
