# GPT-6 Astra 仓库指令审计

范围：当前仓库的规则、宿主模板、技能入口和交接 workflow。未改全局文件、
用户模型路由、运行时算法、CI 矩阵或发布行为。详细清单见
[instruction-stocktake.json](instruction-stocktake.json)。

## 官方依据

- [GPT-6 Astra 指导](https://developers.openai.com/api/docs/guides/latest-model)：
  据其提示词建议，明确继续完成任务的条件，减少指令冲突、无必要确认、
  重复验证，并按实际收益选择委派。本次没有套用 API 迁移参数。
- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)：
  采用简短仓库入口；宿主安装模板保持独立，不把长交接协议当成常驻前置条件。
- [Skills](https://learn.chatgpt.com/docs/build-skills)：
  在 `.agents/skills/` 增加窄触发的开发技能，按任务加载相关文件。

## 发现与处理

| 问题 | 处理 |
| --- | --- |
| 根目录没有 AGENTS.md，也没有仓库 SKILL.md | 新增短入口与 dsh-crew-development 技能 |
| ACTIVE_TASK 被描述为所有工作的唯一来源 | 明确区分直接请求与显式交接；仅后者要求有效 ACTIVE 文件 |
| 多份派发提示要求全文转发任务和输出 | 保留完整目标/约束，去掉无关聊天与宿主元数据；输出紧凑证据 |
| bounded wait 与真正失败容易混淆 | 跟踪同一 workflow ID，非终态继续等待，禁止重复派发 |
| `mode=standalone` 已不被配置接口接受 | 三个宿主命令对齐 live schema 的 auto/hub |
| ZCode 配置命令缺少别名映射 | 补齐映射；避免误传 tier 而非 default_tier |
| `policy=auto` 文档暗示恢复全局状态 | 以返回的 effective policy 为准，不作未经接口支持的承诺 |
| Codex 模板带个人绝对路径 | 换为安装器可解析的占位路径，保留单行 args 结构 |
| 小改动也容易触发全量检查 | 根据影响选择验证；显式验收矩阵仍必须完成 |

保留兼容别名文件及轻量派发器型号。主代理的 Astra 设置不是修改用户 DSH
模型策略的授权，也不意味着所有转发角色都应升级为昂贵模型。保留用户明确
要求的 DSH 不可用暂停规则、手动/禁用边界、官方目录保护和结果证据约束。

## 体积变化

基准提交：`cc03df16d938dde77e460e9a7b0118303c8d09dc`。
按换行统一为 LF 的 UTF-8 字节计，不当作 token 或性能测量。

| 既有文件组 | 修改前 | 修改后 | 减少 |
| --- | ---: | ---: | ---: |
| Codex / ZCode 宿主策略 | 7,804 | 5,542 | 29% |
| 交接 workflow | 11,111 | 7,415 | 33% |
| 各宿主角色模板 | 18,438 | 16,643 | 10% |

另新增根 AGENTS.md 2,644 字节和按需加载的 SKILL.md 2,743 字节。
这些新增入口不是零成本；收益主要在于减少重复摸索与误路由，不能仅凭
文件缩短宣称运行速度或代码质量提高。未进行 Astra 的同任务前后 A/B 测试。

## 验证

- 48 项 Codex/ZCode 安装、派发及分发契约测试通过（临时目录）。
- 4 个 Codex TOML、6 个 Agent frontmatter 解析通过。
- 官方 skill-creator 校验器：Skill is valid。
- TEMPLATE_TASK.json 通过本地 Task Contract 校验器，source_commit 使用 LATEST。
- 独立检查覆盖 8 个情景：直接小改动、缺失显式任务、针对性测试后收尾、
  Crew 凭据失败、非终态等待、审查通过但测试失败、旧 mode 配置和 Astra 调优。
- 复核指出源版本一致性检查不能省略，已恢复显式 HEAD/SHA 匹配要求；
  后续复核结论 APPROVE。

此次是指令调整，没有运行全量产品测试、重启实例或发起真实模型测试。
仅在选择委派前读取了现有 Crew 能力；审计与前向情景检查由独立本地子代理完成。

## 生效边界

仓库入口和技能供本仓库任务使用。`codex/`、`zcode/` 中的文件仍是安装模板，
不会自动覆写已经安装的全局副本；本次没有执行全局安装。全局技能或更高优先级
指令仍可能增加测试、提交或确认要求，需要另行授权审计才能统一这些来源。
不以“释放性能”为由降低用户授权或数据保护边界。
