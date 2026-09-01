// Browser half of dsh-crew: integrations (install/update/restore),
// global worker configuration, and the live jobs table.
// Talks only to the plugin's own loopback routes.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  openSections,
  readSectionState,
  setEverySection,
  writeSectionState,
} from './collapsible-sections.mjs';
import { ActivationSummary } from './activation-summary';
import { projectHostReadiness, READINESS_STATES } from './host-readiness.mjs';
import { CREW_UI_SURFACES, classifyCrewSurface, surfaceResponsibilities } from './surface-detection.mjs';
import { aggregateModelInvocations } from './task-telemetry.mjs';

export const inject = ['slots', 'locale'];

const API = '/_dsh/dsh-crew';
const CREW_HARNESS_URL = 'http://127.0.0.1:3210/';
const CREW_CONTROL_PLANE_URL = 'http://127.0.0.1:3080/';

type AdaptiveConfig = { enabled: boolean; window_size: number; min_samples: number };
const DEFAULT_ADAPTIVE: AdaptiveConfig = { enabled: false, window_size: 8, min_samples: 2 };

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeAdaptive(value: any): AdaptiveConfig {
  const windowSize = clampInt(value?.window_size, DEFAULT_ADAPTIVE.window_size, 1, 32);
  return {
    enabled: value?.enabled === true,
    window_size: windowSize,
    min_samples: clampInt(value?.min_samples, DEFAULT_ADAPTIVE.min_samples, 1, windowSize),
  };
}

