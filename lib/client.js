window.__ModuleLoader__.load({ id: "@zseven-w/dsh-crew", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_dom = require("react-dom");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/client/index.tsx
const inject = ["slots", "locale"];
const API = "/_dsh/dsh-crew";
const COPY = {
	zh: {
		label: "DSH Crew",
		title: "DSH Crew",
		intro: "把 Claude Code / Codex 的子任务派给 DSH agent 来干：worker 用的是本 harness 的工具、沙箱与预设，会话跑在本实例内，在宿主里则以原生子代理形态出现、进度可见。档位（flash / pro）决定 worker 从已配置的模型阵容里拿到多强的能力。下面配置派发默认值、执行方式，以及借订阅或自有 API 补上的视觉与生图能力，并可一键装进宿主。",
		integrations: "集成",
		installed: "已安装",
		notInstalled: "未安装",
		hud: "HUD 段",
		install: "安装",
		update: "更新",
		restore: "还原",
		confirmRestore: (name) => `确定从 ${name} 移除 dsh-crew 集成？（settings 会先备份）`,
		globalConfig: "全局配置",
		globalHint: "修改即时保存到 ~/.config/dsh-crew/config.json；CC / Codex 的新会话自动读取为默认值（会话内可用 /dsh-crew:config 临时覆盖）。",
		tier: "默认档位",
		effort: "默认推理",
		mode: "执行模式",
		timeout: "默认超时(秒)",
		hubUrl: "Hub 地址",
		tierPolicy: "档位策略",
		escalate: "失败升档",
		tierPolicyDesc: {
			auto: "auto · orchestrator 自选",
			"flash-only": "只用 flash",
			"pro-only": "只用 pro"
		},
		escalateHint: "flash 失败自动用 pro 重试一次",
		presetFlash: "flash 模式",
		presetPro: "pro 模式",
		multimodal: "多模态",
		visionProvider: "视觉 provider",
		visionModel: "视觉模型",
		imagegenProvider: "生图 provider",
		customProviders: "自定义 Provider",
		addProvider: "＋ 添加 Provider",
		noCustomProviders: "暂无。添加后会出现在上方的视觉 / 生图 provider 选择里。",
		providerName: "名称",
		modelsField: "模型列表（逗号分隔）",
		providerType: "接入方式",
		typeApi: "API · 兼容 OpenAI 接口",
		typeCli: "CLI · 本地命令",
		baseUrl: "Base URL",
		apiKey: "API Key",
		imagegenModel: "生图模型（留空=不提供生图）",
		visionCmd: "视觉命令（可选）",
		imagegenCmd: "生图命令（可选）",
		apiFormHint: "走 OpenAI 兼容接口：视觉调 {base}/chat/completions（图片以 base64 内联），生图调 {base}/images/generations。Key 保存在本机 ~/.config/dsh-crew/config.json，不会外发到第三方。",
		cliFormHint: "命令经 bash 执行，占位符会被安全引用后代入。视觉: {image} {question} {model}，stdout 即答案；生图: {prompt} {output} {size}，命令须把图片写到 {output}。两条命令至少填一条。",
		saveProvider: "保存",
		cancel: "取消",
		edit: "编辑",
		del: "删除",
		testProvider: "连通测试",
		testing: "测试中…",
		testTip: "按当前填写的内容实测：API 会检查可达性与鉴权并真发一次视觉请求；CLI 会检查可执行文件并真跑一次视觉命令。生图只校验配置，不实际出图。",
		testPass: "连通正常",
		testFail: "连通失败",
		staleHub: "本 DSH 实例还在跑旧版插件，缺少该接口 —— 重启 DSH 后再试",
		emptyResponse: (path, status) => `${path} → HTTP ${status}，响应为空`,
		badJson: (path, body) => `${path} → 非 JSON 响应: ${body}`,
		refreshModels: "重新从 CLI 获取模型列表",
		presetDefault: (id) => `default · 跟随 DSH${id ? ` (${id})` : ""}`,
		progressTip: (t, turn, step, calls) => `耗时 ${t} · 第${turn}轮第${step}步 · ${calls} 次工具调用`,
		confirmDeleteProvider: (n) => `删除自定义 provider「${n}」？`,
		needName: "⚠ 名称必填",
		needCmd: "⚠ 视觉/生图命令至少填一条",
		needBaseUrl: "⚠ Base URL 必填",
		needModels: "⚠ 模型列表至少填一个",
		keySet: "已配置",
		keyPlaceholder: "sk-…（留空则不发送 Authorization）",
		addModelTip: "添加模型到列表",
		removeModelTip: "从列表移除当前模型",
		modelPlaceholder: "模型 id，回车确认",
		capVision: "视觉",
		capImagegen: "生图",
		groupDispatch: "派发",
		groupRuntime: "运行",
		groupMultimodal: "多模态",
		cardDispatch: {
			t: "派发策略",
			d: "orchestrator 未指定时的档位与推理强度，以及档位约束、失败升档与两档各自挂载的 Agent 预设。"
		},
		cardRuntime: {
			t: "执行与连接",
			d: "worker 会话跑在本实例内还是独立进程，单个任务的超时上限，以及 CC / Codex 探测本实例的地址。"
		},
		cardMM: {
			t: "视觉与生图",
			d: "给纯文本的 DSH 模型借来眼睛和画笔：describe_image、会话贴图转写与 generate_image 都用这里的设置。"
		},
		cardCustomProv: {
			t: "自定义 Provider",
			d: "接入自己的 API 或本地命令；保存后会出现在上面的视觉 / 生图 provider 选择里。"
		},
		modeDesc: {
			auto: "auto · 优先 hub",
			hub: "hub · 必须 hub",
			standalone: "standalone · 独立进程"
		},
		save: "保存",
		saved: "已保存",
		jobs: "Worker 任务",
		empty: "当前没有 worker 任务。",
		col: {
			id: "任务",
			source: "来源",
			tier: "档位",
			status: "状态",
			progress: "进度",
			tokens: "tokens ⇅",
			task: "内容"
		},
		working: "处理中…",
		tips: {
			claude: {
				install: "一键装进 Claude Code：注册本地 marketplace、claude plugin install、写入工具权限白名单、接线 claude-hud worker 段；修改 settings.json 前自动备份",
				update: "重跑安装流程：刷新注册与权限、迁移旧格式配置、更新 HUD 接线；幂等，可放心点",
				restore: "从 Claude Code 移除集成：清除 marketplace 注册、插件启用项与权限规则（settings 先备份）；不删除插件源码与已跑任务"
			},
			codex: {
				install: "把 ds-flash / ds-pro 角色和 /dsh-config、/dsh-status 命令复制到 ~/.codex/（MCP 路径按本机自动渲染，含 approve 审批与超时配置）",
				update: "重新渲染并覆盖角色文件与命令（插件路径或配置变更后用）；原文件先备份",
				restore: "删除 ~/.codex/ 下的 ds-flash / ds-pro 角色与 dsh 命令文件（角色文件先备份）"
			}
		}
	},
	en: {
		label: "DSH Crew",
		title: "DSH Crew",
		intro: "Dispatch subtasks from Claude Code / Codex to DSH agents: a worker runs with this harness's tools, sandbox and presets, its session lives in this instance, and the host still shows it as a native subagent with live progress. Tiers (flash / pro) decide how much capability a worker gets from the configured model roster. Configure dispatch defaults, execution, and the vision / image-generation abilities borrowed from your subscriptions or your own API below, then install into the host in one click.",
		integrations: "Integrations",
		installed: "installed",
		notInstalled: "not installed",
		hud: "HUD segment",
		install: "Install",
		update: "Update",
		restore: "Restore",
		confirmRestore: (name) => `Remove the dsh-crew integration from ${name}? (settings are backed up first)`,
		globalConfig: "Global configuration",
		globalHint: "Changes save instantly to ~/.config/dsh-crew/config.json; new CC / Codex sessions pick them up as defaults (override per session with /dsh-crew:config).",
		tier: "Default tier",
		effort: "Default effort",
		mode: "Mode",
		timeout: "Timeout (s)",
		hubUrl: "Hub URL",
		tierPolicy: "Tier policy",
		escalate: "Escalate on failure",
		tierPolicyDesc: {
			auto: "auto · orchestrator picks",
			"flash-only": "flash only",
			"pro-only": "pro only"
		},
		escalateHint: "retry a failed flash run once on pro",
		presetFlash: "flash preset",
		presetPro: "pro preset",
		multimodal: "Multimodal",
		visionProvider: "Vision provider",
		visionModel: "Vision model",
		imagegenProvider: "Image-gen provider",
		customProviders: "Custom providers",
		addProvider: "＋ Add provider",
		noCustomProviders: "None yet. Added providers appear in the vision / image-gen selects above.",
		providerName: "Name",
		modelsField: "Models (comma-separated)",
		providerType: "Connection",
		typeApi: "API · OpenAI-compatible",
		typeCli: "CLI · local command",
		baseUrl: "Base URL",
		apiKey: "API key",
		imagegenModel: "Image-gen model (empty = no image generation)",
		visionCmd: "Vision command (optional)",
		imagegenCmd: "Image-gen command (optional)",
		apiFormHint: "OpenAI-compatible: vision calls {base}/chat/completions (image inlined as base64), image-gen calls {base}/images/generations. The key is stored locally in ~/.config/dsh-crew/config.json and never sent to third parties.",
		cliFormHint: "Commands run via bash with shell-quoted placeholders. Vision: {image} {question} {model}, stdout is the answer; image-gen: {prompt} {output} {size}, the command must write the image to {output}. Fill in at least one command.",
		saveProvider: "Save",
		cancel: "Cancel",
		edit: "Edit",
		del: "Delete",
		testProvider: "Test",
		testing: "Testing…",
		testTip: "Probes what is currently filled in: API checks reachability and auth then makes one real vision call; CLI checks the executable then runs the vision command once. Image generation is only validated, never actually run.",
		testPass: "Connection OK",
		testFail: "Connection failed",
		staleHub: "This DSH instance is still running an older build of the plugin and lacks this route — restart DSH and retry",
		emptyResponse: (path, status) => `${path} → HTTP ${status}, empty response`,
		badJson: (path, body) => `${path} → non-JSON response: ${body}`,
		refreshModels: "Re-fetch the model list from the CLI",
		presetDefault: (id) => `default · follow DSH${id ? ` (${id})` : ""}`,
		progressTip: (t, turn, step, calls) => `${t} elapsed · turn ${turn}, step ${step} · ${calls} tool calls`,
		confirmDeleteProvider: (n) => `Delete custom provider "${n}"?`,
		needName: "⚠ Name is required",
		needCmd: "⚠ Fill in at least one command",
		needBaseUrl: "⚠ Base URL is required",
		needModels: "⚠ Add at least one model",
		keySet: "set",
		keyPlaceholder: "sk-… (leave empty to send no Authorization header)",
		addModelTip: "Add a model to the list",
		removeModelTip: "Remove the current model from the list",
		modelPlaceholder: "model id, Enter to confirm",
		capVision: "vision",
		capImagegen: "image-gen",
		groupDispatch: "Dispatch",
		groupRuntime: "Runtime",
		groupMultimodal: "Multimodal",
		cardDispatch: {
			t: "Dispatch policy",
			d: "Tier and effort used when the orchestrator names none, plus tier clamping, failure escalation and the Agent preset mounted per tier."
		},
		cardRuntime: {
			t: "Execution & connection",
			d: "Whether worker sessions run inside this instance or a separate process, the per-job timeout, and the address CC / Codex probes."
		},
		cardMM: {
			t: "Vision & image generation",
			d: "Lends the harness's text-only models eyes and a brush: describe_image, pasted-image transcription and generate_image all use these settings."
		},
		cardCustomProv: {
			t: "Custom providers",
			d: "Bring your own API or local command; saved providers appear in the vision / image-gen selects above."
		},
		modeDesc: {
			auto: "auto · prefer hub",
			hub: "hub · require hub",
			standalone: "standalone"
		},
		save: "Save",
		saved: "Saved",
		jobs: "Worker jobs",
		empty: "No worker jobs yet.",
		col: {
			id: "job",
			source: "source",
			tier: "tier",
			status: "status",
			progress: "progress",
			tokens: "tokens ⇅",
			task: "task"
		},
		working: "Working…",
		tips: {
			claude: {
				install: "One-click install into Claude Code: register local marketplace, claude plugin install, permission allowlist, claude-hud segment wiring; settings.json backed up first",
				update: "Re-run the installer: refresh registration & permissions, migrate legacy config, update HUD wiring; idempotent",
				restore: "Remove the integration from Claude Code: marketplace registration, plugin enablement and permission rules (settings backed up); plugin source and past jobs untouched"
			},
			codex: {
				install: "Copy ds-flash / ds-pro roles and /dsh-config, /dsh-status prompts into ~/.codex/ (MCP paths rendered for this machine, approve mode + timeout included)",
				update: "Re-render and overwrite role files and prompts (after path/config changes); originals backed up",
				restore: "Delete ds-flash / ds-pro roles and dsh prompts from ~/.codex/ (roles backed up first)"
			}
		}
	}
};
const S = {
	section: {
		margin: "8px 0 -2px",
		fontSize: 13,
		fontWeight: 600,
		opacity: .9
	},
	group: {
		margin: "4px 0 -3px",
		fontSize: 12,
		opacity: .55
	},
	block: {
		border: "1px solid rgba(128,128,128,0.22)",
		borderRadius: 10,
		padding: "11px 14px 13px",
		display: "flex",
		flexDirection: "column",
		gap: 10
	},
	blockGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
		gap: "12px 14px",
		alignItems: "end"
	},
	settingTitle: {
		fontWeight: 600,
		fontSize: 13
	},
	settingDesc: {
		fontSize: 11.5,
		opacity: .6,
		marginTop: 2,
		lineHeight: 1.5
	},
	card: {
		border: "1px solid rgba(128,128,128,0.22)",
		borderRadius: 8,
		padding: "10px 14px",
		display: "flex",
		alignItems: "center",
		gap: 10,
		flexWrap: "wrap"
	},
	grid: {
		border: "1px solid rgba(128,128,128,0.22)",
		borderRadius: 8,
		padding: "12px 14px",
		display: "grid",
		gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
		gap: "12px 14px",
		alignItems: "end"
	},
	btn: {
		padding: "4px 12px",
		borderRadius: 6,
		border: "1px solid rgba(128,128,128,0.35)",
		background: "transparent",
		color: "inherit",
		cursor: "pointer",
		fontSize: 12.5
	},
	chip: (on) => ({
		fontSize: 11.5,
		padding: "1px 8px",
		borderRadius: 99,
		border: "1px solid",
		borderColor: on ? "rgba(63,185,80,0.5)" : "rgba(128,128,128,0.35)",
		color: on ? "#3fb950" : "inherit",
		opacity: on ? 1 : .55
	}),
	field: {
		display: "flex",
		flexDirection: "column",
		gap: 3
	},
	fieldLabel: {
		fontSize: 11,
		opacity: .6
	},
	input: {
		padding: "3px 8px",
		borderRadius: 5,
		border: "1px solid rgba(128,128,128,0.35)",
		background: "transparent",
		color: "inherit",
		fontSize: 12.5
	},
	cell: {
		padding: "5px 10px 5px 0",
		borderBottom: "1px solid rgba(128,128,128,0.16)",
		textAlign: "left",
		verticalAlign: "top"
	},
	tight: {
		padding: "5px 8px 5px 0",
		borderBottom: "1px solid rgba(128,128,128,0.16)",
		textAlign: "left",
		verticalAlign: "top",
		whiteSpace: "nowrap",
		overflow: "hidden",
		textOverflow: "ellipsis"
	},
	mono: {
		fontFamily: "ui-monospace, Menlo, monospace",
		fontSize: 12,
		fontVariantNumeric: "tabular-nums"
	}
};
const VISION_MODELS = {
	"claude-code": [
		"haiku",
		"sonnet",
		"opus"
	],
	codex: [
		"default",
		"gpt-5.4-mini",
		"gpt-5.6"
	],
	grok: ["default"],
	agy: ["default"]
};
function CustomSelect({ value, options, onChange, minWidth }) {
	const [open, setOpen] = (0, react.useState)(null);
	(0, react.useEffect)(() => {
		if (!open) return;
		const close = () => setOpen(null);
		const onKey = (e) => {
			if (e.key === "Escape") close();
		};
		const t = setTimeout(() => document.addEventListener("mousedown", close), 0);
		document.addEventListener("keydown", onKey);
		return () => {
			clearTimeout(t);
			document.removeEventListener("mousedown", close);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);
	const current = options.find((o) => o.value === value);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		style: {
			...S.input,
			display: "flex",
			alignItems: "center",
			gap: 6,
			cursor: "pointer",
			minWidth: minWidth ?? 92,
			width: "100%",
			boxSizing: "border-box",
			justifyContent: "space-between"
		},
		onClick: (e) => {
			const r = e.currentTarget.getBoundingClientRect();
			const up = window.innerHeight - r.bottom < 240;
			setOpen({
				left: r.left,
				top: r.bottom + 4,
				bottom: window.innerHeight - r.top + 4,
				width: Math.max(r.width, 130),
				up
			});
		},
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: {
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			children: current?.label ?? value
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: {
				opacity: .5,
				fontSize: 10
			},
			children: "▾"
		})]
	}), open && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: {
			position: "fixed",
			left: open.left,
			...open.up ? { bottom: open.bottom } : { top: open.top },
			minWidth: open.width,
			zIndex: 9999,
			background: "Canvas",
			color: "CanvasText",
			border: "1px solid rgba(128,128,128,0.3)",
			borderRadius: 8,
			boxShadow: "0 8px 28px rgba(0,0,0,0.22)",
			padding: 4,
			maxHeight: 240,
			overflowY: "auto"
		},
		onMouseDown: (e) => e.stopPropagation(),
		children: options.map((o) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			onClick: () => {
				onChange(o.value);
				setOpen(null);
			},
			style: {
				padding: "5px 10px",
				borderRadius: 5,
				cursor: "pointer",
				fontSize: 12.5,
				whiteSpace: "nowrap",
				background: o.value === value ? "rgba(128,128,128,0.16)" : "transparent",
				display: "flex",
				justifyContent: "space-between",
				gap: 12,
				alignItems: "center"
			},
			onMouseEnter: (e) => {
				e.currentTarget.style.background = "rgba(128,128,128,0.24)";
			},
			onMouseLeave: (e) => {
				e.currentTarget.style.background = o.value === value ? "rgba(128,128,128,0.16)" : "transparent";
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: o.label ?? o.value }), o.value === value && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					opacity: .6,
					fontSize: 11
				},
				children: "✓"
			})]
		}, o.value))
	}), document.body)] });
}
function sourceLabel(source) {
	if (source === "claude-code") return "CC";
	if (source === "codex") return "Codex";
	if (source === "api" || source === void 0) return "API";
	return source;
}
function elapsed(startedAt, endedAt) {
	const s = Math.max(0, Math.round(((endedAt ? +new Date(endedAt) : Date.now()) - +new Date(startedAt)) / 1e3));
	return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}
