# DSH Crew

DSH Crew 是附着在 DeepSeek 官方 Harness 上的 Crew 编排插件，为 Codex Desktop、
ZCode 和 Claude Code 增加 Worker/Reviewer 调度、模型优先级、任务跟踪和能力感知安全门。

[English](./README.md)

## 快速开始

需要 Windows、Node.js 和 Git。目前受管 3210 监督仅支持 Windows；Linux 和 macOS
暂不属于生产运行平台。

```bash
npm install -g @ran-sh/dsh-crew@latest
dsh-crew install
```

DSH Crew 安装在 DeepSeek 官方 Harness 的专用 `dsh-crew` profile 中，并由 3210
提供服务。这个 profile 是 Crew 的 canonical control and execution surface。

官方 3080 界面不属于 Crew，Crew 不依赖它并始终将其 profile 视为只读；
Crew 从不启动、拥有或监管它。

Windows 安装会注册登录启动项。如需立即启动并打开 Crew 控制台：

```powershell
& "$env:USERPROFILE\.config\dsh-crew\launchers\start-dsh-crew.cmd" --open
```

启动后打开 <http://127.0.0.1:3210/>。

安装、更新和回滚也会自动收敛 Windows watcher：系统会精确交接旧 watcher，
并且只有在新的 3210 Crew 与 DSH 版本验证通过后才报告完成；整个过程不涉及
重启 3080。

```bash
dsh-crew status
dsh-crew inspect
```

全新安装只包含内置 DeepSeek 路由。其他 Provider 凭据、模型优先级和可选集成需要
在本机设置中自行配置，绝不会打包进发布版本。

| 界面 | 用途 |
| --- | --- |
| `3080` | 官方 Harness 的 `web` profile；不属于 Crew，Crew 不依赖它 |
| `3210` | 安装了 DSH Crew 插件的官方 Harness `dsh-crew` profile |

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
dsh-crew providers list   # 3210 Harness Provider 清单（不含密钥）
dsh-crew providers migration-status # 检查旧 profile Provider，不会自动迁移
dsh-crew providers migrate-plan <provider>
dsh-crew providers migrate <provider> --plan <id> --confirm # 写入用户层，重启 3210 并验证
dsh-crew providers rollback-migration <provider> --plan <id> --confirm
dsh-crew providers probe <provider-id>
curl http://127.0.0.1:3210/_dsh/dsh-crew/credential-references  # 仅查看引用/孤儿报告
dsh-crew credentials list  # 不含密钥值的引用清单
dsh-crew credentials purge-plan env:NAME
dsh-crew credentials purge env:NAME --plan <plan-id> --expected-revision <sha256> --confirm
dsh-crew providers delete-plan <provider-id> --replacement-default <provider-id>
dsh-crew providers delete <provider-id> --plan <plan-id> --expected-revision <sha256> --confirm
dsh-crew releases list     # 查看保留且已验证的版本
dsh-crew rollback <version> # 切换版本并验证 3210 runtime
dsh-crew update           # 更新并修复已启用集成
dsh-crew uninstall        # 移除受管文件，保留配置/备份
```

专用的官方 Harness 运行时状态隔离在 `~/.config/dsh-crew/harness`，使用
`profile: dsh-crew`；DSH Crew 本身仍然是插件，并非 DeepSeek Harness 的分支或替代品。
官方 `web` profile 不属于 Crew 且对 Crew 始终只读；旧版 3080 bridge 若仍存在，
只会作为已弃用诊断项显示。

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