const COPY = {
  zh: {
    label: 'DSH Crew',
    title: 'DSH Crew',
    intro: '日常 Crew 控制台：在一个入口里配置编排、角色、模型路由与宿主集成，并跟踪真实 Worker / Reviewer 任务。',
    integrations: '集成',
    installed: '已安装', notInstalled: '未安装', ready: '可调用', notReady: '未就绪', hud: 'HUD 段',
    install: '安装', update: '更新', restore: '还原',
    confirmRestore: (name: string) => `确定从 ${name} 移除 dsh-crew 集成？（settings 会先备份）`,
    globalConfig: '全局配置',
    expandAll: '全部展开', collapseAll: '全部折叠',
    modelCount: (count: number) => `${count} 个模型`, providerCount: (count: number) => `${count} 个 Provider`,
    jobCount: (count: number) => `${count} 个任务`, runningCount: (count: number) => `${count} 个运行中`,
    sectionNames: { integrations: 'Codex / Claude / ZCode 集成状态', workflow: 'Crew 工作流设置', flash: 'Worker / Flash', pro: 'Reviewer / Pro', dispatch: '模型优先级与派发', adaptive: '自适应路由', runtime: '运行 / 生效边界', multimodal: '视觉与生图', harnessProviders: 'Harness Providers', providers: '多模态适配器', jobs: '任务状态' },
    openHarness: '打开 3210 Crew Harness →',
    harnessHint: '底层 Provider、Harness Models 与运行时配置',
    hostReadiness: '宿主集成就绪度', hostReadinessHint: '只使用结构化安装与运行时证据；缺少证据不会显示 READY。',
    readinessLabels: { codex_mcp: 'Codex MCP', ds_worker: 'ds-worker', ds_reviewer: 'ds-reviewer', claude_plugin: 'Claude plugin', zcode_mcp: 'ZCode MCP', crew_harness: 'Crew Harness', official_bridge: 'Official bridge' },
    readinessStates: { READY: 'READY', DEGRADED: 'DEGRADED', UNAVAILABLE: 'UNAVAILABLE', UNKNOWN: 'UNKNOWN' },
    globalHint: '修改即时保存到 ~/.config/dsh-crew/config.json；CC / Codex 的新会话自动读取为默认值（会话内可用 /dsh-crew:config 临时覆盖）。',
    orchestration: 'Agent 编排',
    enableSubagents: '启用子 Agent',
    enableSubagentsHint: '总开关。关闭后 dsh_run_worker / dsh_spawn_worker 在工具层拒绝派发（配置保留，重新开启即恢复）。',
    subagentsKept: '配置已保留',
    mainAgentMode: '主 Agent 模式',
    mainAgentModeDesc: { 'direct-allowed': '直接允许 · 可自己做，也可委派', 'coordinator-first': '协调优先 · 先规划、拆分、委派，再检查验证', 'dispatcher-only': '仅派发 · 尽量只做规划、派发、审查与整合' },
    mainAgentModeHint: '这是宿主路由指引，不是对宿主自身工具的硬限制。',
    collaborationMode: '协作模式',
    collaborationModeDesc: { 'flash-only': 'Flash Only · 只用 Flash', 'pro-only': 'Pro Only · 只用 Pro', balanced: 'Balanced · 双 Auto', 'review-pipeline': 'Review Pipeline · Flash 实现 + Pro 复审', custom: 'Custom · 完全手动' },
    tierCardFlash: 'Flash', tierCardPro: 'Pro',
    tierState: '状态',
    tierStateDesc: { disabled: '禁用', manual: '手动（仅用户点名时可用）', auto: '自动（orchestrator 可自动委派）' },
    stateManagedByPreset: '由协作模式管理',
    statePresetHint: '切到 Custom 可单独配置各档状态。',
    workerProvider: 'Worker Provider',
    workerProviderDesc: { 'follow-dsh': '跟随 Harness · 使用各档独立的模型优先级', 'deepseek-official': 'DeepSeek Official · 使用旧版固定模型路由' },
    workerProviderHint: '仅作用于 Hub 模式；Standalone 仅保留为旧版迁移元数据，不是生产执行路径。',
    workerModels: 'Worker 模型', refreshHarnessModels: '刷新 Harness 模型', refreshingModels: '刷新中…',
    modelPriority: '模型优先级', addPriorityModel: '＋ 添加优先模型', modelSearch: '搜索 Provider 或 Model…',
    harnessDefault: 'Harness 默认模型', providerUnavailable: 'Provider 不可用', notAdvertised: '当前未列出',
    noPriority: '未配置优先项', modelPoolSummary: (p: number, m: number) => `Providers: ${p} · Models: ${m}`,
    healthUnprobed: 'UNPROBED', checkedAgo: (s: number) => `${s} 秒前检查`,
    partialCatalog: '部分 Provider 读取失败', catalogFailed: '无法读取 Harness 模型目录', removePriority: '移除', moveUp: '上移', moveDown: '下移',
    needsModelSelection: '多个 Provider 提供默认偏好模型，且 Harness Default 无法消歧；当前将回退到 Harness Default，请手动选择。',
    responsibilities: '职责',
    responsibilitiesHint: '路由指引，仅用于描述分工；只剩一个 Auto 档时它承担全部可委派工作。',
    roleLabels: { implementation: '代码实现', simple_fix: '简单修复', tests: '测试', search_inspection: '搜索 / 检查', architecture: '架构', complex_debugging: '复杂调试', refactor: '重构', code_review: '代码审查' },
    routing: '路由',
    proReviewsFlash: 'Pro 复审 Flash 改动',
    proReviewsFlashHint: 'Flash 成功后自动追加一次 Pro 复审（仅 blocking 派发）',
    proReviewsLocked: 'Review Pipeline 模式固定开启',
    enableCrewVision: '启用 Crew 视觉',
    enableCrewVisionHint: '关闭后不注册 Crew 的 describe_image 与视觉 route（可与你的 dsh-vision 等共存）。',
    enableImagegen: '启用生图',
    enableImagegenHint: '关闭后不注册 Crew 的 generate_image。',
    capRestartHint: '该开关改变工具注册，需重启 DSH 生效',
    capDisabledNote: 'Crew 工具/route 已禁用（重启 DSH 后生效）',
    tier: '默认档位', effort: '默认推理', mode: '执行模式', timeout: '默认超时(秒)', hubUrl: 'Hub 地址',
    tierPolicy: '档位策略', escalate: '失败升档',
    tierPolicyDesc: { auto: 'auto · orchestrator 自选', 'flash-only': '只用 flash', 'pro-only': '只用 pro' },
    escalateHint: 'flash 失败自动用 pro 重试一次',
    presetFlash: 'flash 模式', presetPro: 'pro 模式',
    multimodal: '多模态',
    visionProvider: '视觉 provider', visionModel: '视觉模型', imagegenProvider: '生图 provider',
    harnessProviders: 'Harness Providers', harnessProviderHint: '3210 Crew Harness 的真实 Provider 注册与生命周期；不是视觉 / 生图适配器。',
    providerState: (state: string) => `状态：${state}`, providerModels: (count: number) => `${count} 个模型`, providerJobs: (count: number) => `${count} 个运行任务`,
    providerOfficialBuiltin: '· 官方内置（不可删除）', providerSourceUnresolved: '· 来源未解析（安全锁定）',
    providerLayerMigration: '检测到旧版 profile Provider', providerLayerMigrationHint: '这些 Provider 仍在 Crew profile/base 层，所以 3210 原生页面不会显示删除。请先按迁移计划提升到 Harness 用户设置层；不会复制密钥。', providerLayerMigrationPlan: '迁移计划', providerLayerMigrate: '迁移到用户层', providerLayerMigrating: '迁移中…', providerLayerMigrationConfirm: '确认把这个 Provider 移到 Harness 用户设置层？会先保存可回滚快照，不会复制密钥值。', providerLayerRollback: '回滚迁移',
    providerDeletePlan: '生成删除计划', providerDelete: '确认删除', providerPlanReady: '计划已生成；再次确认后才会修改 3210 配置。', providerRollback: '回滚', providerRollbackConfirm: '按已保存事务恢复这个 Harness Provider 及原有路由？', providerRollbackUnavailable: '没有可验证的回滚事务',
    providerReplacement: '替换 Harness 默认 Provider（输入 Provider id）', providerDeleteConfirm: '确认按计划删除这个 Harness Provider？会清理路由引用并重启 3210。',
    providerDeleteBlocked: '当前 Provider 不能删除（内置、在用、已删除或缺少可用替换）。', providerLifecycleError: 'Provider 生命周期操作失败', providerDeletePending: '配置可能已变更，事务仍待重启/验证；请刷新状态后选择回滚。', providerRollbackContinue: '继续回滚验证', recoveryUnresolved: '发现不可自动恢复的事务', recoveryStorage: '存储项', recoveryQuarantine: '隔离', recoveryQuarantineConfirm: '该事务清单无法安全恢复。将其移入隔离区并阻止自动使用，继续？',
    providerNoInventory: '暂时无法读取 3210 Provider inventory。',
    credentialReferences: 'Credential 引用', credentialReferenceHint: '仅显示引用名、归属和孤儿状态；不会读取或删除密钥。',
    credentialOrphan: '孤儿 · 可单独申请清理', credentialInUse: (count: number) => `使用中 · ${count} 个 Provider`, credentialPurgePlan: '申请清理', credentialPurgeConfirm: '这是不可恢复的 Crew-owned 凭据清理，确认继续？', credentialPurging: '清理中…', credentialPurgeUnavailable: '凭据清理不可用', credentialPurgeUnverified: '已执行清理，但验证失败；引用仍保留用于恢复检查',
    customProviders: '多模态适配器', addProvider: '＋ 添加多模态适配器',
    noCustomProviders: '暂无。添加后会出现在上方的视觉 / 生图 provider 选择里。',
    providerName: '名称', modelsField: '模型列表（逗号分隔）',
    providerType: '接入方式', typeApi: 'API · 兼容 OpenAI 接口', typeCli: 'CLI · 本地命令',
    baseUrl: 'Base URL', apiKey: 'API Key', imagegenModel: '生图模型（留空=不提供生图）',
    visionCmd: '视觉命令（可选）', imagegenCmd: '生图命令（可选）',
    apiFormHint: '走 OpenAI 兼容接口：视觉调 {base}/chat/completions（图片以 base64 内联），生图调 {base}/images/generations。Key 保存在本机 ~/.config/dsh-crew/config.json，不会外发到第三方。',
    cliFormHint: '命令经 bash 执行，占位符会被安全引用后代入。视觉: {image} {question} {model}，stdout 即答案；生图: {prompt} {output} {size}，命令须把图片写到 {output}。两条命令至少填一条。',
    saveProvider: '保存', cancel: '取消', edit: '编辑', del: '删除',
    testProvider: '连通测试', testing: '测试中…',
    testTip: '按当前填写的内容实测：API 会检查可达性与鉴权并真发一次视觉请求；CLI 会检查可执行文件并真跑一次视觉命令。生图只校验配置，不实际出图。',
    testPass: '连通正常', testFail: '连通失败',
    staleHub: '本 DSH 实例还在跑旧版插件，缺少该接口 —— 重启 DSH 后再试',
    emptyResponse: (path: string, status: number) => `${path} → HTTP ${status}，响应为空`,
    badJson: (path: string, body: string) => `${path} → 非 JSON 响应: ${body}`,
    refreshModels: '重新从 CLI 获取模型列表',
    presetDefault: (id?: string) => `default · 跟随 DSH${id ? ` (${id})` : ''}`,
    progressTip: (t: string, turn: number, step: number, calls: number | string) => `耗时 ${t} · 第${turn}轮第${step}步 · ${calls} 次工具调用`,
    confirmDeleteProvider: (n: string) => `删除自定义 provider「${n}」？`,
    needName: '⚠ 名称必填', needCmd: '⚠ 视觉/生图命令至少填一条',
    needBaseUrl: '⚠ Base URL 必填', needModels: '⚠ 模型列表至少填一个',
    keySet: '已配置', keyPlaceholder: 'sk-…（留空则不发送 Authorization）',
    addModelTip: '添加模型到列表', removeModelTip: '从列表移除当前模型', modelPlaceholder: '模型 id，回车确认',
    capVision: '视觉', capImagegen: '生图',
    groupDispatch: '派发', groupRuntime: '运行', groupMultimodal: '多模态',
    groupWorkflow: '工作流 / 执行（v0.2）',
    roleWorker: 'Worker 角色（执行）', roleReviewer: 'Reviewer 角色（独立审查）',
    workerStateLabel: 'Worker 状态', reviewStateLabel: 'Reviewer 状态',
    roleStateHint: 'auto：orchestrator 可自动派发；manual：仅显式点名；disabled：禁用。未显式设置时由协作模式推导。',
    autoReview: '自动复审', autoReviewHint: 'worker 成功后自动运行一次 reviewer（独立模型策略，只读）',
    modelOrdering: '候选排序', orderingDesc: { manual: '手动顺序', 'health-aware': '健康感知' },
    orderingHint: '手动 priority 始终保持顺序；健康感知仅重排未显式锁定的自动候选。',
    healthGate: '健康门', healthGateDesc: { 'hard-failures': '跳过明确不可调用', off: '关闭健康门' },
    reviewGate: 'Reviewer 验收门', reviewGateDesc: { required: 'required · 未批准则失败', optional: 'optional · 记录但不阻断', off: 'off · 不自动复审' },
    isolation: '工作区隔离', isolationHint: 'worktree 为默认；非 Git 仓库时需显式 shared，否则任务以 NOT_GIT_REPOSITORY 失败。',
    isolationDesc: { worktree: 'worktree · 每个 coding worker 独立临时 git worktree（主工作区不动）', shared: 'shared · 旧版就地执行' },
    maxParallel: '最大并行', maxParallelHint: '同时运行的工作流上限（1–16）；超出进入队列。',
    legacyCompatibility: '↓ 以下为兼容配置（legacy，Flash/Pro 仍可编辑）',
    cardDispatch: { t: '派发策略', d: 'orchestrator 未指定时的档位与推理强度，以及档位约束、失败升档与两档各自挂载的 Agent 预设。' },
    cardRuntime: { t: '执行与连接', d: 'worker 会话跑在本实例内还是独立进程，单个任务的超时上限，以及 CC / Codex 探测本实例的地址。' },
    cardMM: { t: '视觉与生图', d: '给纯文本的 DSH 模型借来眼睛和画笔：describe_image、会话贴图转写与 generate_image 都用这里的设置。' },
    cardCustomProv: { t: '自定义 Provider', d: '接入自己的 API 或本地命令；保存后会出现在上面的视觉 / 生图 provider 选择里。' },
    modeDesc: { auto: 'auto · 优先 3210', hub: 'hub · 必须 3210' },
    save: '保存', saved: '已保存', jobs: 'Worker 任务', empty: '当前没有 Worker / Reviewer 任务。',
    adaptiveTitle: '自适应模型路由（实验）', adaptiveHint: '默认关闭；只重排系统自动候选，手动模型优先级始终保持原序。健康信号仅来自本进程已观察到的成功、失败、超时与粗粒度延迟，重启后清空。',
    adaptiveEnabled: '启用自适应路由', adaptiveWindow: '健康窗口', adaptiveSamples: '最少样本', adaptiveBoundary: '下一个工作流生效',
    modelActivity: '模型调用概览', modelActivityHint: '聚合本 Hub 内存中最近 500 个任务的真实调用证据，最多显示 50 个模型；不保存提示词、结果或凭据。', noModelActivity: '还没有真实模型调用。',
    calls: '调用次数', invocationSource: '任务来源', routingSource: '路由来源', lastCalled: '最近调用', role: '角色', model: '模型', never: '—',
    col: { id: '任务', role: '角色', source: '来源', model: '模型', tier: '档位', status: '状态', progress: '进度', tokens: 'tokens ⇅', task: '内容' },
    working: '处理中…',
    tips: {
      claude: {
        install: '一键装进 Claude Code：注册本地 marketplace、claude plugin install、写入工具权限白名单、接线 claude-hud worker 段；修改 settings.json 前自动备份',
        update: '重跑安装流程：刷新注册与权限、迁移旧格式配置、更新 HUD 接线；幂等，可放心点',
        restore: '从 Claude Code 移除集成：清除 marketplace 注册、插件启用项与权限规则（settings 先备份）；不删除插件源码与已跑任务',
      },
      codex: {
        install: '把 ds-flash / ds-pro 角色和 /dsh-config、/dsh-status 命令复制到 ~/.codex/（MCP 路径按本机自动渲染，含 approve 审批与超时配置）',
        update: '重新渲染并覆盖角色文件与命令（插件路径或配置变更后用）；原文件先备份',
        restore: '删除 ~/.codex/ 下的 ds-flash / ds-pro 角色与 dsh 命令文件（角色文件先备份）',
      },
      zcode: {
        install: '安装 ZCode 全局规则、ds-worker / ds-reviewer 角色、命令和按来源选择的 MCP 配置到 ~/.zcode/',
        update: '重新渲染 ZCode 角色、命令和 MCP 条目；保留个人文件与其他 MCP 服务',
        restore: '仅移除 dsh-crew 管理的 ZCode 文件和 MCP 条目（保留备份）',
      },
    },
  },
  en: {
    label: 'DSH Crew',
    title: 'DSH Crew',
    intro: 'The daily Crew console: configure orchestration, roles, model routing, and host integrations in one place while tracking real Worker / Reviewer jobs.',
    integrations: 'Integrations',
    installed: 'installed', notInstalled: 'not installed', ready: 'ready', notReady: 'not ready', hud: 'HUD segment',
    install: 'Install', update: 'Update', restore: 'Restore',
    confirmRestore: (name: string) => `Remove the dsh-crew integration from ${name}? (settings are backed up first)`,
    globalConfig: 'Global configuration',
    expandAll: 'Expand all', collapseAll: 'Collapse all',
    modelCount: (count: number) => `${count} models`, providerCount: (count: number) => `${count} providers`,
    jobCount: (count: number) => `${count} jobs`, runningCount: (count: number) => `${count} running`,
    sectionNames: { integrations: 'Codex / Claude / ZCode integration status', workflow: 'Crew workflow settings', flash: 'Worker / Flash', pro: 'Reviewer / Pro', dispatch: 'Model priority & dispatch', adaptive: 'Adaptive routing', runtime: 'Runtime / activation boundaries', multimodal: 'Vision & image generation', harnessProviders: 'Harness Providers', providers: 'Multimodal adapters', jobs: 'Task status' },
    openHarness: 'Open 3210 Crew Harness →',
    harnessHint: 'Low-level providers, Harness Models, and runtime configuration',
    hostReadiness: 'Host integration readiness', hostReadinessHint: 'Uses structured installer and runtime evidence only; missing evidence is never READY.',
    readinessLabels: { codex_mcp: 'Codex MCP', ds_worker: 'ds-worker', ds_reviewer: 'ds-reviewer', claude_plugin: 'Claude plugin', zcode_mcp: 'ZCode MCP', crew_harness: 'Crew Harness', official_bridge: 'Official bridge' },
    readinessStates: { READY: 'READY', DEGRADED: 'DEGRADED', UNAVAILABLE: 'UNAVAILABLE', UNKNOWN: 'UNKNOWN' },
    globalHint: 'Changes save instantly to ~/.config/dsh-crew/config.json; new CC / Codex sessions pick them up as defaults (override per session with /dsh-crew:config).',
    orchestration: 'Agent orchestration',
    enableSubagents: 'Enable Subagents',
    enableSubagentsHint: 'Master switch. When off, dsh_run_worker / dsh_spawn_worker refuse dispatch at the tool layer (the configuration is kept; re-enable to restore).',
    subagentsKept: 'Configuration kept',
    mainAgentMode: 'Main Agent Mode',
    mainAgentModeDesc: { 'direct-allowed': 'Direct Allowed · implement directly or delegate', 'coordinator-first': 'Coordinator First · plan, decompose, delegate, verify', 'dispatcher-only': 'Dispatcher Only · plan, dispatch, review, integrate' },
    mainAgentModeHint: 'Host routing guidance — not a hard restriction on the host\'s own tools.',
    collaborationMode: 'Collaboration Mode',
    collaborationModeDesc: { 'flash-only': 'Flash Only', 'pro-only': 'Pro Only', balanced: 'Balanced', 'review-pipeline': 'Review Pipeline · implement + review', custom: 'Custom' },
    tierCardFlash: 'Flash', tierCardPro: 'Pro',
    tierState: 'State',
    tierStateDesc: { disabled: 'Disabled', manual: 'Manual (only when the user names this tier)', auto: 'Auto (the orchestrator may delegate to it)' },
    stateManagedByPreset: 'managed by the collaboration mode',
    statePresetHint: 'Switch to Custom to configure each tier state separately.',
    workerProvider: 'Worker Provider',
    workerProviderDesc: { 'follow-dsh': 'Follow Harness · use each tier\'s ordered model priority', 'deepseek-official': 'DeepSeek Official · use legacy fixed model routing' },
    workerProviderHint: 'Applies to Hub workers only; Standalone is legacy migration metadata only and is not a production execution path.',
    workerModels: 'Worker Models', refreshHarnessModels: 'Refresh Harness Models', refreshingModels: 'Refreshing…',
    modelPriority: 'Model Priority', addPriorityModel: '＋ Add Priority Model', modelSearch: 'Search Provider or Model…',
    harnessDefault: 'Harness Default', providerUnavailable: 'Provider unavailable', notAdvertised: 'Currently not advertised',
    noPriority: 'No priority models configured', modelPoolSummary: (p: number, m: number) => `Providers: ${p} · Models: ${m}`,
    healthUnprobed: 'UNPROBED', checkedAgo: (s: number) => `checked ${s}s ago`,
    partialCatalog: 'Some providers failed to load', catalogFailed: 'Unable to read Harness model catalog', removePriority: 'Remove', moveUp: 'Move up', moveDown: 'Move down',
    needsModelSelection: 'Multiple providers advertise the preferred model and Harness Default cannot disambiguate them. Falling back to Harness Default; choose a priority model explicitly.',
    responsibilities: 'Responsibilities',
    responsibilitiesHint: 'Routing guidance describing the split of work; with a single Auto tier left, that tier carries all delegatable coding work.',
    roleLabels: { implementation: 'Code implementation', simple_fix: 'Simple fixes', tests: 'Tests', search_inspection: 'Search / inspection', architecture: 'Architecture', complex_debugging: 'Complex debugging', refactor: 'Refactoring', code_review: 'Code review' },
    routing: 'Routing',
    proReviewsFlash: 'Pro reviews Flash changes',
    proReviewsFlashHint: 'Automatically follow a successful Flash run with one Pro review (blocking dispatch only)',
    proReviewsLocked: 'always on in Review Pipeline mode',
    enableCrewVision: 'Enable Crew Vision',
    enableCrewVisionHint: 'When off, the Crew describe_image tool and vision route are not registered (coexist with your own dsh-vision or other plugins).',
    enableImagegen: 'Enable Image Generation',
    enableImagegenHint: 'When off, the Crew generate_image tool is not registered.',
    capRestartHint: 'This switch changes tool registration and takes effect after a DSH restart',
    capDisabledNote: 'Crew tool/route disabled (effective after DSH restart)',
    tier: 'Default tier', effort: 'Default effort', mode: 'Mode', timeout: 'Timeout (s)', hubUrl: 'Hub URL',
    tierPolicy: 'Tier policy', escalate: 'Escalate on failure',
    tierPolicyDesc: { auto: 'auto · orchestrator picks', 'flash-only': 'flash only', 'pro-only': 'pro only' },
    escalateHint: 'retry a failed flash run once on pro',
    presetFlash: 'flash preset', presetPro: 'pro preset',
    multimodal: 'Multimodal',
    visionProvider: 'Vision provider', visionModel: 'Vision model', imagegenProvider: 'Image-gen provider',
    harnessProviders: 'Harness Providers', harnessProviderHint: 'Live Provider registration and lifecycle in the 3210 Crew Harness; separate from vision / image-gen adapters.',
    providerState: (state: string) => `State: ${state}`, providerModels: (count: number) => `${count} models`, providerJobs: (count: number) => `${count} running jobs`,
    providerOfficialBuiltin: '· official built-in (immutable)', providerSourceUnresolved: '· source unresolved (locked)',
    providerLayerMigration: 'Legacy profile Providers detected', providerLayerMigrationHint: 'These Providers still exist in the Crew profile/base layer, so the native 3210 page cannot show Delete. Promote them to Harness user settings with an explicit plan; keys are never copied.', providerLayerMigrationPlan: 'Migration plan', providerLayerMigrate: 'Migrate to user layer', providerLayerMigrating: 'Migrating…', providerLayerMigrationConfirm: 'Move this Provider into Harness user settings? A rollback snapshot is saved first; credential values are never copied.', providerLayerRollback: 'Rollback migration',
    providerDeletePlan: 'Plan deletion', providerDelete: 'Confirm delete', providerPlanReady: 'Plan ready; a second confirmation is required before changing 3210 config.', providerRollback: 'Rollback', providerRollbackConfirm: 'Restore this Harness Provider and its previous routing from the saved transaction?', providerRollbackUnavailable: 'No verified rollback transaction is available',
    providerReplacement: 'Replacement Harness Default provider id', providerDeleteConfirm: 'Delete this Harness Provider per the plan? Routing refs will be scrubbed and 3210 restarted.',
    providerDeleteBlocked: 'This Provider cannot be deleted (built-in, in use, already absent, or missing a valid replacement).', providerLifecycleError: 'Provider lifecycle operation failed', providerDeletePending: 'Configuration may already be changed; the transaction still needs restart/verification. Refresh status and use rollback if needed.', providerRollbackContinue: 'Continue rollback verification', recoveryUnresolved: 'An unrecoverable recovery transaction is blocking deletion', recoveryStorage: 'storage entry', recoveryQuarantine: 'Quarantine', recoveryQuarantineConfirm: 'This recovery manifest cannot be safely reopened. Move it into the quarantine area and keep it out of automatic recovery?',
    providerNoInventory: '3210 Provider inventory is temporarily unavailable.',
    credentialReferences: 'Credential references', credentialReferenceHint: 'Names, ownership, and orphan status only; values are never read or deleted.',
    credentialOrphan: 'orphan · separate purge approval required', credentialInUse: (count: number) => `in use · ${count} provider(s)`, credentialPurgePlan: 'Purge…', credentialPurgeConfirm: 'This irreversibly removes a Crew-owned credential. Continue?', credentialPurging: 'Purging…', credentialPurgeUnavailable: 'Credential purge unavailable', credentialPurgeUnverified: 'Purge ran but verification failed; the reference remains visible for recovery',
    customProviders: 'Multimodal adapters', addProvider: '＋ Add multimodal adapter',
    noCustomProviders: 'None yet. Added providers appear in the vision / image-gen selects above.',
    providerName: 'Name', modelsField: 'Models (comma-separated)',
    providerType: 'Connection', typeApi: 'API · OpenAI-compatible', typeCli: 'CLI · local command',
    baseUrl: 'Base URL', apiKey: 'API key', imagegenModel: 'Image-gen model (empty = no image generation)',
    visionCmd: 'Vision command (optional)', imagegenCmd: 'Image-gen command (optional)',
    apiFormHint: 'OpenAI-compatible: vision calls {base}/chat/completions (image inlined as base64), image-gen calls {base}/images/generations. The key is stored locally in ~/.config/dsh-crew/config.json and never sent to third parties.',
    cliFormHint: 'Commands run via bash with shell-quoted placeholders. Vision: {image} {question} {model}, stdout is the answer; image-gen: {prompt} {output} {size}, the command must write the image to {output}. Fill in at least one command.',
    saveProvider: 'Save', cancel: 'Cancel', edit: 'Edit', del: 'Delete',
    testProvider: 'Test', testing: 'Testing…',
    testTip: 'Probes what is currently filled in: API checks reachability and auth then makes one real vision call; CLI checks the executable then runs the vision command once. Image generation is only validated, never actually run.',
    testPass: 'Connection OK', testFail: 'Connection failed',
    staleHub: 'This DSH instance is still running an older build of the plugin and lacks this route — restart DSH and retry',
    emptyResponse: (path: string, status: number) => `${path} → HTTP ${status}, empty response`,
    badJson: (path: string, body: string) => `${path} → non-JSON response: ${body}`,
    refreshModels: 'Re-fetch the model list from the CLI',
    presetDefault: (id?: string) => `default · follow DSH${id ? ` (${id})` : ''}`,
    progressTip: (t: string, turn: number, step: number, calls: number | string) => `${t} elapsed · turn ${turn}, step ${step} · ${calls} tool calls`,
    confirmDeleteProvider: (n: string) => `Delete custom provider "${n}"?`,
    needName: '⚠ Name is required', needCmd: '⚠ Fill in at least one command',
    needBaseUrl: '⚠ Base URL is required', needModels: '⚠ Add at least one model',
    keySet: 'set', keyPlaceholder: 'sk-… (leave empty to send no Authorization header)',
    addModelTip: 'Add a model to the list', removeModelTip: 'Remove the current model from the list', modelPlaceholder: 'model id, Enter to confirm',
    capVision: 'vision', capImagegen: 'image-gen',
    groupDispatch: 'Dispatch', groupRuntime: 'Runtime', groupMultimodal: 'Multimodal',
    groupWorkflow: 'Workflow / Execution (v0.2)',
    roleWorker: 'Worker role (execution)', roleReviewer: 'Reviewer role (independent review)',
    workerStateLabel: 'Worker state', reviewStateLabel: 'Reviewer state',
    roleStateHint: 'auto = the orchestrator may dispatch automatically; manual = only when explicitly named; disabled = off. When unset, derived from the collaboration mode.',
    autoReview: 'Automatic review', autoReviewHint: 'Run one reviewer pass (independent model policy, read-only) after a successful worker run',
    modelOrdering: 'Candidate ordering', orderingDesc: { manual: 'Manual order', 'health-aware': 'Health-aware' },
    orderingHint: 'Explicit priority always keeps its order; health-aware mode only reorders automatic, unlocked candidates.',
    healthGate: 'Health gate', healthGateDesc: { 'hard-failures': 'Skip known hard failures', off: 'Health gate off' },
    reviewGate: 'Reviewer acceptance gate', reviewGateDesc: { required: 'required · fail unless approved', optional: 'optional · record without blocking', off: 'off · no automatic review' },
    isolation: 'Workspace isolation', isolationHint: 'worktree is the default; non-git workspaces require explicit shared, otherwise jobs fail with NOT_GIT_REPOSITORY.',
    isolationDesc: { worktree: 'worktree · each coding worker runs in its own temporary git worktree (primary untouched)', shared: 'shared · legacy in-place execution' },
    maxParallel: 'Max parallel', maxParallelHint: 'Upper bound of concurrently running workflows (1–16); extra ones queue.',
    legacyCompatibility: '↓ Legacy compatibility controls below (Flash/Pro still editable)',
    cardDispatch: { t: 'Dispatch policy', d: 'Tier and effort used when the orchestrator names none, plus tier clamping, failure escalation and the Agent preset mounted per tier.' },
    cardRuntime: { t: 'Execution & connection', d: 'Whether worker sessions run inside this instance or a separate process, the per-job timeout, and the address CC / Codex probes.' },
    cardMM: { t: 'Vision & image generation', d: "Lends the harness's text-only models eyes and a brush: describe_image, pasted-image transcription and generate_image all use these settings." },
    cardCustomProv: { t: 'Custom providers', d: 'Bring your own API or local command; saved providers appear in the vision / image-gen selects above.' },
    modeDesc: { auto: 'auto · prefer 3210', hub: 'hub · require 3210' },
    save: 'Save', saved: 'Saved', jobs: 'Worker jobs', empty: 'No Worker / Reviewer jobs yet.',
    adaptiveTitle: 'Adaptive model routing (experimental)', adaptiveHint: 'Off by default. Only system-derived candidates may be reordered; explicit model priorities always keep their order. Health uses only process-local success, failure, timeout, and coarse latency observations and resets on restart.',
    adaptiveEnabled: 'Enable adaptive routing', adaptiveWindow: 'Health window', adaptiveSamples: 'Minimum samples', adaptiveBoundary: 'Effective for the next workflow',
    modelActivity: 'Model invocation overview', modelActivityHint: 'Aggregates real invocation evidence from the latest 500 in-memory Hub jobs and shows at most 50 models; prompts, results, and credentials are never stored here.', noModelActivity: 'No real model invocations yet.',
    calls: 'Calls', invocationSource: 'Task source', routingSource: 'Routing source', lastCalled: 'Last called', role: 'Role', model: 'Model', never: '—',
    col: { id: 'job', role: 'role', source: 'source', model: 'model', tier: 'tier', status: 'status', progress: 'progress', tokens: 'tokens ⇅', task: 'task' },
    working: 'Working…',
    tips: {
      claude: {
        install: 'One-click install into Claude Code: register local marketplace, claude plugin install, permission allowlist, claude-hud segment wiring; settings.json backed up first',
        update: 'Re-run the installer: refresh registration & permissions, migrate legacy config, update HUD wiring; idempotent',
        restore: 'Remove the integration from Claude Code: marketplace registration, plugin enablement and permission rules (settings backed up); plugin source and past jobs untouched',
      },
      codex: {
        install: 'Copy ds-flash / ds-pro roles and /dsh-config, /dsh-status prompts into ~/.codex/ (MCP paths rendered for this machine, approve mode + timeout included)',
        update: 'Re-render and overwrite role files and prompts (after path/config changes); originals backed up',
        restore: 'Delete ds-flash / ds-pro roles and dsh prompts from ~/.codex/ (roles backed up first)',
      },
      zcode: {
        install: 'Install the ZCode global policy, ds-worker / ds-reviewer agents, commands and source-aware MCP config under ~/.zcode/',
        update: 'Re-render ZCode agents, commands and MCP entry; user files and unrelated MCP servers are preserved',
        restore: 'Remove only dsh-crew-owned ZCode files and MCP entry (backups kept)',
      },
    },
  },
};