function ktok(n) {
	return n >= 1e3 ? `${Math.round(n / 100) / 10}k` : `${n}`;
}
function WorkersPanel({ ctx }) {
	const locale = (0, react.useSyncExternalStore)((notify) => ctx.on("locale/change", notify), () => ctx.locale.getLocale().active, () => ctx.locale.getLocale().active);
	const copy = COPY[locale === "zh" ? "zh" : "en"];
	const [jobs, setJobs] = (0, react.useState)([]);
	const [hoverTask, setHoverTask] = (0, react.useState)(null);
	const [status, setStatus] = (0, react.useState)(null);
	const [config, setConfig] = (0, react.useState)(null);
	const [dynModels, setDynModels] = (0, react.useState)({});
	const [presetOptions, setPresetOptions] = (0, react.useState)([{ value: "default" }]);
	const [notice, setNotice] = (0, react.useState)("");
	const [busy, setBusy] = (0, react.useState)(false);
	const [provForm, setProvForm] = (0, react.useState)(null);
	const [modelAdd, setModelAdd] = (0, react.useState)(null);
	const [testResult, setTestResult] = (0, react.useState)(null);
	/**
	* The panel is served from disk on every load, but the hub's routes are
	* registered at instance boot — after an upgrade the new UI can call a route
	* the running instance does not have yet, which answers 404/405 with an empty
	* body. Report that as "restart DSH" instead of a JSON parse error.
	*/
	const readJson = (0, react.useCallback)(async (res, path) => {
		const text = await res.text();
		if (text === "") throw new Error(res.status === 404 || res.status === 405 ? `${copy.staleHub}（${path} → HTTP ${res.status}）` : copy.emptyResponse(path, res.status));
		try {
			return JSON.parse(text);
		} catch {
			throw new Error(copy.badJson(path, text.slice(0, 160)));
		}
	}, [copy]);
	/** Every request carries the active locale: the panel is the authority on it
	* (DSH's setting may be unset), and the hub localizes its own strings from it. */
	const withLang = (0, react.useCallback)((path) => `${API}${path}${path.includes("?") ? "&" : "?"}lang=${locale === "zh" ? "zh" : "en"}`, [locale]);
	const get = (0, react.useCallback)(async (path) => readJson(await fetch(withLang(path), { cache: "no-store" }), path), [readJson, withLang]);
	const post = (0, react.useCallback)(async (path, body) => readJson(await fetch(withLang(path), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			...body,
			lang: locale === "zh" ? "zh" : "en"
		})
	}), path), [
		readJson,
		withLang,
		locale
	]);
	const refreshAll = (0, react.useCallback)(async () => {
		try {
			const [j, s, c, pr] = await Promise.all([
				get("/jobs"),
				get("/install/status"),
				get("/config"),
				get("/presets")
			]);
			if (j.ok) setJobs(j.jobs ?? []);
			if (s.ok) setStatus(s.status);
			if (c.ok) setConfig((prev) => prev ?? c.config);
			if (pr.ok) setPresetOptions([{
				value: "default",
				label: copy.presetDefault(pr.defaultId)
			}, ...(pr.presets ?? []).map((x) => ({
				value: x.id,
				label: x.name ?? x.id
			}))]);
		} catch {}
	}, [get]);
	(0, react.useEffect)(() => {
		refreshAll();
		const timer = setInterval(() => {
			get("/jobs").then((j) => {
				if (j.ok) setJobs(j.jobs ?? []);
			}).catch(() => {});
		}, 3e3);
		return () => clearInterval(timer);
	}, [refreshAll, get]);
	const act = (0, react.useCallback)(async (target, confirmName) => {
		if (confirmName && !window.confirm(copy.confirmRestore(confirmName))) return;
		setBusy(true);
		setNotice(copy.working);
		try {
			const r = await post("/install", { target });
			if (r.ok === false) throw new Error(r.error);
			setNotice((r.actions ?? []).join("；"));
			const s = await get("/install/status");
			if (s.ok) setStatus(s.status);
		} catch (e) {
			setNotice(String(e?.message ?? e));
		} finally {
			setBusy(false);
		}
	}, [
		post,
		get,
		copy
	]);
	const applyPatch = (0, react.useCallback)((patch) => {
		post("/config", patch).then((r) => {
			if (r.ok) {
				setConfig(r.config);
				setNotice(copy.saved);
				setTimeout(() => setNotice(""), 1500);
			}
		}).catch(() => {});
	}, [post, copy]);
	/** Selects & checkboxes: apply immediately. */
	const field = (key, value) => {
		setConfig((c) => ({
			...c,
			[key]: value
		}));
		applyPatch({ [key]: value });
	};
	/** Text/number inputs: track locally, apply on blur. */
	const fieldLocal = (key, value) => setConfig((c) => ({
		...c,
		[key]: value
	}));
	const customProviders = config?.custom_providers ?? [];
	const extraModels = config?.extra_models ?? {};
	const RESERVED_IDS = [
		"claude-code",
		"codex",
		"grok",
		"agy",
		"off",
		"custom",
		"default"
	];
	const provType = (p) => p.type ?? (p.vision_command || p.imagegen_command ? "cli" : "api");
	const canSee = (p) => provType(p) === "cli" ? !!p.vision_command : !!p.base_url && (p.models?.length ?? 0) > 0;
	const canDraw = (p) => provType(p) === "cli" ? !!p.imagegen_command : !!p.base_url && !!String(p.imagegen_model ?? "").trim();
	const visionProviderOptions = [
		{ value: "claude-code" },
		{ value: "codex" },
		{ value: "grok" },
		{ value: "agy" },
		...customProviders.filter(canSee).map((p) => ({
			value: p.id,
			label: p.name || p.id
		})),
		{ value: "off" }
	];
	const imagegenProviderOptions = [
		{ value: "codex" },
		{
			value: "agy",
			label: "agy (nano banana)"
		},
		{
			value: "grok",
			label: "grok (imagine)"
		},
		...customProviders.filter(canDraw).map((p) => ({
			value: p.id,
			label: p.name || p.id
		})),
		{ value: "off" }
	];
	const visionModelOptions = (() => {
		if (!config) return [];
		const p = config.vision_provider;
		const custom = customProviders.find((c) => c.id === p);
		const base = custom ? [{ value: "default" }, ...(custom.models ?? []).map((m) => ({ value: m }))] : dynModels[p] ?? (VISION_MODELS[p] ?? ["default"]).map((m) => ({ value: m }));
		const extras = (extraModels[p] ?? []).filter((m) => !base.some((o) => o.value === m)).map((m) => ({ value: m }));
		return [...base, ...extras];
	})();
	const commitModelAdd = () => {
		const m = (modelAdd ?? "").trim();
		setModelAdd(null);
		if (m === "" || !config) return;
		const p = config.vision_provider;
		const cur = extraModels[p] ?? [];
		const nextExtra = {
			...extraModels,
			[p]: cur.includes(m) ? cur : [...cur, m]
		};
		setConfig((c) => ({
			...c,
			extra_models: nextExtra,
			vision_model: m
		}));
		applyPatch({
			extra_models: nextExtra,
			vision_model: m
		});
	};
	const removeCurrentModel = () => {
		if (!config) return;
		const p = config.vision_provider;
		const m = config.vision_model;
		const nextExtra = {
			...extraModels,
			[p]: (extraModels[p] ?? []).filter((x) => x !== m)
		};
		const fallback = visionModelOptions.find((o) => o.value !== m)?.value ?? "default";
		setConfig((c) => ({
			...c,
			extra_models: nextExtra,
			vision_model: fallback
		}));
		applyPatch({
			extra_models: nextExtra,
			vision_model: fallback
		});
	};
	const saveProviderForm = () => {
		if (!provForm || !config) return;
		const name = provForm.name.trim();
		if (name === "") {
			setNotice(copy.needName);
			return;
		}
		const models = provForm.models.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
		const vision_command = provForm.vision_command.trim();
		const imagegen_command = provForm.imagegen_command.trim();
		if (provForm.type === "cli") {
			if (vision_command === "" && imagegen_command === "") {
				setNotice(copy.needCmd);
				return;
			}
		} else {
			if (provForm.base_url.trim() === "") {
				setNotice(copy.needBaseUrl);
				return;
			}
			if (models.length === 0) {
				setNotice(copy.needModels);
				return;
			}
		}
		let id = provForm.originalId;
		if (!id) {
			const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
			id = base;
			let n = 2;
			while (RESERVED_IDS.includes(id) || customProviders.some((p) => p.id === id)) id = `${base}-${n++}`;
		}
		const entry = provForm.type === "api" ? {
			id,
			name,
			type: "api",
			models,
			base_url: provForm.base_url.trim(),
			api_key: provForm.api_key,
			imagegen_model: provForm.imagegen_model.trim()
		} : {
			id,
			name,
			type: "cli",
			models,
			vision_command,
			imagegen_command
		};
		const next = provForm.originalId ? customProviders.map((p) => p.id === provForm.originalId ? entry : p) : [...customProviders, entry];
		field("custom_providers", next);
		setProvForm(null);
	};
	const runProviderTest = (key, entry) => {
		setTestResult({
			key,
			busy: true
		});
		post("/provider-test", entry).then((r) => setTestResult(r.ok ? {
			key,
			busy: false,
			ok: r.result.ok,
			steps: r.result.steps
		} : {
			key,
			busy: false,
			ok: false,
			error: r.error
		})).catch((e) => setTestResult({
			key,
			busy: false,
			ok: false,
			error: String(e?.message ?? e)
		}));
	};
	/** Shared renderer for a test outcome under the button that triggered it. */
	const testReport = (key) => {
		if (!testResult || testResult.key !== key) return null;
		if (testResult.busy) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: {
				fontSize: 11.5,
				opacity: .6
			},
			children: copy.testing
		});
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				fontSize: 11.5,
				display: "flex",
				flexDirection: "column",
				gap: 2
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: { color: testResult.ok ? "#3fb950" : "#f85149" },
					children: testResult.ok ? `✓ ${copy.testPass}` : `✗ ${copy.testFail}`
				}),
				testResult.error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						opacity: .7,
						wordBreak: "break-all"
					},
					children: testResult.error
				}),
				(testResult.steps ?? []).map((st, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					style: {
						opacity: .7,
						wordBreak: "break-all"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { color: st.ok ? "#3fb950" : "#f85149" },
							children: st.ok ? "✓" : "✗"
						}),
						" ",
						st.name,
						": ",
						st.detail
					]
				}, i))
			]
		});
	};
	const deleteProvider = (id) => {
		if (!config) return;
		const patch = { custom_providers: customProviders.filter((p) => p.id !== id) };
		if (config.vision_provider === id) {
			patch.vision_provider = "claude-code";
			patch.vision_model = "haiku";
		}
		if (config.imagegen_provider === id) patch.imagegen_provider = "codex";
		setConfig((c) => ({
			...c,
			...patch
		}));
		applyPatch(patch);
	};
	/** Card: title + one-line description header, then its fields. */
	const block = (text, fields, gridded = true) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: S.block,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: S.settingTitle,
			children: text.t
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: S.settingDesc,
			children: text.d
		})] }), gridded ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: S.blockGrid,
			children: fields
		}) : fields]
	});
	const integrationRow = (name, installed, extra, installTarget, uninstallTarget, tips) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: S.card,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					fontWeight: 600,
					fontSize: 13,
					minWidth: 92
				},
				children: name
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: S.chip(installed),
				children: installed ? `● ${copy.installed}` : `○ ${copy.notInstalled}`
			}),
			extra,
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
			!installed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				style: S.btn,
				title: tips.install,
				disabled: busy,
				onClick: () => {
					act(installTarget);
				},
				children: copy.install
			}),
			installed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				style: S.btn,
				title: tips.update,
				disabled: busy,
				onClick: () => {
					act(installTarget);
				},
				children: copy.update
			}),
			installed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				style: {
					...S.btn,
					opacity: .75
				},
				title: tips.restore,
				disabled: busy,
				onClick: () => {
					act(uninstallTarget, name);
				},
				children: copy.restore
			})
		]
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			gap: 8,
			fontSize: 13,
			lineHeight: 1.55
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: 19,
					fontWeight: 600,
					marginBottom: -2
				},
				children: copy.title
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { opacity: .75 },
				children: copy.intro
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: S.section,
				children: copy.integrations
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 8
				},
				children: [integrationRow("Claude Code", !!status?.claude?.installed, status?.claude?.installed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: S.chip(!!status?.claude?.hud),
					children: copy.hud
				}) : null, "claude", "claude-uninstall", copy.tips.claude), integrationRow("Codex", !!status?.codex?.installed, null, "codex", "codex-uninstall", copy.tips.codex)]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: S.section,
				children: copy.globalConfig
			}),
			config && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: S.group,
					children: copy.groupDispatch
				}),
				block(copy.cardDispatch, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: S.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: S.fieldLabel,
							children: copy.tier
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CustomSelect, {
							value: config.default_tier,
							onChange: (v) => field("default_tier", v),
							options: [{ value: "flash" }, { value: "pro" }]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: S.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: S.fieldLabel,
							children: copy.effort
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CustomSelect, {
							value: config.default_effort,
							onChange: (v) => field("default_effort", v),
							options: [
								{ value: "off" },
								{ value: "high" },
								{ value: "max" }
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: S.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: S.fieldLabel,
							children: copy.tierPolicy
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CustomSelect, {
							value: config.tier_policy,
							onChange: (v) => field("tier_policy", v),
							options: [
								"auto",
								"flash-only",
								"pro-only"
							].map((p) => ({
								value: p,
								label: copy.tierPolicyDesc[p]
							}))
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: {
							...S.field,
							flexDirection: "row",
							alignItems: "center",
							gap: 6,
							paddingBottom: 5
						},
						title: copy.escalateHint,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: !!config.escalate_on_failure,
							onChange: (e) => field("escalate_on_failure", e.target.checked)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { fontSize: 12 },
							children: copy.escalate
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: S.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: S.fieldLabel,
							children: copy.presetFlash
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CustomSelect, {
							value: config.preset_flash ?? "default",
							onChange: (v) => field("preset_flash", v),
							options: presetOptions
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: S.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: S.fieldLabel,
							children: copy.presetPro
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CustomSelect, {
							value: config.preset_pro ?? "default",
							onChange: (v) => field("preset_pro", v),
							options: presetOptions
						})]
					})
				] })),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: S.group,
					children: copy.groupRuntime
				}),
				block(copy.cardRuntime, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: S.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: S.fieldLabel,
							children: copy.mode
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CustomSelect, {
							value: config.mode,
							onChange: (v) => field("mode", v),
							options: [
								"auto",
								"hub",
								"standalone"
							].map((m) => ({
								value: m,
								label: copy.modeDesc[m]
							}))
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: S.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: S.fieldLabel,
							children: copy.timeout
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: {
								...S.input,
								width: "100%",
								boxSizing: "border-box"
							},
							type: "number",
							min: 60,
							max: 7200,
							value: config.default_timeout_seconds,
							onChange: (e) => fieldLocal("default_timeout_seconds", Number(e.target.value)),
							onBlur: () => applyPatch({ default_timeout_seconds: config.default_timeout_seconds })
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: S.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: S.fieldLabel,
							children: copy.hubUrl
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: {
								...S.input,
								width: "100%",
								boxSizing: "border-box"
							},
							value: config.hub_url,
							onChange: (e) => fieldLocal("hub_url", e.target.value),
							onBlur: () => applyPatch({ hub_url: config.hub_url }),
							onKeyDown: (e) => {
								if (e.key === "Enter") e.currentTarget.blur();
							}
						})]
					})
				] })),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: S.group,
					children: copy.groupMultimodal
				}),
				block(copy.cardMM, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: S.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: S.fieldLabel,
							children: copy.visionProvider
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CustomSelect, {
							value: config.vision_provider,
							onChange: (p) => {
								const custom = customProviders.find((c) => c.id === p);
								const m = custom ? custom.models?.[0] ?? "default" : (VISION_MODELS[p] ?? ["default"])[0];
								setModelAdd(null);
								setConfig((c) => ({
									...c,
									vision_provider: p,
									vision_model: m
								}));
								applyPatch({
									vision_provider: p,
									vision_model: m
								});
								if ((p === "grok" || p === "agy") && !dynModels[p]) get(`/vision-models?provider=${p}`).then((r) => {
									if (r.ok) setDynModels((d) => ({
										...d,
										[p]: r.models
									}));
								}).catch(() => {});
							},
							options: visionProviderOptions
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: S.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: S.fieldLabel,
							children: copy.visionModel
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 6,
								alignItems: "center"
							},
							children: [
								modelAdd === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CustomSelect, {
									value: config.vision_model,
									onChange: (v) => field("vision_model", v),
									options: visionModelOptions
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									autoFocus: true,
									style: {
										...S.input,
										width: "100%",
										boxSizing: "border-box",
										...S.mono
									},
									value: modelAdd,
									placeholder: copy.modelPlaceholder,
									onChange: (e) => setModelAdd(e.target.value),
									onBlur: commitModelAdd,
									onKeyDown: (e) => {
										if (e.key === "Enter") e.currentTarget.blur();
										if (e.key === "Escape") setModelAdd(null);
									}
								}),
								modelAdd === null && (config.vision_provider === "grok" || config.vision_provider === "agy") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									title: copy.refreshModels,
									disabled: busy,
									style: {
										...S.btn,
										padding: "3px 8px",
										flexShrink: 0
									},
									onClick: () => {
										const p = config.vision_provider;
										setBusy(true);
										get(`/vision-models?provider=${p}&refresh=1`).then((r) => {
											if (r.ok) setDynModels((d) => ({
												...d,
												[p]: r.models
											}));
										}).catch(() => {}).finally(() => setBusy(false));
									},
									children: "↻"
								}),
								modelAdd === null && config.vision_provider !== "off" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									title: copy.addModelTip,
									style: {
										...S.btn,
										padding: "3px 8px",
										flexShrink: 0
									},
									onClick: () => setModelAdd(""),
									children: "＋"
								}),
								modelAdd === null && (extraModels[config.vision_provider] ?? []).includes(config.vision_model) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									title: copy.removeModelTip,
									style: {
										...S.btn,
										padding: "3px 8px",
										flexShrink: 0
									},
									onClick: removeCurrentModel,
									children: "−"
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: S.field,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: S.fieldLabel,
							children: copy.imagegenProvider
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CustomSelect, {
							value: config.imagegen_provider,
							onChange: (v) => field("imagegen_provider", v),
							options: imagegenProviderOptions
						})]
					})
				] })),
				block(copy.cardCustomProv, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					customProviders.length === 0 && provForm === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 12,
							opacity: .5
						},
						children: copy.noCustomProviders
					}),
					customProviders.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8,
							fontSize: 12.5
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { fontWeight: 500 },
								children: p.name || p.id
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									...S.chip(false),
									opacity: .7
								},
								children: provType(p) === "api" ? "API" : "CLI"
							}),
							canSee(p) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: S.chip(true),
								children: copy.capVision
							}),
							canDraw(p) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: S.chip(true),
								children: copy.capImagegen
							}),
							provType(p) === "api" && !!p.api_key && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									fontSize: 11.5,
									opacity: .5
								},
								children: ["key ", copy.keySet]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: {
									...S.btn,
									padding: "2px 8px"
								},
								title: copy.testTip,
								disabled: !!testResult?.busy,
								onClick: () => runProviderTest(`row:${p.id}`, p),
								children: testResult?.key === `row:${p.id}` && testResult.busy ? copy.testing : copy.testProvider
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: {
									...S.btn,
									padding: "2px 8px"
								},
								onClick: () => setProvForm({
									originalId: p.id,
									name: p.name ?? p.id,
									type: provType(p),
									models: (p.models ?? []).join(", "),
									base_url: p.base_url ?? "",
									api_key: p.api_key ?? "",
									imagegen_model: p.imagegen_model ?? "",
									vision_command: p.vision_command ?? "",
									imagegen_command: p.imagegen_command ?? ""
								}),
								children: copy.edit
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: {
									...S.btn,
									padding: "2px 8px",
									opacity: .75
								},
								onClick: () => {
									if (confirm(copy.confirmDeleteProvider(p.name || p.id))) deleteProvider(p.id);
								},
								children: copy.del
							})
						]
					}, p.id)),
					customProviders.some((p) => testResult?.key === `row:${p.id}`) && testReport(testResult.key),
					provForm === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						style: S.btn,
						onClick: () => setProvForm({
							name: "",
							type: "api",
							models: "",
							base_url: "",
							api_key: "",
							imagegen_model: "",
							vision_command: "",
							imagegen_command: ""
						}),
						children: copy.addProvider
					}) }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							borderTop: "1px solid rgba(128,128,128,0.16)",
							paddingTop: 10,
							display: "flex",
							flexDirection: "column",
							gap: 10
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: S.blockGrid,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: S.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: S.fieldLabel,
										children: copy.providerName
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										autoFocus: true,
										style: {
											...S.input,
											width: "100%",
											boxSizing: "border-box"
										},
										value: provForm.name,
										onChange: (e) => setProvForm({
											...provForm,
											name: e.target.value
										})
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: S.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: S.fieldLabel,
										children: copy.providerType
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CustomSelect, {
										value: provForm.type,
										onChange: (v) => setProvForm({
											...provForm,
											type: v
										}),
										options: [{
											value: "api",
											label: copy.typeApi
										}, {
											value: "cli",
											label: copy.typeCli
										}]
									})]
								})]
							}),
							provForm.type === "api" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: S.blockGrid,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: S.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: S.fieldLabel,
											children: copy.baseUrl
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											style: {
												...S.input,
												width: "100%",
												boxSizing: "border-box",
												...S.mono
											},
											value: provForm.base_url,
											placeholder: "https://api.example.com/v1",
											onChange: (e) => setProvForm({
												...provForm,
												base_url: e.target.value
											})
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: S.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: S.fieldLabel,
											children: copy.apiKey
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "password",
											autoComplete: "off",
											style: {
												...S.input,
												width: "100%",
												boxSizing: "border-box",
												...S.mono
											},
											value: provForm.api_key,
											placeholder: copy.keyPlaceholder,
											onChange: (e) => setProvForm({
												...provForm,
												api_key: e.target.value
											})
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: S.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: S.fieldLabel,
											children: copy.modelsField
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											style: {
												...S.input,
												width: "100%",
												boxSizing: "border-box",
												...S.mono
											},
											value: provForm.models,
											placeholder: "gpt-4o-mini, qwen-vl-max",
											onChange: (e) => setProvForm({
												...provForm,
												models: e.target.value
											})
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: S.field,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: S.fieldLabel,
											children: copy.imagegenModel
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											style: {
												...S.input,
												width: "100%",
												boxSizing: "border-box",
												...S.mono
											},
											value: provForm.imagegen_model,
											placeholder: "dall-e-3",
											onChange: (e) => setProvForm({
												...provForm,
												imagegen_model: e.target.value
											})
										})]
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 11.5,
									opacity: .55
								},
								children: copy.apiFormHint
							})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: S.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: S.fieldLabel,
										children: copy.visionCmd
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: {
											...S.input,
											width: "100%",
											boxSizing: "border-box",
											...S.mono
										},
										value: provForm.vision_command,
										placeholder: "mycli see {image} --ask {question} --model {model}",
										onChange: (e) => setProvForm({
											...provForm,
											vision_command: e.target.value
										})
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: S.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: S.fieldLabel,
										children: copy.imagegenCmd
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: {
											...S.input,
											width: "100%",
											boxSizing: "border-box",
											...S.mono
										},
										value: provForm.imagegen_command,
										placeholder: "mycli gen {prompt} -o {output}",
										onChange: (e) => setProvForm({
											...provForm,
											imagegen_command: e.target.value
										})
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: S.field,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: S.fieldLabel,
										children: copy.modelsField
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										style: {
											...S.input,
											width: "100%",
											boxSizing: "border-box",
											...S.mono
										},
										value: provForm.models,
										placeholder: "model-a, model-b",
										onChange: (e) => setProvForm({
											...provForm,
											models: e.target.value
										})
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 11.5,
										opacity: .55
									},
									children: copy.cliFormHint
								})
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 8,
									alignItems: "center"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: S.btn,
										onClick: saveProviderForm,
										children: copy.saveProvider
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: S.btn,
										title: copy.testTip,
										disabled: !!testResult?.busy,
										onClick: () => runProviderTest("form", {
											id: provForm.originalId ?? "draft",
											name: provForm.name || "draft",
											type: provForm.type,
											models: provForm.models.split(/[,，\n]+/).map((x) => x.trim()).filter(Boolean),
											base_url: provForm.base_url.trim(),
											api_key: provForm.api_key,
											imagegen_model: provForm.imagegen_model.trim(),
											vision_command: provForm.vision_command.trim(),
											imagegen_command: provForm.imagegen_command.trim()
										}),
										children: testResult?.key === "form" && testResult.busy ? copy.testing : copy.testProvider
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										style: {
											...S.btn,
											opacity: .75
										},
										onClick: () => setProvForm(null),
										children: copy.cancel
									})
								]
							}),
							testReport("form")
						]
					})
				] }), false)
			] }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: 11.5,
					opacity: .55,
					marginTop: 2
				},
				children: copy.globalHint
			}),
			notice !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: 12,
					opacity: .8,
					whiteSpace: "pre-wrap"
				},
				children: notice
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: S.section,
				children: copy.jobs
			}),
			jobs.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { opacity: .55 },
				children: copy.empty
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: { overflowX: "auto" },
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
					style: {
						borderCollapse: "collapse",
						width: "100%",
						tableLayout: "fixed",
						minWidth: 760
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("colgroup", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("col", { style: { width: 64 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("col", { style: { width: 58 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("col", { style: { width: 72 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("col", { style: { width: 40 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("col", { style: { width: 100 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("col", { style: { width: 84 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("col", { style: { width: 340 } })
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", { children: [
							copy.col.id,
							copy.col.source,
							copy.col.tier,
							copy.col.status,
							copy.col.progress,
							copy.col.tokens,
							copy.col.task
						].map((h) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
							style: {
								...S.tight,
								fontSize: 11,
								opacity: .55,
								fontWeight: 500
							},
							children: h
						}, h)) }) }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: jobs.map((job) => {
							const color = job.status === "running" ? "#4a9eff" : job.status === "done" ? "#3fb950" : "#f85149";
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									style: {
										...S.tight,
										...S.mono
									},
									title: job.id,
									children: String(job.id).replace(/-[a-z0-9]+$/, "")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									style: S.tight,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: S.chip(job.source === "claude-code" || job.source === "codex"),
										children: sourceLabel(job.source)
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
									style: S.tight,
									children: [
										job.tier,
										"/",
										job.effort
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									style: {
										...S.tight,
										textAlign: "center"
									},
									title: `${job.status}${job.currentTool ? ` · ${job.currentTool}` : ""}`,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											color,
											cursor: "default"
										},
										children: "●"
									})
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
									style: {
										...S.tight,
										...S.mono
									},
									title: copy.progressTip(elapsed(job.startedAt, job.endedAt), job.turn, job.step, job.toolCalls ?? "-"),
									children: [
										elapsed(job.startedAt, job.endedAt),
										" ",
										job.turn,
										".",
										job.step,
										" ",
										job.toolCalls ?? "-",
										"t"
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									style: {
										...S.tight,
										...S.mono
									},
									children: job.tokens ? `${ktok(job.tokens.input)}/${ktok(job.tokens.output)}` : "-"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									style: {
										...S.cell,
										position: "relative"
									},
									onMouseEnter: (e) => {
										const rect = e.currentTarget.getBoundingClientRect();
										setHoverTask({
											id: job.id,
											text: job.task,
											right: Math.max(8, window.innerWidth - rect.right),
											top: rect.bottom + 4,
											bottom: window.innerHeight - rect.top + 4,
											flip: rect.top < 240
										});
									},
									onMouseLeave: () => setHoverTask(null),
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											whiteSpace: "nowrap",
											overflow: "hidden",
											textOverflow: "ellipsis",
											lineHeight: 1.45,
											fontSize: 12.5
										},
										children: job.task
									})
								})
							] }, job.id);
						}) })
					]
				})
			}),
			hoverTask && (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					position: "fixed",
					right: hoverTask.right,
					zIndex: 9999,
					...hoverTask.flip ? { top: hoverTask.top } : { bottom: hoverTask.bottom },
					minWidth: 260,
					maxWidth: 420,
					maxHeight: 180,
					overflowY: "auto",
					padding: "8px 12px",
					borderRadius: 8,
					border: "1px solid rgba(128,128,128,0.35)",
					background: "Canvas",
					color: "CanvasText",
					boxShadow: "0 8px 28px rgba(0,0,0,0.22)",
					whiteSpace: "pre-wrap",
					fontSize: 12,
					lineHeight: 1.5
				},
				children: hoverTask.text
			}), document.body)
		]
	});
}
function apply(ctx) {
	let runningCount = 0;
	ctx.slots.inject("settings.section", () => {
		let dispose = register();
		function register() {
			return ctx.slots.register({
				name: "settings.section",
				id: "dsh-crew",
				order: 65,
				label: () => {
					const base = COPY[ctx.locale.getLocale().active === "zh" ? "zh" : "en"].label;
					if (runningCount <= 0) return base;
					return `${base} ${[
						"❶",
						"❷",
						"❸",
						"❹",
						"❺",
						"❻",
						"❼",
						"❽",
						"❾",
						"❿"
					][runningCount - 1] ?? `(${runningCount})`}`;
				}
			}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkersPanel, { ctx }));
		}
		const poll = async () => {
			if (document.visibilityState !== "visible") return;
			try {
				const r = await (await fetch(`${API}/jobs`, { cache: "no-store" })).json();
				const n = r.ok ? (r.jobs ?? []).filter((j) => j.status === "running").length : 0;
				if (n !== runningCount) {
					runningCount = n;
					dispose();
					dispose = register();
				}
			} catch {}
		};
		poll();
		const timer = setInterval(() => {
			poll();
		}, 1e4);
		return () => {
			clearInterval(timer);
			dispose();
		};
	});
}
//#endregion
exports.apply = apply;
exports.inject = inject;

return module.exports; } });
