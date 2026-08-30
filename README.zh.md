# DSH Crew

为 Codex Desktop、ZCode 和 Claude Code 提供隔离的 Crew Harness，支持
Worker/Reviewer 调度、模型优先级、任务跟踪和能力感知安全门。

[English](./README.md)

## 快速开始

需要 Node.js 和 Git。

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
dsh-crew integrate
dsh-crew status
```

打开 <http://127.0.0.1:3080> 进入日常控制台。Windows 安装会注册当前用户的
登录启动项，自动启动两个本地服务。

| 界面 | 用途 |
| --- | --- |
| `3080` | 日常控制台、Crew 设置、集成状态和任务 |
| `3210` | 隔离的 Crew Harness、Provider、Harness Models 和底层设置 |

进入 **设置 → DSH Crew**，刷新 Harness Models，并分别排列 Worker 与 Reviewer
的模型顺序。然后直接告诉 Codex、ZCode 或 Claude：

```text
使用 ds-worker 实现这个改动并运行测试。
使用 ds-reviewer 审查结果。
```

集成会先检查 Crew 的实时能力；已选择 Crew 后若能力不可用，会暂停等待操作者
决定修复 Crew 还是由主代理本地完成，不会静默降级。

## 常用命令

```bash
dsh-crew inspect          # 实时能力与就绪度
dsh-crew jobs list        # 任务与 Result Contract
dsh-crew update           # 更新并修复已启用集成
dsh-crew uninstall        # 移除受管文件，保留配置/备份
```

运行时隔离在 `~/.config/dsh-crew/harness`，使用 `profile: dsh-crew`；官方 `web` profile
只接收 3080 轻量桥接。

## 旧启动器迁移

对于 `<= 0.3.3` 的旧启动器，请先刷新启动器。旧 updater 无法发现更新，也无法被追溯修复：

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew update
```

## 从源码安装

```bash
git clone https://github.com/Ran-sh/dsh-crew.git
cd dsh-crew
node scripts/setup.mjs install
node scripts/setup.mjs status
node scripts/setup.mjs uninstall
```

测试：`node --test test/*.test.mjs`。更多信息见[安装方案](./docs/installation.md)、
[界面分工](./docs/ui-surfaces.md)、[就绪矩阵](./docs/readiness-matrix.md)和
[任务合同](./docs/job-contracts.md)。

MIT