const S = {
  // Margins are tuned against the page container's 8px flex gap: the gap alone
  // sits below each heading, the margin only adds separation above it.
  section: { margin: '8px 0 -2px', fontSize: 13, fontWeight: 600 as const, opacity: 0.9 },
  // Small muted group label, matching the host's Agent-preset page (内置 / 自定义).
  group: { margin: '4px 0 -3px', fontSize: 12, opacity: 0.55 },
  // Card with a title + description header above its fields.
  block: { border: '1px solid rgba(128,128,128,0.22)', borderRadius: 10, padding: '11px 14px 13px', display: 'flex', flexDirection: 'column' as const, gap: 10 },
  blockGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px 14px', alignItems: 'end' as const },
  settingTitle: { fontWeight: 600 as const, fontSize: 13 },
  settingDesc: { fontSize: 11.5, opacity: 0.6, marginTop: 2, lineHeight: 1.5 },
  card: { border: '1px solid rgba(128,128,128,0.22)', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const },
  grid: {
    border: '1px solid rgba(128,128,128,0.22)', borderRadius: 8, padding: '12px 14px',
    display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px 14px', alignItems: 'end' as const,
  },
  btn: { padding: '4px 12px', borderRadius: 6, border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12.5 },
  sectionShell: { border: '1px solid rgba(128,128,128,0.24)', borderRadius: 11, overflow: 'hidden', background: 'rgba(128,128,128,0.025)' },
  sectionButton: { width: '100%', padding: '10px 13px', border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9, textAlign: 'left' as const, font: 'inherit' },
  sectionBody: { padding: '2px 11px 12px', display: 'flex', flexDirection: 'column' as const, gap: 8 },
  chip: (on: boolean) => ({ fontSize: 11.5, padding: '1px 8px', borderRadius: 99, border: '1px solid', borderColor: on ? 'rgba(63,185,80,0.5)' : 'rgba(128,128,128,0.35)', color: on ? '#3fb950' : 'inherit', opacity: on ? 1 : 0.55 }),
  field: { display: 'flex', flexDirection: 'column' as const, gap: 3 },
  fieldLabel: { fontSize: 11, opacity: 0.6 },
  input: { padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: 12.5 },
  cell: { padding: '5px 10px 5px 0', borderBottom: '1px solid rgba(128,128,128,0.16)', textAlign: 'left' as const, verticalAlign: 'top' as const },
  tight: {
    padding: '5px 8px 5px 0', borderBottom: '1px solid rgba(128,128,128,0.16)', textAlign: 'left' as const,
    verticalAlign: 'top' as const, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis',
  },
  mono: { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, fontVariantNumeric: 'tabular-nums' as const },
};

const VISION_MODELS: Record<string, string[]> = {
  'claude-code': ['haiku', 'sonnet', 'opus'],
  codex: ['default', 'gpt-5.4-mini', 'gpt-5.6'],
  grok: ['default'],
  agy: ['default'],
};

function CustomSelect({ value, options, onChange, minWidth }: {
  value: string; options: Array<{ value: string; label?: string }>;
  onChange: (v: string) => void; minWidth?: number;
}) {
  const [open, setOpen] = useState<{ left: number; top: number; bottom: number; width: number; up: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const t = setTimeout(() => document.addEventListener('mousedown', close), 0);
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const current = options.find((o) => o.value === value);
  return (<>
    <button type="button"
      style={{ ...S.input, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', minWidth: minWidth ?? 92, width: '100%', boxSizing: 'border-box' as const, justifyContent: 'space-between' }}
      onClick={(e: any) => {
        const r = e.currentTarget.getBoundingClientRect();
        const up = window.innerHeight - r.bottom < 240;
        setOpen({ left: r.left, top: r.bottom + 4, bottom: window.innerHeight - r.top + 4, width: Math.max(r.width, 130), up });
      }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current?.label ?? value}</span>
      <span style={{ opacity: 0.5, fontSize: 10 }}>▾</span>
    </button>
    {open && createPortal(
      <div
        style={{
          position: 'fixed', left: open.left, ...(open.up ? { bottom: open.bottom } : { top: open.top }),
          minWidth: open.width, zIndex: 9999, background: 'Canvas', color: 'CanvasText',
          border: '1px solid rgba(128,128,128,0.3)', borderRadius: 8,
          boxShadow: '0 8px 28px rgba(0,0,0,0.22)', padding: 4, maxHeight: 240, overflowY: 'auto',
        }}
        onMouseDown={(e: any) => e.stopPropagation()}>
        {options.map((o) => (
          <div key={o.value}
            onClick={() => { onChange(o.value); setOpen(null); }}
            style={{
              padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, whiteSpace: 'nowrap',
              background: o.value === value ? 'rgba(128,128,128,0.16)' : 'transparent',
              display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center',
            }}
            onMouseEnter={(e: any) => { e.currentTarget.style.background = 'rgba(128,128,128,0.24)'; }}
            onMouseLeave={(e: any) => { e.currentTarget.style.background = o.value === value ? 'rgba(128,128,128,0.16)' : 'transparent'; }}>
            <span>{o.label ?? o.value}</span>{o.value === value && <span style={{ opacity: 0.6, fontSize: 11 }}>✓</span>}
          </div>
        ))}
      </div>, document.body)}
  </>);
}

function sectionSummary(...parts: Array<string | number | false | null | undefined>) {
  return parts.filter((part) => part !== false && part !== null && part !== undefined && part !== '').join(' · ');
}

function sectionStorage() {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

function CollapsibleSection({ sectionId, title, summary, expanded, onToggle, children }: {
  sectionId: string; title: string; summary: string; expanded: boolean;
  onToggle: () => void; children: any;
}) {
  const bodyId = `dsh-crew-section-${sectionId}`;
  return (
    <section style={S.sectionShell} data-section-id={sectionId}>
      <button type="button" style={S.sectionButton} aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
        <span aria-hidden="true" style={{ width: 14, opacity: 0.62, transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 140ms ease' }}>›</span>
        <span style={{ fontWeight: 650, fontSize: 13, minWidth: 92 }}>{title}</span>
        <span title={summary} style={{ flex: 1, minWidth: 0, fontSize: 11.5, opacity: 0.58, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
      </button>
      <div id={bodyId} hidden={!expanded} style={expanded ? S.sectionBody : undefined}>{children}</div>
    </section>
  );
}

function sourceLabel(source?: string) {
  if (source === 'claude-code') return 'CC';
  if (source === 'codex') return 'Codex';
  if (source === 'api' || source === undefined) return 'API';
  return source;
}

function elapsed(startedAt: string, endedAt?: string | null) {
  const s = Math.max(0, Math.round(((endedAt ? +new Date(endedAt) : Date.now()) - +new Date(startedAt)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}
function ktok(n: number) { return n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`; }

function formatTimestamp(value: string | null, locale: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value));
}

function readinessChip(state: string) {
  const color = state === READINESS_STATES.READY ? '#3fb950'
    : state === READINESS_STATES.DEGRADED ? '#c98735'
      : state === READINESS_STATES.UNAVAILABLE ? '#f85149' : 'inherit';
  return {
    fontSize: 10.5, fontWeight: 650, padding: '1px 7px', borderRadius: 99,
    border: `1px solid ${state === READINESS_STATES.UNKNOWN ? 'rgba(128,128,128,0.35)' : color}`,
    color, opacity: state === READINESS_STATES.UNKNOWN ? 0.58 : 1,
  };
}

function MinimalCrewPanel({ locale, surface, runtime }: { locale: string; surface: string; runtime: any }) {
  const zh = locale === 'zh';
  const native = surface === CREW_UI_SURFACES.NATIVE;
  const title = native ? (zh ? 'DSH Crew Runtime' : 'DSH Crew Runtime') : (zh ? 'DSH Crew Surface 未确认' : 'DSH Crew surface not verified');
  const hint = native
    ? (zh
      ? '这里是隔离的 3210 Crew Harness。请使用 Harness 原生菜单管理 Provider、Harness Models、Agent 预设与底层配置；Crew 编排和宿主集成统一在 3080 管理。'
      : 'This is the isolated 3210 Crew Harness. Use the native Harness menus for Providers, Harness Models, Agent presets, and low-level settings; manage Crew orchestration and host integrations on 3080.')
    : (zh
      ? '无法用结构化后端证据确认当前界面，因此已保守隐藏 Crew 编排、任务与宿主集成功能。'
      : 'Structured backend evidence could not identify this surface, so Crew orchestration, jobs, and host integrations are conservatively hidden.');
  const runtimeReady = runtime?.ok === true && runtime?.service === 'dsh-crew-hub';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: 1.55 }}>
      <div style={{ ...S.block, background: 'linear-gradient(135deg, rgba(74,158,255,0.08), rgba(128,128,128,0.02))' }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 680 }}>{title}</div>
          <div style={{ fontSize: 12, opacity: 0.68, marginTop: 3 }}>{hint}</div>
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          <span style={readinessChip(runtimeReady ? READINESS_STATES.READY : READINESS_STATES.UNKNOWN)}>
            {runtimeReady ? `Runtime ${runtime.runtime_version ?? 'READY'}` : 'Runtime UNKNOWN'}
          </span>
          <span style={readinessChip(native ? READINESS_STATES.READY : READINESS_STATES.UNKNOWN)}>
            {native ? '3210 · isolated' : 'surface · unknown'}
          </span>
        </div>
        <a href={CREW_CONTROL_PLANE_URL} target="_blank" rel="noopener noreferrer" style={{
          ...S.btn, alignSelf: 'flex-start', textDecoration: 'none', fontWeight: 650, padding: '7px 12px',
          borderColor: 'rgba(74,158,255,0.55)', background: 'rgba(74,158,255,0.08)',
        }}>{zh ? '打开 3080 DSH Crew 控制台 →' : 'Open the 3080 DSH Crew console →'}</a>
      </div>
    </div>
  );
}

function WorkersPanel({ ctx }: { ctx: any }) {
  const locale = useSyncExternalStore(
    (notify: () => void) => ctx.on('locale/change', notify),
    () => ctx.locale.getLocale().active,
    () => ctx.locale.getLocale().active,
  );
  const copy = COPY[locale === 'zh' ? 'zh' : 'en'];

  const [jobs, setJobs] = useState<any[]>([]);
  const [hoverTask, setHoverTask] = useState<{ id: string; text: string; right: number; top: number; bottom: number; flip: boolean } | null>(null);
  const [status, setStatus] = useState<any>(null);
  const [config, setConfig] = useState<any>(null);
  const [dynModels, setDynModels] = useState<Record<string, Array<{ value: string; label?: string }>>>({});
  const [presetOptions, setPresetOptions] = useState<Array<{ value: string; label?: string }>>([{ value: 'default' }]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [provForm, setProvForm] = useState<{
    originalId?: string; name: string; type: 'api' | 'cli'; models: string;
    base_url: string; api_key: string; imagegen_model: string;
    vision_command: string; imagegen_command: string;
  } | null>(null);
  const [modelAdd, setModelAdd] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] = useState<any>(null);
  const [modelCatalogError, setModelCatalogError] = useState('');
  const [modelCatalogBusy, setModelCatalogBusy] = useState(false);
  const [providerInventory, setProviderInventory] = useState<any>(null);
  const [providerHealth, setProviderHealth] = useState<any[]>([]);
  const [credentialRefs, setCredentialRefs] = useState<any[]>([]);
  const [credentialUnverified, setCredentialUnverified] = useState<any[]>([]);
  const [credentialLifecycleBusy, setCredentialLifecycleBusy] = useState<string | null>(null);
  const [providerInventoryError, setProviderInventoryError] = useState('');
  const [providerLifecycleBusy, setProviderLifecycleBusy] = useState<string | null>(null);
  const [modelPickerTier, setModelPickerTier] = useState<'flash' | 'pro' | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const [testResult, setTestResult] = useState<{ key: string; ok?: boolean; steps?: any[]; error?: string; busy: boolean } | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(() => readSectionState(sectionStorage()));
  const [surface, setSurface] = useState<string>('detecting');
  const [runtimeInfo, setRuntimeInfo] = useState<any>(undefined);
  const [readinessSnapshot, setReadinessSnapshot] = useState<any>(undefined);

  const toggleSection = (sectionId: string) => {
    setExpandedSections((current) => ({ ...current, [sectionId]: !current[sectionId] }));
  };
  const toggleAllSections = (expanded: boolean) => setExpandedSections(setEverySection(expanded));

  useEffect(() => {
    writeSectionState(sectionStorage(), expandedSections);
  }, [expandedSections]);

  useEffect(() => {
    if (modelCatalogError) setExpandedSections((current) => openSections(current, ['workflow', 'flash', 'pro']));
  }, [modelCatalogError]);

  useEffect(() => {
    if (providerInventoryError) setExpandedSections((current) => openSections(current, ['harnessProviders']));
  }, [providerInventoryError]);

  useEffect(() => {
    if (testResult && !testResult.busy && testResult.ok === false) {
      setExpandedSections((current) => openSections(current, ['providers']));
    }
  }, [testResult]);

  useEffect(() => {
    if (jobs.some((job) => job.status === 'running')) {
      setExpandedSections((current) => openSections(current, ['jobs']));
    }
  }, [jobs]);

  /**
   * The panel is served from disk on every load, but the hub's routes are
   * registered at instance boot — after an upgrade the new UI can call a route
   * the running instance does not have yet, which answers 404/405 with an empty
   * body. Report that as "restart DSH" instead of a JSON parse error.
   */
  const readJson = useCallback(async (res: Response, path: string) => {
    const text = await res.text();
    if (text === '') {
      throw new Error(res.status === 404 || res.status === 405
        ? `${copy.staleHub}（${path} → HTTP ${res.status}）`
        : copy.emptyResponse(path, res.status));
    }
    try { return JSON.parse(text); } catch { throw new Error(copy.badJson(path, text.slice(0, 160))); }
  }, [copy]);
  /** Every request carries the active locale: the panel is the authority on it
   * (DSH's setting may be unset), and the hub localizes its own strings from it. */
  const withLang = useCallback((path: string) => `${API}${path}${path.includes('?') ? '&' : '?'}lang=${locale === 'zh' ? 'zh' : 'en'}`, [locale]);
  const get = useCallback(async (path: string) => readJson(await fetch(withLang(path), { cache: 'no-store' }), path), [readJson, withLang]);
  const post = useCallback(async (path: string, body: any) => readJson(await fetch(withLang(path), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, lang: locale === 'zh' ? 'zh' : 'en' }),
  }), path), [readJson, withLang, locale]);

  const detectSurface = useCallback(async () => {
    const readOptional = async (path: string) => {
      try {
        const response = await fetch(`${API}${path}`, { cache: 'no-store' });
        if (!response.ok) return null;
        const body = await response.json();
        return body && typeof body === 'object' ? body : null;
      } catch { return null; }
    };
    const [bridgeStatus, runtime] = await Promise.all([
      readOptional('/bridge-status'),
      readOptional('/runtime'),
    ]);
    setRuntimeInfo(runtime);
    setSurface(classifyCrewSurface({ bridgeStatus, runtime }));
  }, []);

  useEffect(() => { void detectSurface(); }, [detectSurface]);

  const refreshAll = useCallback(async () => {
    try {
      const [j, s, c, pr, pi, ph, cr, ext] = await Promise.all([
        get('/jobs'), get('/install/status'), get('/config'), get('/presets'),
        get('/providers').catch(() => null), get('/provider-health').catch(() => null), get('/credential-references').catch(() => null), get('/extension').catch(() => null),
      ]);
      if (j.ok) setJobs(j.jobs ?? []);
      if (s.ok) setStatus(s.status);
      if (c.ok) setConfig((prev: any) => prev ?? c.config);
      if (pr.ok) setPresetOptions([
        { value: 'default', label: copy.presetDefault(pr.defaultId) },
        ...(pr.presets ?? []).map((x: any) => ({ value: x.id, label: x.name ?? x.id })),
      ]);
      if (pi?.ok) setProviderInventory(pi);
      if (ph?.ok) setProviderHealth(ph.health ?? []);
      if (cr?.ok) { setCredentialRefs(cr.records ?? []); setCredentialUnverified(cr.unverified_purges ?? []); }
      if (ext?.ok) setReadinessSnapshot(ext.extension?.readiness_snapshot ?? undefined);
    } catch { /* instance restarting */ }
  }, [get]);

  useEffect(() => {
    if (surface !== CREW_UI_SURFACES.OFFICIAL) return undefined;
    void refreshAll();
    const timer = setInterval(() => {
      void Promise.all([get('/jobs'), get('/provider-health').catch(() => null)]).then(([j, health]) => {
        if (j.ok) setJobs(j.jobs ?? []);
        if (health?.ok) setProviderHealth(health.health ?? []);
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [surface, refreshAll, get]);

  const refreshHarnessModels = useCallback(async () => {
    setModelCatalogBusy(true);
    setModelCatalogError('');
    try {
      const result = await get('/models');
      if (!result.ok) throw new Error(result.error ?? copy.catalogFailed);
      setModelCatalog(result);
    } catch (error: any) {
      setModelCatalogError(error?.message ?? copy.catalogFailed);
    } finally {
      setModelCatalogBusy(false);
    }
  }, [get, copy]);

  const refreshProviderInventory = useCallback(async () => {
    setProviderInventoryError('');
    try {
      const [result, health, refs] = await Promise.all([get('/providers'), get('/provider-health').catch(() => null), get('/credential-references').catch(() => null)]);
      if (!result.ok) throw new Error(result.error ?? copy.providerNoInventory);
      setProviderInventory(result);
      if (health?.ok) setProviderHealth(health.health ?? []);
      if (refs?.ok) { setCredentialRefs(refs.records ?? []); setCredentialUnverified(refs.unverified_purges ?? []); }
    } catch (error: any) {
      setProviderInventoryError(error?.message ?? copy.providerNoInventory);
    }
  }, [get, copy]);

  const purgeCredentialRef = useCallback(async (ref: any) => {
    if (ref?.ownership !== 'crew-owned' || ref?.orphan !== true || ref?.purge_capability !== 'eligible') return;
    const referenceId = String(ref.reference_id ?? '');
    if (!referenceId || !window.confirm(copy.credentialPurgeConfirm)) return;
    setCredentialLifecycleBusy(referenceId);
    setNotice(copy.working);
    try {
      const encoded = encodeURIComponent(referenceId);
      const planned = await post(`/credential-references/${encoded}/purge-plan`, {});
      if (!planned.ok || !planned.plan) throw new Error(planned.code ?? copy.credentialPurgeUnavailable);
      if (!window.confirm(`${copy.credentialPurgeConfirm}\n\n${referenceId}`)) return;
      const result = await readJson(await fetch(withLang(`/credential-references/${encoded}`), {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan_id: planned.plan.plan_id, expected_revision: planned.plan.expected_revision, confirm: true, lang: locale === 'zh' ? 'zh' : 'en' }),
      }), `/credential-references/${encoded}`);
      if (!result.ok || result.state !== 'VERIFIED') throw new Error(result.code ?? copy.credentialPurgeUnavailable);
      setNotice(copy.saved);
      await refreshProviderInventory();
    } catch (error: any) {
      setNotice(String(error?.message ?? error));
    } finally {
      setCredentialLifecycleBusy(null);
    }
  }, [copy, locale, post, readJson, refreshProviderInventory, withLang]);

  useEffect(() => {
    if (surface === CREW_UI_SURFACES.OFFICIAL) void refreshHarnessModels();
  }, [surface, refreshHarnessModels]);

  useEffect(() => {
    if (surface === CREW_UI_SURFACES.OFFICIAL) void refreshProviderInventory();
  }, [surface, refreshProviderInventory]);

  const act = useCallback(async (target: string, confirmName?: string) => {
    if (confirmName && !window.confirm(copy.confirmRestore(confirmName))) return;
    setBusy(true); setNotice(copy.working);
    try {
      const r = await post('/install', { target });
      if (r.ok === false) throw new Error(r.error);
      setNotice((r.actions ?? []).join('；'));
      const s = await get('/install/status'); if (s.ok) setStatus(s.status);
    } catch (e: any) { setNotice(String(e?.message ?? e)); } finally { setBusy(false); }
  }, [post, get, copy]);

  const applyPatch = useCallback(async (patch: Record<string, any>) => {
    try {
      const result = await post('/config', patch);
      if (!result.ok) throw new Error(result.error ?? 'Configuration save failed');
      setConfig(result.config);
      setNotice(copy.saved);
      setTimeout(() => setNotice(''), 1500);
      return true;
    } catch (error: any) {
      setNotice(String(error?.message ?? error));
      try {
        const authoritative = await get('/config');
        if (authoritative.ok) setConfig(authoritative.config);
      } catch { /* keep the error visible while the Hub is unavailable */ }
      return false;
    }
  }, [post, get, copy]);
  /** Selects & checkboxes: apply immediately. */
  const field = (key: string, value: any) => {
    setConfig((c: any) => ({ ...c, [key]: value }));
    void applyPatch({ [key]: value });
  };
  /** Text/number inputs: track locally, apply on blur. */
  const fieldLocal = (key: string, value: any) => setConfig((c: any) => ({ ...c, [key]: value }));
  const rolePolicyField = (role: 'worker' | 'review', patch: Record<string, any>) => {
    const effectivePatch = role === 'worker' && (patch.ordering === 'manual' || patch.ordering === 'health-aware')
      ? { ...patch, adaptive: { ...normalizeAdaptive(config?.worker?.model_policy?.adaptive), enabled: patch.ordering === 'health-aware' } }
      : patch;
    setConfig((current: any) => ({
      ...current,
      [role]: {
        ...current?.[role],
        model_policy: { ...current?.[role]?.model_policy, ...effectivePatch },
      },
    }));
    void applyPatch({ [role]: { model_policy: effectivePatch } });
  };
  const reviewField = (patch: Record<string, any>) => {
    setConfig((current: any) => ({ ...current, review: { ...current?.review, ...patch } }));
    void applyPatch({ review: patch });
  };

  // --- custom providers & user-added models -------------------------------
  const customProviders: any[] = config?.custom_providers ?? [];
  const extraModels: Record<string, string[]> = config?.extra_models ?? {};
  const RESERVED_IDS = ['claude-code', 'codex', 'grok', 'agy', 'off', 'custom', 'default'];
  const provType = (p: any): 'api' | 'cli' => p.type ?? ((p.vision_command || p.imagegen_command) ? 'cli' : 'api');
  const canSee = (p: any) => (provType(p) === 'cli' ? !!p.vision_command : !!p.base_url && (p.models?.length ?? 0) > 0);
  const canDraw = (p: any) => (provType(p) === 'cli' ? !!p.imagegen_command : !!p.base_url && !!String(p.imagegen_model ?? '').trim());
  const visionProviderOptions = [
    { value: 'claude-code' }, { value: 'codex' }, { value: 'grok' }, { value: 'agy' },
    ...customProviders.filter(canSee).map((p) => ({ value: p.id, label: p.name || p.id })),
    { value: 'off' },
  ];
  const imagegenProviderOptions = [
    { value: 'codex' }, { value: 'agy', label: 'agy (nano banana)' }, { value: 'grok', label: 'grok (imagine)' },
    ...customProviders.filter(canDraw).map((p) => ({ value: p.id, label: p.name || p.id })),
    { value: 'off' },
  ];
  const visionModelOptions = (() => {
    if (!config) return [];
    const p = config.vision_provider;
    const custom = customProviders.find((c) => c.id === p);
    const base: Array<{ value: string; label?: string }> = custom
      ? [{ value: 'default' }, ...(custom.models ?? []).map((m: string) => ({ value: m }))]
      : dynModels[p] ?? (VISION_MODELS[p] ?? ['default']).map((m) => ({ value: m }));
    const extras = (extraModels[p] ?? []).filter((m) => !base.some((o) => o.value === m)).map((m) => ({ value: m }));
    return [...base, ...extras];
  })();
  const commitModelAdd = () => {
    const m = (modelAdd ?? '').trim();
    setModelAdd(null);
    if (m === '' || !config) return;
    const p = config.vision_provider;
    const cur = extraModels[p] ?? [];
    const nextExtra = { ...extraModels, [p]: cur.includes(m) ? cur : [...cur, m] };
    setConfig((c: any) => ({ ...c, extra_models: nextExtra, vision_model: m }));
    void applyPatch({ extra_models: nextExtra, vision_model: m });
  };
  const removeCurrentModel = () => {
    if (!config) return;
    const p = config.vision_provider;
    const m = config.vision_model;
    const nextExtra = { ...extraModels, [p]: (extraModels[p] ?? []).filter((x) => x !== m) };
    const fallback = visionModelOptions.find((o) => o.value !== m)?.value ?? 'default';
    setConfig((c: any) => ({ ...c, extra_models: nextExtra, vision_model: fallback }));
    void applyPatch({ extra_models: nextExtra, vision_model: fallback });
  };
  const saveProviderForm = () => {
    if (!provForm || !config) return;
    const name = provForm.name.trim();
    if (name === '') { setNotice(copy.needName); return; }
    const models = provForm.models.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
    const vision_command = provForm.vision_command.trim();
    const imagegen_command = provForm.imagegen_command.trim();
    if (provForm.type === 'cli') {
      if (vision_command === '' && imagegen_command === '') { setNotice(copy.needCmd); return; }
    } else {
      if (provForm.base_url.trim() === '') { setNotice(copy.needBaseUrl); return; }
      if (models.length === 0) { setNotice(copy.needModels); return; }
    }
    let id = provForm.originalId;
    if (!id) {
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
      id = base;
      let n = 2;
      while (RESERVED_IDS.includes(id) || customProviders.some((p) => p.id === id)) id = `${base}-${n++}`;
    }
    const entry = provForm.type === 'api'
      ? {
        id, name, type: 'api', models,
        base_url: provForm.base_url.trim(),
        api_key: provForm.api_key,
        imagegen_model: provForm.imagegen_model.trim(),
      }
      : { id, name, type: 'cli', models, vision_command, imagegen_command };
    const next = provForm.originalId
      ? customProviders.map((p) => (p.id === provForm.originalId ? entry : p))
      : [...customProviders, entry];
    field('custom_providers', next);
    setProvForm(null);
  };
  const runProviderTest = (key: string, entry: any) => {
    setTestResult({ key, busy: true });
    void post('/provider-test', entry)
      .then((r) => setTestResult(r.ok
        ? { key, busy: false, ok: r.result.ok, steps: r.result.steps }
        : { key, busy: false, ok: false, error: r.error }))
      .catch((e) => setTestResult({ key, busy: false, ok: false, error: String(e?.message ?? e) }));
  };
  /** Shared renderer for a test outcome under the button that triggered it. */
  const testReport = (key: string) => {
    if (!testResult || testResult.key !== key) return null;
    if (testResult.busy) return <div style={{ fontSize: 11.5, opacity: 0.6 }}>{copy.testing}</div>;
    return (
      <div style={{ fontSize: 11.5, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ color: testResult.ok ? '#3fb950' : '#f85149' }}>
          {testResult.ok ? `✓ ${copy.testPass}` : `✗ ${copy.testFail}`}
        </span>
        {testResult.error && <span style={{ opacity: 0.7, wordBreak: 'break-all' as const }}>{testResult.error}</span>}
        {(testResult.steps ?? []).map((st: any, i: number) => (
          <span key={i} style={{ opacity: 0.7, wordBreak: 'break-all' as const }}>
            <span style={{ color: st.ok ? '#3fb950' : '#f85149' }}>{st.ok ? '✓' : '✗'}</span> {st.name}: {st.detail}
          </span>
        ))}
      </div>
    );
  };
  const deleteProvider = (id: string) => {
    if (!config) return;
    const patch: any = { custom_providers: customProviders.filter((p) => p.id !== id) };
    if (config.vision_provider === id) { patch.vision_provider = 'claude-code'; patch.vision_model = 'haiku'; }
    if (config.imagegen_provider === id) patch.imagegen_provider = 'codex';
    setConfig((c: any) => ({ ...c, ...patch }));
    void applyPatch(patch);
  };

  const deleteHarnessProvider = async (record: any) => {
    if (!record || record.delete_capability !== 'supported' || record.desired_state === 'absent' || Number(record.references?.active_jobs ?? 0) > 0) {
      setNotice(copy.providerDeleteBlocked);
      return;
    }
    let replacementDefault: string | undefined;
    if (record.references?.harness_default === true) {
      const candidate = (providerInventory?.records ?? []).find((item: any) => item.id === 'deepseek-official'
        && item.id !== record.id && item.desired_state !== 'absent' && (item.models?.length ?? 0) > 0)?.id
        ?? (providerInventory?.records ?? []).find((item: any) => item.id !== record.id
          && item.desired_state !== 'absent' && item.delete_capability !== 'source-unresolved' && (item.models?.length ?? 0) > 0)?.id ?? '';
      const entered = window.prompt(copy.providerReplacement, candidate);
      if (!entered?.trim()) return;
      replacementDefault = entered.trim();
    }
    setProviderLifecycleBusy(record.id);
    setNotice(copy.working);
    try {
      const encoded = encodeURIComponent(record.id);
      const planned = await post(`/providers/${encoded}/delete-plan`, replacementDefault ? { replacement_default: replacementDefault } : {});
      if (!planned.ok || !planned.plan) throw new Error(planned.code ?? copy.providerLifecycleError);
      if (!window.confirm(`${copy.providerPlanReady}\n\n${copy.providerDeleteConfirm}\n${(planned.plan.will_remove ?? []).join('\n')}`)) return;
      const path = `/providers/${encoded}`;
      const result = await readJson(await fetch(withLang(path), {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan_id: planned.plan.plan_id, expected_revision: planned.plan.expected_revision, confirm: true, lang: locale === 'zh' ? 'zh' : 'en' }),
      }), path);
      if (!result.ok) throw new Error(result.code ?? result.error ?? copy.providerLifecycleError);
      if (result.restart_required === true && result.result?.state === 'RESTART_PENDING') {
        const restartPath = 'http://127.0.0.1:3080/_dsh/dsh-crew/supervisor/restart';
        const restarted = await readJson(await fetch(restartPath, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        }), restartPath);
        if (!restarted.ok) throw new Error(restarted.code ?? restarted.error ?? copy.providerLifecycleError);
        const verified = await post(`/providers/${encoded}/verify-delete`, { transaction_id: planned.plan.plan_id, confirm: true });
        if (!verified.ok || verified.state !== 'VERIFIED') throw new Error(verified.code ?? verified.error ?? copy.providerLifecycleError);
      }
      setNotice(copy.saved);
      await refreshProviderInventory();
    } catch (error: any) {
      try { await refreshProviderInventory(); } catch { /* preserve the original lifecycle error */ }
      setNotice(`${String(error?.message ?? error)} · ${copy.providerDeletePending}`);
    } finally {
      setProviderLifecycleBusy(null);
    }
  };

  const migrateHarnessProvider = async (entry: any) => {
    if (!entry || !['promote-existing-user', 'materialize-user'].includes(entry.action)) {
      setNotice(entry?.blocked_reason ?? copy.providerLayerMigrationHint);
      return;
    }
    if (!window.confirm(copy.providerLayerMigrationConfirm)) return;
    const id = String(entry.provider_id ?? '');
    if (!id) return;
    setProviderLifecycleBusy(`migrate:${id}`);
    setNotice(copy.providerLayerMigrating);
    try {
      const encoded = encodeURIComponent(id);
      const planned = await post(`/providers/${encoded}/migrate-plan`, {});
      if (!planned.ok || !planned.plan) throw new Error(planned.code ?? copy.providerLifecycleError);
      if (!window.confirm(`${copy.providerLayerMigrationConfirm}\n\n${id}`)) return;
      const result = await post(`/providers/${encoded}/migrate`, { plan_id: planned.plan.plan_id, confirm: true });
      if (!result.ok) throw new Error(result.code ?? result.error ?? copy.providerLifecycleError);
      if (result.restart_required === true && result.result?.state === 'RESTART_PENDING') {
        const restartPath = 'http://127.0.0.1:3080/_dsh/dsh-crew/supervisor/restart';
        const restarted = await readJson(await fetch(restartPath, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
        }), restartPath);
        if (!restarted.ok) throw new Error(restarted.code ?? restarted.error ?? copy.providerLifecycleError);
        const verified = await post(`/providers/${encoded}/verify-migration`, { transaction_id: planned.plan.plan_id, confirm: true });
        if (!verified.ok || verified.state !== 'VERIFIED') throw new Error(verified.code ?? verified.error ?? copy.providerLifecycleError);
      }
      setNotice(copy.saved);
      await refreshProviderInventory();
    } catch (error: any) {
      try { await refreshProviderInventory(); } catch { /* preserve the original migration error */ }
      setNotice(String(error?.message ?? error));
    } finally {
      setProviderLifecycleBusy(null);
    }
  };

  const rollbackHarnessMigration = async (record: any, transactionId: string) => {
    if (!record?.id || !transactionId || !window.confirm(copy.providerRollbackConfirm)) return;
    setProviderLifecycleBusy(`rollback-migrate:${record.id}`);
    setNotice(copy.working);
    try {
      const encoded = encodeURIComponent(record.id);
      const result = await post(`/providers/${encoded}/rollback-migration`, { transaction_id: transactionId, confirm: true });
      if (!result.ok) throw new Error(result.code ?? result.error ?? copy.providerLifecycleError);
      if (result.restart_required === true) {
        const restartPath = 'http://127.0.0.1:3080/_dsh/dsh-crew/supervisor/restart';
        const restarted = await readJson(await fetch(restartPath, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
        }), restartPath);
        if (!restarted.ok) throw new Error(restarted.code ?? restarted.error ?? copy.providerLifecycleError);
      }
      setNotice(copy.saved);
      await refreshProviderInventory();
    } catch (error: any) {
      setNotice(String(error?.message ?? error));
      try { await refreshProviderInventory(); } catch { /* preserve the original rollback error */ }
    } finally { setProviderLifecycleBusy(null); }
  };

  const rollbackHarnessProvider = async (record: any, transactionId: string, transactionState: string = 'VERIFIED') => {
    const continuing = ['ROLLBACK_PENDING', 'ROLLBACK_RESTART_PENDING'].includes(transactionState);
    const recoverable = ['PLANNED', 'TOMBSTONE_APPLYING', 'TOMBSTONE_APPLIED', 'REFERENCES_APPLYING', 'REFERENCES_APPLIED', 'DECLARATIONS_APPLYING', 'DECLARATIONS_APPLIED', 'DELETE_RESTART_PENDING', 'ROLLBACK_APPLYING', 'ROLLBACK_RESTORED'].includes(transactionState);
    if (!record || !transactionId || (!continuing && !recoverable && record.desired_state !== 'absent')) {
      setNotice(copy.providerRollbackUnavailable);
      return;
    }
    if (!window.confirm(copy.providerRollbackConfirm)) return;
    setProviderLifecycleBusy(`rollback:${record.id}`);
    setNotice(copy.working);
    try {
      const encoded = encodeURIComponent(record.id);
      const result = continuing
        ? { ok: true, restart_required: true, state: 'ROLLBACK_PENDING' }
        : await post(`/providers/${encoded}/rollback`, { transaction_id: transactionId, confirm: true });
      if (!result.ok) throw new Error(result.code ?? result.error ?? copy.providerLifecycleError);
      if (result.restart_required === true && result.state === 'ROLLBACK_PENDING') {
        const restartPath = 'http://127.0.0.1:3080/_dsh/dsh-crew/supervisor/restart';
        const restarted = await readJson(await fetch(restartPath, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
        }), restartPath);
        if (!restarted.ok) throw new Error(restarted.code ?? restarted.error ?? copy.providerLifecycleError);
        const verified = await post(`/providers/${encoded}/verify-rollback`, { transaction_id: transactionId, confirm: true });
        if (!verified.ok || verified.state !== 'ROLLED_BACK') throw new Error(verified.code ?? verified.error ?? copy.providerLifecycleError);
      } else if (result.state !== 'ROLLED_BACK') {
        throw new Error(result.code ?? copy.providerLifecycleError);
      }
      setNotice(copy.saved);
      await refreshProviderInventory();
    } catch (error: any) {
      try { await refreshProviderInventory(); } catch { /* preserve the original lifecycle error */ }
      setNotice(`${String(error?.message ?? error)} · ${copy.providerDeletePending}`);
    } finally {
      setProviderLifecycleBusy(null);
    }
  };

  const quarantineRecoveryTransaction = async (entry: any) => {
    const actionId = typeof entry?.action_id === 'string' ? entry.action_id : '';
    if (!actionId || entry?.recoverable === true) return;
    if (!window.confirm(copy.recoveryQuarantineConfirm)) return;
    setProviderLifecycleBusy(`quarantine:${actionId}`);
    setNotice(copy.working);
    try {
      const result = await post('/providers/_recovery/quarantine', { action_id: actionId, confirm: true });
      if (!result.ok) throw new Error(result.code ?? result.error ?? copy.providerLifecycleError);
      setNotice(copy.saved);
      await refreshProviderInventory();
    } catch (error: any) {
      try { await refreshProviderInventory(); } catch { /* preserve the original recovery error */ }
      setNotice(String(error?.message ?? error));
    } finally {
      setProviderLifecycleBusy(null);
    }
  };

  /** Card: title + one-line description header, then its fields. */
  const block = (text: { t: string; d: string }, fields: any, gridded = true) => (
    <div style={S.block}>
      <div>
        <div style={S.settingTitle}>{text.t}</div>
        <div style={S.settingDesc}>{text.d}</div>
      </div>
      {gridded ? <div style={S.blockGrid}>{fields}</div> : fields}
    </div>
  );

  const integrationRow = (name: string, installed: boolean, ready: boolean, extra: any, installTarget: string, uninstallTarget: string, tips: any) => (
    <div style={S.card}>
      <span style={{ fontWeight: 600, fontSize: 13, minWidth: 92 }}>{name}</span>
      <span style={S.chip(installed)}>{installed ? `● ${copy.installed}` : `○ ${copy.notInstalled}`}</span>
      <span style={S.chip(ready)}>{ready ? `● ${copy.ready}` : `○ ${copy.notReady}`}</span>
      {extra}
      <span style={{ flex: 1 }} />
      {!installed && <button style={S.btn} title={tips.install} disabled={busy} onClick={() => { void act(installTarget); }}>{copy.install}</button>}
      {installed && <button style={S.btn} title={tips.update} disabled={busy} onClick={() => { void act(installTarget); }}>{copy.update}</button>}
      {installed && <button style={{ ...S.btn, opacity: 0.75 }} title={tips.restore} disabled={busy} onClick={() => { void act(uninstallTarget, name); }}>{copy.restore}</button>}
    </div>
  );

  const adaptive = normalizeAdaptive(config?.worker?.model_policy?.adaptive);
  const setAdaptiveLocal = (candidate: AdaptiveConfig) => {
    const next = normalizeAdaptive(candidate);
    const ordering = next.enabled ? 'health-aware' : 'manual';
    setConfig((current: any) => ({
      ...current,
      worker: {
        ...current.worker,
        model_policy: { ...current.worker?.model_policy, adaptive: next, ordering },
      },
    }));
    return { next, ordering };
  };
  const saveAdaptive = (candidate: AdaptiveConfig) => {
    const { next, ordering } = setAdaptiveLocal(candidate);
    void applyPatch({ worker: { model_policy: { adaptive: next, ordering } } });
  };
  const modelActivity = aggregateModelInvocations(jobs);
  const currentSurfaceResponsibilities = surfaceResponsibilities(surface);
  const hostReadiness = projectHostReadiness({ installStatus: status, runtime: runtimeInfo, surface, readinessSnapshot });

  if (!currentSurfaceResponsibilities.fullControlPlane) {
    return <MinimalCrewPanel locale={locale} surface={surface} runtime={runtimeInfo} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55 }}>
      <div style={{
        border: '1px solid rgba(128,128,128,0.24)', borderRadius: 12, padding: '14px 15px',
        display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
        background: 'linear-gradient(135deg, rgba(74,158,255,0.10), rgba(128,128,128,0.025) 56%)',
      }}>
        <div style={{ minWidth: 240, flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 680, letterSpacing: '-0.01em' }}>{copy.title}</div>
          <div style={{ opacity: 0.7, fontSize: 12.5, marginTop: 2 }}>{copy.intro}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <span style={S.chip(!!status?.codex?.ready)}>Codex {status?.codex?.ready ? 'READY' : 'CHECK'}</span>
            <span style={S.chip(!!status?.claude?.ready)}>Claude {status?.claude?.ready ? 'READY' : 'CHECK'}</span>
            <span style={S.chip(!!status?.zcode?.ready)}>ZCode {status?.zcode?.ready ? 'READY' : 'CHECK'}</span>
            <span style={S.chip(jobs.some((job) => job.status === 'running'))}>{jobs.filter((job) => job.status === 'running').length} running</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
          <a href={CREW_HARNESS_URL} target="_blank" rel="noopener noreferrer" style={{
            ...S.btn, textDecoration: 'none', fontWeight: 650, padding: '7px 12px',
            borderColor: 'rgba(74,158,255,0.55)', background: 'rgba(74,158,255,0.10)',
          }}>{copy.openHarness}</a>
          <span style={{ fontSize: 10.5, opacity: 0.52 }}>{copy.harnessHint}</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5 }}>
        <div style={{ ...S.section, margin: 0, flex: 1 }}>{copy.globalConfig}</div>
        <button type="button" style={{ ...S.btn, padding: '3px 9px' }} onClick={() => toggleAllSections(true)}>{copy.expandAll}</button>
        <button type="button" style={{ ...S.btn, padding: '3px 9px' }} onClick={() => toggleAllSections(false)}>{copy.collapseAll}</button>
      </div>

      <CollapsibleSection sectionId="integrations" title={copy.sectionNames.integrations}
        summary={sectionSummary(status?.claude?.ready ? 'Claude READY' : 'Claude CHECK', `${status?.codex?.ready ? 'Codex READY' : 'Codex CHECK'} · ${status?.zcode?.ready ? 'ZCode READY' : 'ZCode CHECK'}`)}
        expanded={!!expandedSections.integrations} onToggle={() => toggleSection('integrations')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={S.block}>
            <div>
              <div style={S.settingTitle}>{copy.hostReadiness}</div>
              <div style={S.settingDesc}>{copy.hostReadinessHint}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px 10px' }}>
              {hostReadiness.map((row) => (
                <div key={row.id} style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0, padding: '4px 7px', border: '1px solid rgba(128,128,128,0.16)', borderRadius: 7 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 11.5 }}>{(copy as any).readinessLabels[row.id]}</span>
                  {row.detail && <span style={{ ...S.mono, opacity: 0.55 }}>{row.detail}</span>}
                  <span style={readinessChip(row.state)}>{(copy as any).readinessStates[row.state]}</span>
                </div>
              ))}
            </div>
          </div>
          {integrationRow('Claude Code', !!status?.claude?.installed, !!status?.claude?.ready,
            status?.claude?.installed ? <span style={S.chip(!!status?.claude?.hud)}>{copy.hud}</span> : null,
            'claude', 'claude-uninstall', (copy as any).tips.claude)}
          {integrationRow('Codex', !!status?.codex?.installed, !!status?.codex?.ready,
            status?.codex?.ready ? null : <span title={(status?.codex?.missing ?? []).join(', ')} style={{ fontSize: 11, opacity: 0.6 }}>{(status?.codex?.missing ?? []).join(' · ')}</span>,
            'codex', 'codex-uninstall', (copy as any).tips.codex)}
          {integrationRow('ZCode', !!status?.zcode?.installed, !!status?.zcode?.ready,
            status?.zcode?.ready ? null : <span title={(status?.zcode?.missing ?? []).join(', ')} style={{ fontSize: 11, opacity: 0.6 }}>{(status?.zcode?.missing ?? []).join(' · ')}</span>,
            'zcode', 'zcode-uninstall', (copy as any).tips.zcode)}
        </div>
      </CollapsibleSection>

      {config && (<>
        {(() => {
          const clampNum = (v: any) => {
            const n = Number(v);
            if (Number.isNaN(n)) return 3;
            return Math.max(1, Math.min(16, n));
          };
          const mode = config.collaboration_mode ?? 'flash-only';
          const nonCustom = mode !== 'custom';
          const presetStates = { 'flash-only': { flash: 'auto', pro: 'disabled' }, 'pro-only': { flash: 'disabled', pro: 'auto' }, balanced: { flash: 'auto', pro: 'auto' }, 'review-pipeline': { flash: 'auto', pro: 'auto' }, custom: null } as Record<string, { flash: string; pro: string } | null>;
          const states = nonCustom ? presetStates[mode] : null;
          const effState = (tier: string) => states ? states[tier] : (tier === 'flash' ? config.flash_state : config.pro_state) ?? 'auto';
          const roleOptions = ['implementation', 'simple_fix', 'tests', 'search_inspection', 'architecture', 'complex_debugging', 'refactor', 'code_review'] as const;
          const roleKeys = (tier: string) => {
            const arr = tier === 'flash' ? (config.flash_roles ?? []) : (config.pro_roles ?? []);
            const set = new Set(arr);
            return { arr: roleOptions.filter((r) => set.has(r)), set, save: (list: string[]) => field(tier === 'flash' ? 'flash_roles' : 'pro_roles', list) };
          };
          const catalogProviders: any[] = modelCatalog?.providers ?? [];
          const refKey = (ref: any) => `${ref?.provider ?? ''}\0${ref?.model ?? ''}`;
          const priorityFor = (tier: string): any[] => Array.isArray(config[`${tier}_model_priority`]) ? config[`${tier}_model_priority`] : [];
          const savePriority = (tier: string, list: any[]) => {
            const key = `${tier}_model_priority`;
            setConfig((current: any) => ({ ...current, [key]: list, [`${tier}_model_priority_configured`]: true }));
              void applyPatch({ [key]: list });
          };
          const modelMeta = (ref: any) => {
            const provider = catalogProviders.find((item) => item.id === ref.provider);
            const model = provider?.models?.find((item: any) => item.id === ref.model);
            return { provider, model };
          };
          const modelHealth = (ref: any) => providerHealth.find((entry: any) => entry.provider === ref.provider && entry.model === ref.model && entry.fresh === true) ?? null;
          const healthLabel = (health: any) => health?.state ? String(health.state).toUpperCase().replace(/-/g, ' ') : copy.healthUnprobed;
          const healthAge = (health: any) => Number.isFinite(health?.observed_at)
            ? copy.checkedAgo(Math.max(0, Math.round((Date.now() - health.observed_at) / 1000)))
            : '';
          const filteredProviders = catalogProviders.map((provider) => ({
            ...provider,
            models: (provider.models ?? []).filter((model: any) => {
              const query = modelQuery.trim().toLowerCase();
              return !query || [provider.id, provider.name, model.id, model.name].some((value) => String(value ?? '').toLowerCase().includes(query));
            }),
          })).filter((provider) => provider.models.length > 0);
          const modelPriorityPanel = (tier: 'flash' | 'pro') => {
            const priority = priorityFor(tier);
            const selected = new Set(priority.map(refKey));
            const preferredId = tier === 'flash' ? 'deepseek-v4-flash' : 'deepseek-v4-pro';
            const preferredProviders = catalogProviders.filter((provider) => (provider.models ?? []).some((model: any) => model.id === preferredId));
            const ambiguousPreferred = priority.length === 0 && config[`${tier}_model_priority_configured`] !== true
              && preferredProviders.length > 1
              && !preferredProviders.some((provider) => provider.id === modelCatalog?.harness_default?.provider);
            return (
              <div style={{ gridColumn: '1 / -1', borderTop: '1px solid rgba(128,128,128,0.18)', paddingTop: 9 }}>
                <div style={{ ...S.fieldLabel, marginBottom: 5 }}>{copy.modelPriority}</div>
                {priority.length === 0 && <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 6 }}>{copy.noPriority}</div>}
                {ambiguousPreferred && <div style={{ fontSize: 11.5, color: '#c98735', marginBottom: 6 }}>{copy.needsModelSelection}</div>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {priority.map((ref, index) => {
                    const meta = modelMeta(ref);
                    const health = modelHealth(ref);
                    const warning = !meta.provider ? copy.providerUnavailable : !meta.model ? copy.notAdvertised : '';
                    return (
                      <div key={refKey(ref)} style={{ display: 'flex', gap: 7, alignItems: 'center', padding: '6px 8px', border: '1px solid rgba(128,128,128,0.2)', borderRadius: 6 }}>
                        <span style={{ opacity: 0.55, width: 18 }}>{index + 1}.</span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 12.5 }}>{meta.model?.name ?? ref.model}</span>
                          <span style={{ display: 'block', fontSize: 10.5, opacity: 0.58, fontFamily: 'monospace' }}>{ref.provider} / {ref.model}</span>
                          <span style={{ display: 'block', fontSize: 10.5, color: health?.state === 'callable' ? '#3fb950' : health ? '#c98735' : 'inherit', opacity: health ? 0.9 : 0.5 }}>
                            {healthLabel(health)}{healthAge(health) ? ` · ${healthAge(health)}` : ''}
                          </span>
                          {warning && <span style={{ display: 'block', fontSize: 10.5, color: '#c98735' }}>{warning}</span>}
                        </span>
                        <button type="button" style={{ ...S.btn, padding: '2px 7px' }} title={copy.moveUp} disabled={index === 0}
                          onClick={() => { const next = [...priority]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; savePriority(tier, next); }}>↑</button>
                        <button type="button" style={{ ...S.btn, padding: '2px 7px' }} title={copy.moveDown} disabled={index === priority.length - 1}
                          onClick={() => { const next = [...priority]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; savePriority(tier, next); }}>↓</button>
                        <button type="button" style={{ ...S.btn, padding: '2px 7px' }} title={copy.removePriority}
                          onClick={() => savePriority(tier, priority.filter((_, itemIndex) => itemIndex !== index))}>×</button>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 7 }}>
                  <button type="button" style={S.btn} disabled={!modelCatalog || modelCatalogBusy}
                    onClick={() => { setModelPickerTier(modelPickerTier === tier ? null : tier); setModelQuery(''); }}>{copy.addPriorityModel}</button>
                  <span style={{ fontSize: 11, opacity: 0.58 }}>{copy.harnessDefault}: {modelCatalog?.harness_default ? `${modelCatalog.harness_default.provider} / ${modelCatalog.harness_default.model}` : '—'}</span>
                </div>
                {modelPickerTier === tier && (
                  <div style={{ marginTop: 8, border: '1px solid rgba(128,128,128,0.22)', borderRadius: 7, padding: 8, maxHeight: 260, overflow: 'auto' }}>
                    <input autoFocus value={modelQuery} placeholder={copy.modelSearch} onChange={(event) => setModelQuery(event.target.value)}
                      style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, marginBottom: 7 }} />
                    {filteredProviders.map((provider) => (
                      <div key={provider.id} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 3 }}>{provider.name} <span style={{ opacity: 0.5, fontFamily: 'monospace' }}>{provider.id}</span></div>
                        {(provider.models ?? []).map((model: any) => {
                          const ref = { provider: provider.id, model: model.id };
                          const duplicate = selected.has(refKey(ref));
                          return <button key={model.id} type="button" disabled={duplicate} style={{ ...S.btn, display: 'block', width: '100%', textAlign: 'left', marginBottom: 3, opacity: duplicate ? 0.45 : 1 }}
                            onClick={() => { savePriority(tier, [...priority, ref]); setModelPickerTier(null); }}>{model.name} <span style={{ opacity: 0.55, fontFamily: 'monospace' }}>{model.id}</span></button>;
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          };
          const tierCard = (tier: string, card: { t: string; d: string }) => (
            <div style={S.block}>
              <div>
                <div style={S.settingTitle}>{card.t}</div>
                <div style={S.settingDesc}>{card.d}</div>
              </div>
              <div style={S.blockGrid}>
                <label style={S.field}><span style={S.fieldLabel}>{copy.tierState}</span>
                  {nonCustom ? (
                    <div style={{ fontSize: 12.5, padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(128,128,128,0.35)', opacity: 0.8 }}>
                      {effState(tier) === 'auto' ? copy.tierStateDesc.auto : copy.tierStateDesc.disabled}（{copy.stateManagedByPreset}）
                    </div>
                  ) : (
                    <CustomSelect value={tier === 'flash' ? (config.flash_state ?? 'auto') : (config.pro_state ?? 'auto')}
                      onChange={(v) => field(tier === 'flash' ? 'flash_state' : 'pro_state', v)}
                      options={(['disabled', 'manual', 'auto'] as const).map((s) => ({ value: s, label: copy.tierStateDesc[s] }))} />
                  )}
                </label>
                <label style={S.field}><span style={S.fieldLabel}>{tier === 'flash' ? copy.presetFlash : copy.presetPro}</span>
                  <CustomSelect value={tier === 'flash' ? (config.preset_flash ?? 'default') : (config.preset_pro ?? 'default')}
                    onChange={(v) => field(tier === 'flash' ? 'preset_flash' : 'preset_pro', v)} options={presetOptions} /></label>
              </div>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
                {copy.statePresetHint}{' '}{copy.responsibilitiesHint}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '3px 14px' }}>
                {roleOptions.map((r) => {
                  const k = roleKeys(tier);
                  const on = k.set.has(r);
                  return (
                    <label key={r} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <input type="checkbox" checked={on} onChange={() => {
                        k.save(on ? k.arr.filter((x) => x !== r) : [...k.arr, r]);
                      }} />
                      <span>{copy.roleLabels[r]}</span>
                    </label>
                  );
                })}
              </div>
              {modelPriorityPanel(tier as 'flash' | 'pro')}
            </div>
          );
          return (<>
            <CollapsibleSection sectionId="workflow" title={copy.sectionNames.workflow}
              summary={sectionSummary(config.worker_state ?? 'auto', config.review_state ?? 'auto', mode, config.isolation ?? 'worktree', `×${config.max_parallel ?? 3}`)}
              expanded={!!expandedSections.workflow} onToggle={() => toggleSection('workflow')}>
              {block({ t: copy.roleWorker, d: copy.roleStateHint }, (<>
                <label style={S.field}><span style={S.fieldLabel}>{copy.workerStateLabel}</span>
                  <CustomSelect value={config.worker_state ?? 'auto'} onChange={(v) => field('worker_state', v)}
                    options={(['auto', 'manual', 'disabled'] as const).map((s) => ({ value: s, label: copy.tierStateDesc[s] }))} /></label>
                <label style={S.field}><span style={S.fieldLabel}>{copy.reviewStateLabel}</span>
                  <CustomSelect value={config.review_state ?? 'auto'} onChange={(v) => field('review_state', v)}
                    options={(['auto', 'manual', 'disabled'] as const).map((s) => ({ value: s, label: copy.tierStateDesc[s] }))} /></label>
              </>))}
              {block({ t: copy.autoReview, d: copy.autoReviewHint }, (
                <>
                  <label style={{ ...S.field, flexDirection: 'row' as const, alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={config.auto_review ?? !!config.pro_reviews_flash} onChange={(e) => field('auto_review', e.target.checked)} />
                    <span style={{ fontSize: 12.5 }}>{copy.autoReview}</span>
                  </label>
                  <label style={S.field}><span style={S.fieldLabel}>{copy.reviewGate}</span>
                    <CustomSelect value={config.review?.gate ?? 'required'} onChange={(v) => reviewField({ gate: v })}
                      options={(['required', 'optional', 'off'] as const).map((value) => ({ value, label: copy.reviewGateDesc[value] }))} /></label>
                </>
              ))}
              {block({ t: copy.modelOrdering, d: copy.orderingHint }, (<>
                {(['worker', 'review'] as const).map((role) => (
                  <div key={role} style={{ display: 'contents' }}>
                    <label style={S.field}><span style={S.fieldLabel}>{role === 'worker' ? copy.roleWorker : copy.roleReviewer} · {copy.modelOrdering}</span>
                      <CustomSelect value={config?.[role]?.model_policy?.ordering ?? 'manual'}
                        onChange={(v) => rolePolicyField(role, { ordering: v })}
                        options={(['manual', 'health-aware'] as const).map((value) => ({ value, label: copy.orderingDesc[value] }))} /></label>
                    <label style={S.field}><span style={S.fieldLabel}>{role === 'worker' ? copy.roleWorker : copy.roleReviewer} · {copy.healthGate}</span>
                      <CustomSelect value={config?.[role]?.model_policy?.health_gate ?? 'hard-failures'}
                        onChange={(v) => rolePolicyField(role, { health_gate: v })}
                        options={(['hard-failures', 'off'] as const).map((value) => ({ value, label: copy.healthGateDesc[value] }))} /></label>
                  </div>
                ))}
              </>))}
              {block({ t: copy.isolation, d: copy.isolationHint }, (<>
                <label style={S.field}><span style={S.fieldLabel}>{copy.isolation}</span>
                  <CustomSelect value={config.isolation ?? 'worktree'} onChange={(v) => field('isolation', v)}
                    options={(['worktree', 'shared'] as const).map((s) => ({ value: s, label: copy.isolationDesc[s] }))} /></label>
                <label style={S.field}><span style={S.fieldLabel}>{copy.maxParallel}</span>
                  <input type="number" min={1} max={16} value={config.max_parallel ?? 3}
                    onChange={(e) => fieldLocal('max_parallel', clampNum(e.target.value))}
                    onBlur={() => field('max_parallel', clampNum(config.max_parallel))} style={S.input} /></label>
              </>))}
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 3 }}>{copy.legacyCompatibility}</div>
              {block({ t: copy.orchestration, d: copy.enableSubagentsHint }, (
                <label style={{ ...S.field, flexDirection: 'row' as const, alignItems: 'center', gap: 6 }} title={copy.enableSubagentsHint}>
                  <input type="checkbox" checked={!!config.subagents_enabled} onChange={(e) => field('subagents_enabled', e.target.checked)} />
                  <span style={{ fontSize: 12.5 }}>{config.subagents_enabled === false ? copy.subagentsKept : copy.enableSubagents}</span>
                </label>
              ), false)}
              {block({ t: copy.mainAgentMode, d: copy.mainAgentModeHint }, (<>
                <label style={S.field}><span style={S.fieldLabel}>{copy.mainAgentMode}</span>
                  <CustomSelect value={config.main_agent_mode ?? 'direct-allowed'} onChange={(v) => field('main_agent_mode', v)}
                    options={(['direct-allowed', 'coordinator-first', 'dispatcher-only'] as const).map((m) => ({ value: m, label: copy.mainAgentModeDesc[m] }))} /></label>
                <label style={S.field}><span style={S.fieldLabel}>{copy.collaborationMode}</span>
                  <CustomSelect value={mode} onChange={(v) => field('collaboration_mode', v)}
                    options={(['flash-only', 'pro-only', 'balanced', 'review-pipeline', 'custom'] as const).map((m) => ({ value: m, label: copy.collaborationModeDesc[m] }))} /></label>
                <label style={S.field} title={copy.workerProviderHint}><span style={S.fieldLabel}>{copy.workerProvider}</span>
                  <CustomSelect value={config.worker_provider_mode ?? 'deepseek-official'} onChange={(v) => field('worker_provider_mode', v)}
                    options={(['follow-dsh', 'deepseek-official'] as const).map((m) => ({ value: m, label: copy.workerProviderDesc[m] }))} /></label>
              </>))}
              {block({ t: copy.workerModels, d: modelCatalog ? copy.modelPoolSummary(modelCatalog.provider_count ?? 0, modelCatalog.model_count ?? 0) : copy.catalogFailed }, (<>
                <button type="button" style={S.btn} disabled={modelCatalogBusy} onClick={() => { void refreshHarnessModels(); }}>
                  {modelCatalogBusy ? copy.refreshingModels : copy.refreshHarnessModels}
                </button>
                {modelCatalog?.partial && <span style={{ fontSize: 11.5, color: '#c98735' }}>{copy.partialCatalog}</span>}
                {modelCatalogError && <span style={{ fontSize: 11.5, color: '#c55' }}>{modelCatalogError}</span>}
              </>), false)}
              {block({ t: copy.routing, d: '' }, (<>
                <label style={{ ...S.field, flexDirection: 'row' as const, alignItems: 'center', gap: 6, paddingBottom: 5 }} title={copy.escalateHint}>
                  <input type="checkbox" checked={!!config.escalate_on_failure} onChange={(e) => field('escalate_on_failure', e.target.checked)} />
                  <span style={{ fontSize: 12 }}>{copy.escalate}</span></label>
                <label style={{ ...S.field, flexDirection: 'row' as const, alignItems: 'center', gap: 6, paddingBottom: 5 }} title={mode === 'review-pipeline' ? copy.proReviewsLocked : copy.proReviewsFlashHint}>
                  <input type="checkbox" disabled={mode === 'review-pipeline'} checked={mode === 'review-pipeline' ? true : !!config.pro_reviews_flash}
                    onChange={(e) => field('pro_reviews_flash', e.target.checked)} />
                  <span style={{ fontSize: 12 }}>{copy.proReviewsFlash}{mode === 'review-pipeline' ? `（${copy.proReviewsLocked}）` : ''}</span></label>
              </>))}
            </CollapsibleSection>
            <CollapsibleSection sectionId="flash" title={copy.sectionNames.flash}
              summary={sectionSummary(effState('flash'), copy.modelCount(priorityFor('flash').length), priorityFor('flash')[0]?.model ?? copy.harnessDefault)}
              expanded={!!expandedSections.flash} onToggle={() => toggleSection('flash')}>
              {tierCard('flash', { t: copy.tierCardFlash, d: 'implementation · direct validation · Delivery Report' })}
            </CollapsibleSection>
            <CollapsibleSection sectionId="pro" title={copy.sectionNames.pro}
              summary={sectionSummary(effState('pro'), copy.modelCount(priorityFor('pro').length), priorityFor('pro')[0]?.model ?? copy.harnessDefault)}
              expanded={!!expandedSections.pro} onToggle={() => toggleSection('pro')}>
              {tierCard('pro', { t: copy.tierCardPro, d: 'manual advanced work · review pipeline' })}
            </CollapsibleSection>
          </>);
        })()}

        <CollapsibleSection sectionId="dispatch" title={copy.sectionNames.dispatch}
          summary={sectionSummary(config.default_tier, config.default_effort, config.tier_policy, config.escalate_on_failure && copy.escalate)}
          expanded={!!expandedSections.dispatch} onToggle={() => toggleSection('dispatch')}>
          {block(copy.cardDispatch, (<>
          <label style={S.field}><span style={S.fieldLabel}>{copy.tier}</span>
            <CustomSelect value={config.default_tier} onChange={(v) => field('default_tier', v)}
              options={[{ value: 'flash' }, { value: 'pro' }]} /></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.effort}</span>
            <CustomSelect value={config.default_effort} onChange={(v) => field('default_effort', v)}
              options={[{ value: 'off' }, { value: 'high' }, { value: 'max' }]} /></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.tierPolicy}</span>
            <CustomSelect value={config.tier_policy} onChange={(v) => field('tier_policy', v)}
              options={(['auto', 'flash-only', 'pro-only'] as const).map((p) => ({ value: p, label: copy.tierPolicyDesc[p] }))} /></label>
          <label style={{ ...S.field, flexDirection: 'row' as const, alignItems: 'center', gap: 6, paddingBottom: 5 }} title={copy.escalateHint}>
            <input type="checkbox" checked={!!config.escalate_on_failure} onChange={(e) => field('escalate_on_failure', e.target.checked)} />
            <span style={{ fontSize: 12 }}>{copy.escalate}</span></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.presetFlash}</span>
            <CustomSelect value={config.preset_flash ?? 'default'} onChange={(v) => field('preset_flash', v)} options={presetOptions} /></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.presetPro}</span>
            <CustomSelect value={config.preset_pro ?? 'default'} onChange={(v) => field('preset_pro', v)} options={presetOptions} /></label>
          </>))}
        </CollapsibleSection>

        <CollapsibleSection sectionId="adaptive" title={copy.sectionNames.adaptive}
          summary={sectionSummary(adaptive.enabled ? copy.adaptiveEnabled : 'off', `${adaptive.min_samples}/${adaptive.window_size}`, copy.adaptiveBoundary)}
          expanded={!!expandedSections.adaptive} onToggle={() => toggleSection('adaptive')}>
          {block({ t: copy.adaptiveTitle, d: copy.adaptiveHint }, (<>
            <label style={{ ...S.field, flexDirection: 'row' as const, alignItems: 'center', gap: 7, gridColumn: '1 / -1' }}>
              <input type="checkbox" checked={adaptive.enabled}
                onChange={(event) => saveAdaptive({ ...adaptive, enabled: event.target.checked })} />
              <span style={{ fontSize: 12.5 }}>{copy.adaptiveEnabled}</span>
              <span style={{ fontSize: 11, opacity: 0.55 }}>· {copy.adaptiveBoundary}</span>
            </label>
            <label style={S.field}><span style={S.fieldLabel}>{copy.adaptiveWindow}</span>
              <input type="number" min={1} max={32} value={adaptive.window_size} style={S.input}
                onChange={(event) => setAdaptiveLocal({ ...adaptive, window_size: clampInt(event.target.value, adaptive.window_size, 1, 32) })}
                onBlur={() => saveAdaptive(adaptive)} /></label>
            <label style={S.field}><span style={S.fieldLabel}>{copy.adaptiveSamples}</span>
              <input type="number" min={1} max={adaptive.window_size} value={adaptive.min_samples} style={S.input}
                onChange={(event) => setAdaptiveLocal({ ...adaptive, min_samples: clampInt(event.target.value, adaptive.min_samples, 1, adaptive.window_size) })}
                onBlur={() => saveAdaptive(adaptive)} /></label>
          </>))}
        </CollapsibleSection>

        <CollapsibleSection sectionId="runtime" title={copy.sectionNames.runtime}
          summary={sectionSummary(config.mode, `${config.default_timeout_seconds}s`, config.hub_url)}
          expanded={!!expandedSections.runtime} onToggle={() => toggleSection('runtime')}>
          {block(copy.cardRuntime, (<>
          <label style={S.field}><span style={S.fieldLabel}>{copy.mode}</span>
            <CustomSelect value={config.mode} onChange={(v) => field('mode', v)}
              options={(['auto', 'hub'] as const).map((m) => ({ value: m, label: copy.modeDesc[m] }))} /></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.timeout}</span>
            <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const }} type="number" min={60} max={7200} value={config.default_timeout_seconds}
              onChange={(e) => fieldLocal('default_timeout_seconds', Number(e.target.value))}
              onBlur={() => { void applyPatch({ default_timeout_seconds: config.default_timeout_seconds }); }} /></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.hubUrl}</span>
            <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const }} value={config.hub_url}
              onChange={(e) => fieldLocal('hub_url', e.target.value)}
              onBlur={() => { void applyPatch({ hub_url: config.hub_url }); }}
              onKeyDown={(e: any) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>
          </>))}
          <ActivationSummary activation={config.config_activation} locale={locale} />
        </CollapsibleSection>

        <CollapsibleSection sectionId="multimodal" title={copy.sectionNames.multimodal}
          summary={sectionSummary(config.vision_enabled ? `${copy.capVision}: ${config.vision_provider}` : `${copy.capVision}: off`, config.imagegen_enabled ? `${copy.capImagegen}: ${config.imagegen_provider}` : `${copy.capImagegen}: off`)}
          expanded={!!expandedSections.multimodal} onToggle={() => toggleSection('multimodal')}>
          {block(copy.cardMM, (<>
          <label style={{ ...S.field, flexDirection: 'row' as const, alignItems: 'center', gap: 6, gridColumn: '1 / -1' }} title={copy.capRestartHint}>
            <input type="checkbox" checked={!!config.vision_enabled} onChange={(e) => field('vision_enabled', e.target.checked)} />
            <span style={{ fontSize: 12.5 }}>{copy.enableCrewVision}</span>
            {config.vision_enabled === false && <span style={{ fontSize: 11, opacity: 0.55 }}>{copy.capDisabledNote}</span>}
          </label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.visionProvider}</span>
            <CustomSelect value={config.vision_provider}
              onChange={(p) => {
                const custom = customProviders.find((c) => c.id === p);
                const m = custom ? (custom.models?.[0] ?? 'default') : (VISION_MODELS[p] ?? ['default'])[0];
                setModelAdd(null);
                setConfig((c: any) => ({ ...c, vision_provider: p, vision_model: m }));
                    void applyPatch({ vision_provider: p, vision_model: m });
                if ((p === 'grok' || p === 'agy') && !dynModels[p]) {
                  void get(`/vision-models?provider=${p}`).then((r) => {
                    if (r.ok) setDynModels((d) => ({ ...d, [p]: r.models }));
                  }).catch(() => {});
                }
              }}
              options={visionProviderOptions} /></label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.visionModel}</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {modelAdd === null ? (
                <CustomSelect value={config.vision_model} onChange={(v) => field('vision_model', v)}
                  options={visionModelOptions} />
              ) : (
                <input autoFocus style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                  value={modelAdd} placeholder={copy.modelPlaceholder}
                  onChange={(e) => setModelAdd(e.target.value)}
                  onBlur={commitModelAdd}
                  onKeyDown={(e: any) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setModelAdd(null);
                  }} />
              )}
              {modelAdd === null && (config.vision_provider === 'grok' || config.vision_provider === 'agy') && (
                <button type="button" title={copy.refreshModels} disabled={busy}
                  style={{ ...S.btn, padding: '3px 8px', flexShrink: 0 }}
                  onClick={() => {
                    const p = config.vision_provider;
                    setBusy(true);
                    void get(`/vision-models?provider=${p}&refresh=1`)
                      .then((r) => { if (r.ok) setDynModels((d) => ({ ...d, [p]: r.models })); })
                      .catch(() => {})
                      .finally(() => setBusy(false));
                  }}>↻</button>
              )}
              {modelAdd === null && config.vision_provider !== 'off' && (
                <button type="button" title={copy.addModelTip} style={{ ...S.btn, padding: '3px 8px', flexShrink: 0 }}
                  onClick={() => setModelAdd('')}>＋</button>
              )}
              {modelAdd === null && (extraModels[config.vision_provider] ?? []).includes(config.vision_model) && (
                <button type="button" title={copy.removeModelTip} style={{ ...S.btn, padding: '3px 8px', flexShrink: 0 }}
                  onClick={removeCurrentModel}>−</button>
              )}
            </div></label>
          <label style={{ ...S.field, flexDirection: 'row' as const, alignItems: 'center', gap: 6, gridColumn: '1 / -1' }} title={copy.capRestartHint}>
            <input type="checkbox" checked={!!config.imagegen_enabled} onChange={(e) => field('imagegen_enabled', e.target.checked)} />
            <span style={{ fontSize: 12.5 }}>{copy.enableImagegen}</span>
            {config.imagegen_enabled === false && <span style={{ fontSize: 11, opacity: 0.55 }}>{copy.capDisabledNote}</span>}
          </label>
          <label style={S.field}><span style={S.fieldLabel}>{copy.imagegenProvider}</span>
            <CustomSelect value={config.imagegen_provider} onChange={(v) => field('imagegen_provider', v)}
              options={imagegenProviderOptions} /></label>
          </>))}
        </CollapsibleSection>

        <CollapsibleSection sectionId="harnessProviders" title={copy.sectionNames.harnessProviders}
          summary={sectionSummary(copy.providerCount(providerInventory?.records?.length ?? 0), providerInventoryError ? copy.providerLifecycleError : '')}
          expanded={!!expandedSections.harnessProviders} onToggle={() => toggleSection('harnessProviders')}>
          {providerInventoryError && <div style={{ fontSize: 12, color: '#c55' }}>{providerInventoryError}</div>}
          {!providerInventoryError && (providerInventory?.migration?.providers?.length ?? 0) > 0 && (
            <div style={{ border: '1px solid rgba(201,135,53,0.45)', borderRadius: 7, padding: '8px 10px', marginBottom: 8 }}>
              <div style={{ fontWeight: 650, fontSize: 12.5 }}>{copy.providerLayerMigration}</div>
              <div style={{ fontSize: 11.5, opacity: 0.7, marginTop: 3 }}>{copy.providerLayerMigrationHint}</div>
              <div style={{ fontSize: 11, marginTop: 6, fontFamily: 'monospace' }}>
                {(providerInventory.migration.providers ?? []).map((entry: any) => (
                  <div key={entry.provider_id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                    {entry.provider_id} · {entry.action}{entry.harness_default ? ' · Harness Default' : ''}
                    <span style={{ flex: 1 }} />
                    {['promote-existing-user', 'materialize-user'].includes(entry.action) && <button type="button" style={{ ...S.btn, padding: '2px 7px' }} disabled={providerLifecycleBusy !== null}
                      onClick={() => { void migrateHarnessProvider(entry); }}>
                      {providerLifecycleBusy === `migrate:${entry.provider_id}` ? copy.providerLayerMigrating : copy.providerLayerMigrate}
                    </button>}
                  </div>
                ))}
              </div>
              <a href="http://127.0.0.1:3210/" target="_blank" rel="noopener noreferrer" style={{ ...S.btn, display: 'inline-block', textDecoration: 'none', marginTop: 7, padding: '3px 8px' }}>
                {copy.providerLayerMigrationPlan} → 3210
              </a>
            </div>
          )}
          {!providerInventoryError && (providerInventory?.records?.length ?? 0) === 0 && (
            <div style={{ fontSize: 12, opacity: 0.55 }}>{copy.providerNoInventory}</div>
          )}
          {(providerInventory?.records ?? []).map((record: any) => {
            const immutable = record.delete_capability === 'immutable-builtin';
            const unresolved = record.delete_capability === 'source-unresolved';
            const blocked = immutable || unresolved || record.desired_state === 'absent' || Number(record.references?.active_jobs ?? 0) > 0;
            const lifecycle = record.desired_state === 'absent' ? 'absent' : record.lifecycle?.enabled === false ? 'disabled' : record.lifecycle?.catalogued ? 'catalogued' : 'configured';
            const lifecycleTransactions = providerInventory?.lifecycle_transactions ?? [];
            const recoveryTransactions = (providerInventory?.recovery_transactions ?? []).map((entry: any) => ({ ...entry, state: entry.phase }));
            const rollbackTransaction = [...lifecycleTransactions, ...recoveryTransactions]
              .filter((entry: any) => entry.provider_id === record.id && ['VERIFIED', 'RESTART_PENDING', 'ROLLBACK_PENDING', 'PLANNED', 'TOMBSTONE_APPLYING', 'TOMBSTONE_APPLIED', 'REFERENCES_APPLYING', 'REFERENCES_APPLIED', 'DECLARATIONS_APPLYING', 'DECLARATIONS_APPLIED', 'DELETE_RESTART_PENDING', 'ROLLBACK_RESTART_PENDING', 'ROLLBACK_RESTORED', 'ROLLBACK_APPLYING', 'PREPARED', 'USER_MATERIALIZED', 'BASE_REMOVED'].includes(entry.state))
              .sort((a: any, b: any) => String(a.updated_at ?? '').localeCompare(String(b.updated_at ?? ''))).at(-1);
            return (
              <div key={record.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, flexWrap: 'wrap' as const }}>
                <span style={{ fontWeight: 600 }}>{record.display_name || record.id}</span>
                <span style={{ ...S.chip(record.lifecycle?.enabled === true), ...S.mono }}>{record.id}</span>
                <span style={{ opacity: 0.65 }}>{copy.providerState(lifecycle)}</span>
                <span style={{ opacity: 0.65 }}>{copy.providerModels(record.models?.length ?? 0)}</span>
                {immutable && <span style={{ opacity: 0.65 }}>{copy.providerOfficialBuiltin}</span>}
                {unresolved && <span style={{ color: '#c98735' }}>{copy.providerSourceUnresolved}</span>}
                {Number(record.references?.active_jobs ?? 0) > 0 && <span style={{ color: '#c98735' }}>{copy.providerJobs(record.references.active_jobs)}</span>}
                <span style={{ flex: 1 }} />
                {record.delete_capability === 'supported' && record.desired_state !== 'absent' && (
                  <button type="button" style={{ ...S.btn, padding: '2px 8px' }} disabled={blocked || providerLifecycleBusy !== null}
                    onClick={() => { void deleteHarnessProvider(record); }}>
                    {providerLifecycleBusy === record.id ? copy.working : copy.providerDeletePlan}
                  </button>
                )}
                {(record.desired_state === 'absent' || ['PLANNED', 'TOMBSTONE_APPLYING', 'TOMBSTONE_APPLIED', 'REFERENCES_APPLYING', 'REFERENCES_APPLIED', 'DECLARATIONS_APPLYING', 'DECLARATIONS_APPLIED', 'DELETE_RESTART_PENDING', 'ROLLBACK_PENDING', 'ROLLBACK_RESTART_PENDING', 'ROLLBACK_RESTORED', 'ROLLBACK_APPLYING'].includes(rollbackTransaction?.state)) && rollbackTransaction && rollbackTransaction.source !== 'provider-layer-migration' && (
                  <button type="button" style={{ ...S.btn, padding: '2px 8px' }} disabled={providerLifecycleBusy !== null}
                    onClick={() => { void rollbackHarnessProvider(record, rollbackTransaction.transaction_id, rollbackTransaction.state); }}>
                    {providerLifecycleBusy === `rollback:${record.id}` ? copy.working : rollbackTransaction.state === 'ROLLBACK_PENDING' ? copy.providerRollbackContinue : copy.providerRollback}
                  </button>
                )}
                {rollbackTransaction?.source === 'provider-layer-migration' && rollbackTransaction.transaction_id && (
                  <button type="button" style={{ ...S.btn, padding: '2px 8px' }} disabled={providerLifecycleBusy !== null}
                    onClick={() => { void rollbackHarnessMigration(record, rollbackTransaction.transaction_id); }}>
                    {providerLifecycleBusy === `rollback-migrate:${record.id}` ? copy.working : copy.providerLayerRollback}
                  </button>
                )}
              </div>
            );
          })}
          {(providerInventory?.recovery_transactions ?? []).filter((entry: any) => entry?.unresolved === true || !entry?.provider_id).map((entry: any) => (
            <div key={`recovery:${entry.storage_id ?? entry.transaction_id ?? 'unknown'}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' as const, color: '#c98735', marginTop: 6 }}>
              <span style={{ fontWeight: 600 }}>{copy.recoveryUnresolved}</span>
              <span style={S.mono}>{entry.storage_id ?? entry.transaction_id ?? 'unknown'}</span>
              <span style={{ opacity: 0.7 }}>{entry.phase}</span>
              <span style={{ flex: 1 }} />
              {entry.action_id && <button type="button" style={{ ...S.btn, padding: '2px 8px' }} disabled={providerLifecycleBusy !== null}
                onClick={() => { void quarantineRecoveryTransaction(entry); }}>
                {providerLifecycleBusy === `quarantine:${entry.action_id}` ? copy.working : copy.recoveryQuarantine}
              </button>}
            </div>
          ))}
          {(credentialRefs.length > 0 || credentialUnverified.length > 0) && (
            <div style={{ marginTop: 10, borderTop: '1px solid rgba(128,128,128,0.16)', paddingTop: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>{copy.credentialReferences}</div>
              <div style={{ fontSize: 11, opacity: 0.6, margin: '3px 0 7px' }}>{copy.credentialReferenceHint}</div>
              {credentialUnverified.map((entry: any) => (
                <div key={`unverified:${entry.reference_id}`} style={{ color: '#c55', fontSize: 11.5 }}>
                  <span style={S.mono}>{entry.reference_id}</span> · {copy.credentialPurgeUnverified}
                </div>
              ))}
              {credentialRefs.map((ref: any) => (
                <div key={ref.reference_id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, flexWrap: 'wrap' as const }}>
                  <span style={S.mono}>{ref.reference_id}</span>
                  <span style={{ opacity: 0.65 }}>{ref.ownership}</span>
                  <span style={{ color: ref.orphan ? '#c98735' : undefined }}>{ref.orphan ? copy.credentialOrphan : copy.credentialInUse(ref.consumer_count ?? 0)}</span>
                  <span style={{ flex: 1 }} />
                  {ref.ownership === 'crew-owned' && ref.orphan === true && ref.purge_capability === 'eligible' && (
                    <button type="button" style={{ ...S.btn, padding: '2px 8px' }}
                      disabled={credentialLifecycleBusy !== null}
                      onClick={() => { void purgeCredentialRef(ref); }}>
                      {credentialLifecycleBusy === ref.reference_id ? copy.credentialPurging : copy.credentialPurgePlan}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection sectionId="providers" title={copy.sectionNames.providers}
          summary={sectionSummary(copy.providerCount(customProviders.length), testResult?.ok === false && copy.testFail)}
          expanded={!!expandedSections.providers} onToggle={() => toggleSection('providers')}>
          {block(copy.cardCustomProv, (<>
          {customProviders.length === 0 && provForm === null && (
            <div style={{ fontSize: 12, opacity: 0.5 }}>{copy.noCustomProviders}</div>
          )}
          {customProviders.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
              <span style={{ fontWeight: 500 }}>{p.name || p.id}</span>
              <span style={{ ...S.chip(false), opacity: 0.7 }}>{provType(p) === 'api' ? 'API' : 'CLI'}</span>
              {canSee(p) && <span style={S.chip(true)}>{copy.capVision}</span>}
              {canDraw(p) && <span style={S.chip(true)}>{copy.capImagegen}</span>}
              {provType(p) === 'api' && !!p.api_key && <span style={{ fontSize: 11.5, opacity: 0.5 }}>key {copy.keySet}</span>}
              <span style={{ flex: 1 }} />
              <button style={{ ...S.btn, padding: '2px 8px' }} title={copy.testTip}
                disabled={!!testResult?.busy}
                onClick={() => runProviderTest(`row:${p.id}`, p)}>
                {testResult?.key === `row:${p.id}` && testResult.busy ? copy.testing : copy.testProvider}</button>
              <button style={{ ...S.btn, padding: '2px 8px' }}
                onClick={() => setProvForm({
                  originalId: p.id, name: p.name ?? p.id, type: provType(p),
                  models: (p.models ?? []).join(', '),
                  base_url: p.base_url ?? '', api_key: p.api_key ?? '', imagegen_model: p.imagegen_model ?? '',
                  vision_command: p.vision_command ?? '', imagegen_command: p.imagegen_command ?? '',
                })}>{copy.edit}</button>
              <button style={{ ...S.btn, padding: '2px 8px', opacity: 0.75 }}
                onClick={() => { if (confirm(copy.confirmDeleteProvider(p.name || p.id))) deleteProvider(p.id); }}>{copy.del}</button>
            </div>
          ))}
          {customProviders.some((p) => testResult?.key === `row:${p.id}`) && testReport(testResult!.key)}
          {provForm === null ? (
            <div><button style={S.btn} onClick={() => setProvForm({
              name: '', type: 'api', models: '', base_url: '', api_key: '', imagegen_model: '',
              vision_command: '', imagegen_command: '',
            })}>{copy.addProvider}</button></div>
          ) : (
            <div style={{ borderTop: '1px solid rgba(128,128,128,0.16)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={S.blockGrid}>
                <label style={S.field}><span style={S.fieldLabel}>{copy.providerName}</span>
                  <input autoFocus style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const }}
                    value={provForm.name} onChange={(e) => setProvForm({ ...provForm, name: e.target.value })} /></label>
                <label style={S.field}><span style={S.fieldLabel}>{copy.providerType}</span>
                  <CustomSelect value={provForm.type} onChange={(v) => setProvForm({ ...provForm, type: v as 'api' | 'cli' })}
                    options={[{ value: 'api', label: copy.typeApi }, { value: 'cli', label: copy.typeCli }]} /></label>
              </div>
              {provForm.type === 'api' ? (<>
                <div style={S.blockGrid}>
                  <label style={S.field}><span style={S.fieldLabel}>{copy.baseUrl}</span>
                    <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                      value={provForm.base_url} placeholder="https://api.example.com/v1"
                      onChange={(e) => setProvForm({ ...provForm, base_url: e.target.value })} /></label>
                  <label style={S.field}><span style={S.fieldLabel}>{copy.apiKey}</span>
                    <input type="password" autoComplete="off" style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                      value={provForm.api_key} placeholder={copy.keyPlaceholder}
                      onChange={(e) => setProvForm({ ...provForm, api_key: e.target.value })} /></label>
                  <label style={S.field}><span style={S.fieldLabel}>{copy.modelsField}</span>
                    <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                      value={provForm.models} placeholder="gpt-4o-mini, qwen-vl-max"
                      onChange={(e) => setProvForm({ ...provForm, models: e.target.value })} /></label>
                  <label style={S.field}><span style={S.fieldLabel}>{copy.imagegenModel}</span>
                    <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                      value={provForm.imagegen_model} placeholder="dall-e-3"
                      onChange={(e) => setProvForm({ ...provForm, imagegen_model: e.target.value })} /></label>
                </div>
                <div style={{ fontSize: 11.5, opacity: 0.55 }}>{copy.apiFormHint}</div>
              </>) : (<>
                <label style={S.field}><span style={S.fieldLabel}>{copy.visionCmd}</span>
                  <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                    value={provForm.vision_command} placeholder="mycli see {image} --ask {question} --model {model}"
                    onChange={(e) => setProvForm({ ...provForm, vision_command: e.target.value })} /></label>
                <label style={S.field}><span style={S.fieldLabel}>{copy.imagegenCmd}</span>
                  <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                    value={provForm.imagegen_command} placeholder="mycli gen {prompt} -o {output}"
                    onChange={(e) => setProvForm({ ...provForm, imagegen_command: e.target.value })} /></label>
                <label style={S.field}><span style={S.fieldLabel}>{copy.modelsField}</span>
                  <input style={{ ...S.input, width: '100%', boxSizing: 'border-box' as const, ...S.mono }}
                    value={provForm.models} placeholder="model-a, model-b"
                    onChange={(e) => setProvForm({ ...provForm, models: e.target.value })} /></label>
                <div style={{ fontSize: 11.5, opacity: 0.55 }}>{copy.cliFormHint}</div>
              </>)}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button style={S.btn} onClick={saveProviderForm}>{copy.saveProvider}</button>
                <button style={S.btn} title={copy.testTip} disabled={!!testResult?.busy}
                  onClick={() => runProviderTest('form', {
                    id: provForm.originalId ?? 'draft', name: provForm.name || 'draft', type: provForm.type,
                    models: provForm.models.split(/[,，\n]+/).map((x) => x.trim()).filter(Boolean),
                    base_url: provForm.base_url.trim(), api_key: provForm.api_key,
                    imagegen_model: provForm.imagegen_model.trim(),
                    vision_command: provForm.vision_command.trim(), imagegen_command: provForm.imagegen_command.trim(),
                  })}>
                  {testResult?.key === 'form' && testResult.busy ? copy.testing : copy.testProvider}</button>
                <button style={{ ...S.btn, opacity: 0.75 }} onClick={() => setProvForm(null)}>{copy.cancel}</button>
              </div>
              {testReport('form')}
            </div>
          )}
          </>), false)}
        </CollapsibleSection>
      </>)}
      <div style={{ fontSize: 11.5, opacity: 0.55, marginTop: 2 }}>{copy.globalHint}</div>

      {notice !== '' && <div style={{ fontSize: 12, opacity: 0.8, whiteSpace: 'pre-wrap' }}>{notice}</div>}

      <CollapsibleSection sectionId="jobs" title={copy.sectionNames.jobs}
        summary={sectionSummary(copy.jobCount(jobs.length), jobs.some((job) => job.status === 'running') && copy.runningCount(jobs.filter((job) => job.status === 'running').length))}
        expanded={!!expandedSections.jobs} onToggle={() => toggleSection('jobs')}>
        {jobs.length === 0 ? (
          <div style={{ opacity: 0.55 }}>{copy.empty}</div>
        ) : (
          <div style={{ overflowX: 'auto', border: '1px solid rgba(128,128,128,0.20)', borderRadius: 8, padding: '0 9px' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed', minWidth: 1020 }}>
              <colgroup>
                <col style={{ width: 68 }} /><col style={{ width: 72 }} /><col style={{ width: 58 }} />
                <col style={{ width: 190 }} /><col style={{ width: 70 }} /><col style={{ width: 70 }} />
                <col style={{ width: 105 }} /><col style={{ width: 84 }} /><col style={{ width: 300 }} />
              </colgroup>
              <thead><tr>
                {[copy.col.id, copy.col.role, copy.col.source, copy.col.model, copy.col.tier, copy.col.status, copy.col.progress, copy.col.tokens, copy.col.task].map((heading) => (
                  <th key={heading} style={{ ...S.tight, fontSize: 10.5, opacity: 0.55, fontWeight: 500 }}>{heading}</th>
                ))}
              </tr></thead>
              <tbody>
                {jobs.map((job) => {
                  const color = job.status === 'running' ? '#4a9eff' : job.status === 'done' ? '#3fb950' : '#f85149';
                  return (
                    <tr key={job.id}>
                      <td style={{ ...S.tight, ...S.mono, fontWeight: 600 }} title={job.id}>{String(job.id).replace(/-[a-z0-9]+$/, '')}</td>
                      <td style={S.tight}><span style={S.chip(job.role === 'reviewer')}>{job.role === 'reviewer' ? 'Reviewer' : 'Worker'}</span></td>
                      <td style={S.tight}><span style={S.chip(job.source === 'claude-code' || job.source === 'codex')}>{sourceLabel(job.source)}</span></td>
                      <td style={{ ...S.tight, ...S.mono }} title={`${job.provider ?? '—'} / ${job.model ?? '—'}`}>{job.provider ?? '—'} / {job.model ?? '—'}</td>
                      <td style={S.tight}>{job.tier}/{job.effort}</td>
                      <td style={S.tight} title={`${job.status}${job.currentTool ? ` · ${job.currentTool}` : ''}`}>
                        <span style={{ color }} aria-hidden="true">●</span> <span style={{ color, fontSize: 10.5 }}>{job.status}</span>
                      </td>
                      <td style={{ ...S.tight, ...S.mono }} title={copy.progressTip(elapsed(job.startedAt, job.endedAt), job.turn, job.step, job.toolCalls ?? '-')}>{elapsed(job.startedAt, job.endedAt)} · {job.turn}.{job.step} · {job.toolCalls ?? '-'}t</td>
                      <td style={{ ...S.tight, ...S.mono }}>{job.tokens ? `${ktok(job.tokens.input)}/${ktok(job.tokens.output)}` : '—'}</td>
                      <td
                        style={{ ...S.cell, position: 'relative' }}
                        onMouseEnter={(event: any) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          setHoverTask({ id: job.id, text: job.task, right: Math.max(8, window.innerWidth - rect.right), top: rect.bottom + 4, bottom: window.innerHeight - rect.top + 4, flip: rect.top < 240 });
                        }}
                        onMouseLeave={() => setHoverTask(null)}>
                        <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.45, fontSize: 12 }}>
                          {job.task}
                        </div>
                        <div style={{ fontSize: 10, opacity: 0.5 }}>{job.selection_source ?? 'unknown'}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ ...S.block, marginTop: 2 }}>
          <div>
            <div style={S.settingTitle}>{copy.modelActivity}</div>
            <div style={S.settingDesc}>{copy.modelActivityHint}</div>
          </div>
          {modelActivity.length === 0 ? <div style={{ opacity: 0.55 }}>{copy.noModelActivity}</div> : (
            <div style={{ overflowX: 'auto' }}>
              <div role="table" style={{ minWidth: 620 }}>
                <div role="row" style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 1.35fr) 72px minmax(170px, 1fr) 125px', gap: 10, padding: '0 6px 5px', fontSize: 10.5, opacity: 0.55 }}>
                  <span role="columnheader">{copy.model}</span><span role="columnheader">{copy.calls}</span><span role="columnheader">{copy.invocationSource} / {copy.routingSource}</span><span role="columnheader">{copy.lastCalled}</span>
                </div>
                {modelActivity.map((entry) => (
                  <div role="row" key={`${entry.provider}/${entry.model}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 1.35fr) 72px minmax(170px, 1fr) 125px', gap: 10, alignItems: 'center', padding: '7px 6px', borderTop: '1px solid rgba(128,128,128,0.16)' }}>
                    <span role="cell" style={{ minWidth: 0 }}><strong style={{ display: 'block', fontSize: 12 }}>{entry.model}</strong><span style={{ ...S.mono, opacity: 0.55 }}>{entry.provider}</span></span>
                    <span role="cell" style={{ ...S.mono, fontSize: 15, fontWeight: 650 }}>{entry.count}</span>
                    <span role="cell" style={{ minWidth: 0, fontSize: 11.5 }}><span style={{ display: 'block' }}>{entry.task_sources.map(sourceLabel).join(' · ')}</span><span style={{ display: 'block', opacity: 0.55 }}>{entry.selection_sources.join(' · ')} · {entry.roles.join(' / ')}</span></span>
                    <span role="cell" style={{ ...S.mono, fontSize: 10.5 }}>{formatTimestamp(entry.last_called_at, locale)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>
      {hoverTask && createPortal(
        <div style={{
          position: 'fixed', right: hoverTask.right, zIndex: 9999,
          ...(hoverTask.flip ? { top: hoverTask.top } : { bottom: hoverTask.bottom }),
          minWidth: 260, maxWidth: 420, maxHeight: 180, overflowY: 'auto',
          padding: '8px 12px', borderRadius: 8,
          border: '1px solid rgba(128,128,128,0.35)',
          background: 'Canvas', color: 'CanvasText',
          boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
          whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5,
        }}>{hoverTask.text}</div>,
        document.body,
      )}
    </div>
  );
}

export function apply(ctx: any): void {
  let runningCount = 0;
  let officialSurface: boolean | null = null;
  ctx.slots.inject('settings.section', () => {
    let dispose = register();
    function register() {
      return ctx.slots.register(
        {
          name: 'settings.section',
          id: 'dsh-crew',
          order: 65,
          label: () => {
            const base = COPY[ctx.locale.getLocale().active === 'zh' ? 'zh' : 'en'].label;
            if (runningCount <= 0) return base;
            // String-only slot labels: filled circled digits are the closest
            // thing to a badge the contract allows.
            const CIRCLED = ['❶', '❷', '❸', '❹', '❺', '❻', '❼', '❽', '❾', '❿'];
            return `${base} ${CIRCLED[runningCount - 1] ?? `(${runningCount})`}`;
          },
        },
        () => <WorkersPanel ctx={ctx} />,
      );
    }
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        if (officialSurface === null) {
          const response = await fetch(`${API}/bridge-status`, { cache: 'no-store' });
          const bridgeStatus = response.ok ? await response.json() : null;
          officialSurface = classifyCrewSurface({ bridgeStatus }) === CREW_UI_SURFACES.OFFICIAL;
        }
        if (!officialSurface) return;
        const r = await (await fetch(`${API}/jobs`, { cache: 'no-store' })).json();
        const n = r.ok ? (r.jobs ?? []).filter((j: any) => j.status === 'running').length : 0;
        if (n !== runningCount) {
          runningCount = n;
          dispose(); dispose = register(); // slots/changed → nav re-renders the label
        }
      } catch { /* hub restarting */ }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 10_000);
    return () => { clearInterval(timer); dispose(); };
  });
}
