window.__ModuleLoader__.load({ id: "@ran-sh/dsh-crew-web-bridge", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const require_panel_chrome = require("./panel-chrome-CLeO7gqz.cjs");
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/client/quick-panel.tsx
const API = "/_dsh/dsh-crew";
const FULL = "http://127.0.0.1:3210/";
const RESTART_KEYS = /* @__PURE__ */ new Set([
	"vision_enabled",
	"imagegen_enabled",
	"vision_provider",
	"imagegen_provider"
]);
const T = {
	zh: {
		title: "DSH Crew 快捷控制",
		openFull: "打开 3210 后台 →",
		running: "后台已连接",
		surface: "3080 / 日常控制",
		description: "常用开关与模型顺序在这里调整，更多设置进入后台。",
		priorityHint: "从上到下按优先级排列；从列表移除不会删除 Provider。",
		empty: "未配置优先模型，按现有后备策略选择。",
		models: (n) => `${n} 个模型`,
		moveUp: "上移",
		moveDown: "下移",
		remove: "从优先级移除",
		unavailable: "Crew 后端不可用",
		openDiag: "打开诊断",
		crew: "Crew",
		enabled: "启用子 Agent",
		flash: "Worker / Flash",
		pro: "Reviewer / Pro",
		addModel: "+ 添加模型",
		multimodal: "多模态",
		vision: "视觉",
		imagegen: "生图",
		provider: "Provider",
		applyRestart: "应用并重启 Crew",
		savedNeedsRestart: "配置已保存 · 需要重启 Crew 才会生效",
		saved: "已保存",
		working: "处理中…",
		providerPlaceholder: "provider",
		modelPlaceholder: "model"
	},
	en: {
		title: "DSH Crew Quick Controls",
		openFull: "Open Crew backend (3210) →",
		running: "Backend connected",
		surface: "3080 / DAILY CONTROLS",
		description: "Manage everyday switches and model order here. Open the backend for advanced settings.",
		priorityHint: "Ordered by priority. Removing a model here does not delete its provider.",
		empty: "No priority models. The existing fallback policy applies.",
		models: (n) => `${n} models`,
		moveUp: "Move up",
		moveDown: "Move down",
		remove: "Remove from priority",
		unavailable: "Crew backend unavailable",
		openDiag: "Open diagnostics",
		crew: "Crew",
		enabled: "Enable sub-agents",
		flash: "Worker / Flash",
		pro: "Reviewer / Pro",
		addModel: "+ Add model",
		multimodal: "Multimodal",
		vision: "Vision",
		imagegen: "Imagegen",
		provider: "Provider",
		applyRestart: "Apply & restart Crew",
		savedNeedsRestart: "Saved · restart Crew to take effect",
		saved: "Saved",
		working: "Working…",
		providerPlaceholder: "provider",
		modelPlaceholder: "Model"
	}
};
function LocalStyles() {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: `
      .dsh-crew-ui.crew-quick-card { display: flex; flex-direction: column; gap: 12px; }
      .crew-quick-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .crew-quick-title { font-size: 16px; font-weight: 680; }
      .crew-quick-section { font-weight: 650; opacity: 0.85; }
      .crew-quick-chip { border: 1px solid rgba(128,128,128,0.35); border-radius: 999px; padding: 1px 10px; font-size: 12px; }
      .crew-quick-card .crew-quick-btn { border: 1px solid var(--crew-line); border-radius: 7px; min-height: 30px; padding: 3px 9px; cursor: pointer; background: transparent; color: inherit; font-size: 12px; }
      .crew-quick-btn.primary { border-color: #4a9eff; color: #4a9eff; font-weight: 650; }
      .crew-quick-card .crew-quick-input { border: 1px solid var(--crew-line); border-radius: 6px; padding: 6px 9px; font-size: 12px; min-width: 0; width: 100%; background: transparent; color: inherit; }
      .crew-quick-notice { opacity: 0.75; font-size: 12.5px; }
      .crew-quick-card .crew-quick-master { padding: 11px 14px; border: 1px solid var(--crew-line); border-radius: 10px; justify-content: space-between; }
      .crew-quick-card input[type=checkbox] { accent-color: var(--crew-accent); width: 15px; height: 15px; }
      .crew-quick-card label { display: inline-flex; gap: 7px; align-items: center; }
      .crew-quick-card .crew-quick-group { border: 1px solid var(--crew-line); border-radius: 10px; overflow: hidden; }
      .crew-quick-card .crew-quick-group > summary { cursor: pointer; padding: 12px 14px; }
      .crew-quick-card .crew-quick-count { margin-left: 10px; font-size: 11px; opacity: .65; font-weight: 400; }
      .crew-quick-card .crew-quick-content { padding: 0 14px 14px; }
      .crew-quick-card .crew-quick-list { padding: 0; margin: 10px 0; list-style: none; }
      .crew-quick-card .crew-quick-model { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; gap: 9px; align-items: center; border-top: 1px solid var(--crew-line); padding: 10px 0; }
      .crew-quick-card .crew-quick-rank { opacity: .5; font-size: 11px; font-variant-numeric: tabular-nums; }
      .crew-quick-card .crew-quick-model-name { font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; }
      .crew-quick-card .crew-quick-provider { font-size: 11px; opacity: .65; overflow-wrap: anywhere; }
      .crew-quick-card .crew-quick-actions { display: flex; gap: 4px; }
      .crew-quick-card .crew-quick-add > summary { color: var(--crew-accent); cursor: pointer; font-size: 12px; padding: 4px 0; }
      .crew-quick-card .crew-quick-form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 7px; margin-top: 9px; }
      .crew-quick-card .crew-quick-media { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 10px; align-items: center; margin-top: 10px; }
      @media (max-width: 640px) { .crew-quick-card .crew-quick-form { grid-template-columns: minmax(0, 1fr); } .crew-quick-card .crew-quick-model { grid-template-columns: 18px minmax(0, 1fr); } .crew-quick-card .crew-quick-actions { grid-column: 2; justify-content: flex-end; } }
    ` });
}
async function readJson(res) {
	if (!res.ok) return {
		ok: false,
		status: res.status
	};
	try {
		return await res.json();
	} catch {
		return { ok: false };
	}
}
function QuickPanel({ ctx }) {
	const locale = ctx?.locale?.getLocale?.().active === "zh" ? "zh" : "en";
	const t = T[locale] ?? T.zh;
	const [config, setConfig] = (0, react.useState)(null);
	const [ready, setReady] = (0, react.useState)(null);
	const [notice, setNotice] = (0, react.useState)("");
	const [busy, setBusy] = (0, react.useState)(false);
	const [restartPending, setRestartPending] = (0, react.useState)(false);
	const [drafts, setDrafts] = (0, react.useState)({});
	const load = (0, react.useCallback)(async () => {
		try {
			const status = await readJson(await fetch(`${API}/quick-status`, { cache: "no-store" }));
			if (!status.ok) {
				setReady(false);
				return;
			}
			setReady(true);
			setConfig(status.config ?? {});
		} catch {
			setReady(false);
		}
	}, []);
	(0, react.useEffect)(() => {
		load();
	}, [load]);
	const patch = (0, react.useCallback)(async (next) => {
		setBusy(true);
		setNotice(t.working);
		try {
			const res = await readJson(await fetch(`${API}/quick-config`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(next)
			}));
			if (!res.ok) throw new Error(res.code ?? res.error ?? "save failed");
			setConfig(res.config ?? {});
			if (Object.keys(next).some((k) => RESTART_KEYS.has(k))) {
				setRestartPending(true);
				setNotice(t.savedNeedsRestart);
			} else {
				setNotice(t.saved);
				setTimeout(() => setNotice(""), 1500);
			}
			return true;
		} catch (e) {
			setNotice(String(e?.message ?? e));
			return false;
		} finally {
			setBusy(false);
		}
	}, [t]);
	const toggle = (key, value) => {
		setConfig((c) => ({
			...c ?? {},
			[key]: value
		}));
		patch({ [key]: value });
	};
	const setProvider = (key, value) => {
		setConfig((c) => ({
			...c ?? {},
			[key]: value
		}));
		patch({ [key]: value });
	};
	const moveModel = (listKey, index, dir) => {
		const list = [...config?.[listKey] ?? []];
		const to = index + dir;
		if (to < 0 || to >= list.length) return;
		[list[index], list[to]] = [list[to], list[index]];
		setConfig((c) => ({
			...c ?? {},
			[listKey]: list
		}));
		patch({ [listKey]: list });
	};
	const removeModel = (listKey, index) => {
		const list = [...config?.[listKey] ?? []];
		list.splice(index, 1);
		setConfig((c) => ({
			...c ?? {},
			[listKey]: list
		}));
		patch({ [listKey]: list });
	};
	const addModel = (listKey) => {
		const draft = drafts[listKey] ?? {
			provider: "",
			model: ""
		};
		if (!draft.provider.trim() || !draft.model.trim()) return;
		const list = [...config?.[listKey] ?? [], {
			provider: draft.provider.trim(),
			model: draft.model.trim()
		}];
		setConfig((c) => ({
			...c ?? {},
			[listKey]: list
		}));
		setDrafts((d) => ({
			...d,
			[listKey]: {
				provider: "",
				model: ""
			}
		}));
		patch({ [listKey]: list });
	};
	const modelList = (listKey, label) => {
		const list = config?.[listKey] ?? [];
		const draft = drafts[listKey] ?? {
			provider: "",
			model: ""
		};
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
			className: "crew-quick-group",
			open: listKey === "flash_model_priority",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "crew-quick-count",
				children: t.models(list.length)
			})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "crew-quick-content",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "crew-quick-notice",
						children: t.priorityHint
					}),
					list.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "crew-quick-notice",
						children: t.empty
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
						className: "crew-quick-list",
						"aria-label": label,
						children: list.map((entry, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
							className: "crew-quick-model",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "crew-quick-rank",
									"aria-hidden": "true",
									children: [i + 1, "."]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "crew-quick-model-name",
									children: entry.model
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "crew-quick-provider",
									children: entry.provider
								})] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "crew-quick-actions",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "crew-quick-btn",
											"aria-label": `${t.moveUp} ${entry.model}`,
											title: t.moveUp,
											disabled: busy || i === 0,
											onClick: () => moveModel(listKey, i, -1),
											children: "↑"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "crew-quick-btn",
											"aria-label": `${t.moveDown} ${entry.model}`,
											title: t.moveDown,
											disabled: busy || i === list.length - 1,
											onClick: () => moveModel(listKey, i, 1),
											children: "↓"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "crew-quick-btn",
											"aria-label": `${t.remove} ${entry.model}`,
											title: t.remove,
											disabled: busy,
											onClick: () => removeModel(listKey, i),
											children: "×"
										})
									]
								})
							]
						}, `${entry.provider}/${entry.model}/${i}`))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						className: "crew-quick-add",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t.addModel }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "crew-quick-form",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "crew-quick-input",
									"aria-label": `${label} Provider`,
									placeholder: t.providerPlaceholder,
									disabled: busy,
									value: draft.provider,
									onChange: (e) => setDrafts((d) => ({
										...d,
										[listKey]: {
											...draft,
											provider: e.target.value
										}
									}))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: "crew-quick-input",
									"aria-label": `${label} ${locale === "zh" ? "模型" : "Model"}`,
									placeholder: t.modelPlaceholder,
									disabled: busy,
									value: draft.model,
									onChange: (e) => setDrafts((d) => ({
										...d,
										[listKey]: {
											...draft,
											model: e.target.value
										}
									}))
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "crew-quick-btn",
									disabled: busy || !draft.provider.trim() || !draft.model.trim(),
									onClick: () => addModel(listKey),
									children: t.addModel
								})
							]
						})]
					})
				]
			})]
		});
	};
	if (ready === false) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-crew-ui crew-quick-card",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(require_panel_chrome.PanelStyles, {}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LocalStyles, {}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "crew-quick-title",
				children: t.title
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "crew-quick-notice",
				children: t.unavailable
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "crew-quick-row",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
					className: "crew-nav-link",
					href: FULL,
					target: "_blank",
					rel: "noopener noreferrer",
					children: t.openDiag
				})
			})
		]
	});
	if (config === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-crew-ui crew-quick-card",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(require_panel_chrome.PanelStyles, {}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LocalStyles, {}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "crew-quick-notice",
				role: "status",
				children: t.working
			})
		]
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-crew-ui crew-quick-card",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(require_panel_chrome.PanelStyles, {}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LocalStyles, {}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(require_panel_chrome.PanelHeader, {
				title: t.title,
				eyebrow: t.surface,
				description: t.description,
				href: FULL,
				linkText: t.openFull,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "crew-quick-chip",
					children: [t.running, " · 3210"]
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "crew-quick-row crew-quick-master",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "crew-quick-section",
					children: t.crew
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "checkbox",
						disabled: busy,
						checked: config.subagents_enabled !== false,
						onChange: (e) => toggle("subagents_enabled", e.target.checked)
					}),
					" ",
					t.enabled
				] })]
			}),
			modelList("flash_model_priority", t.flash),
			modelList("pro_model_priority", t.pro),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
				className: "crew-quick-group",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t.multimodal }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "crew-quick-count",
					children: [
						t.vision,
						" / ",
						t.imagegen
					]
				})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "crew-quick-content",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "crew-quick-media",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								disabled: busy,
								checked: config.vision_enabled === true,
								onChange: (e) => toggle("vision_enabled", e.target.checked)
							}),
							" ",
							t.vision
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "crew-quick-input",
							"aria-label": `${t.vision} Provider`,
							placeholder: t.provider,
							disabled: busy,
							defaultValue: config.vision_provider ?? "",
							onBlur: (e) => setProvider("vision_provider", e.target.value)
						}, `vision-${config.vision_provider ?? ""}`)]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "crew-quick-media",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								disabled: busy,
								checked: config.imagegen_enabled === true,
								onChange: (e) => toggle("imagegen_enabled", e.target.checked)
							}),
							" ",
							t.imagegen
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "crew-quick-input",
							"aria-label": `${t.imagegen} Provider`,
							placeholder: t.provider,
							disabled: busy,
							defaultValue: config.imagegen_provider ?? "",
							onBlur: (e) => setProvider("imagegen_provider", e.target.value)
						})]
					})]
				})]
			}),
			restartPending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "crew-quick-row",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
					className: "crew-quick-btn primary",
					href: FULL,
					target: "_blank",
					rel: "noopener noreferrer",
					children: t.openFull
				})
			}),
			notice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "crew-quick-notice",
				role: "status",
				"aria-live": "polite",
				children: notice
			})
		]
	});
}
function applyQuick(ctx) {
	ctx.slots.inject("settings.section", () => {
		return ctx.slots.register({
			name: "settings.section",
			id: "dsh-crew-quick",
			order: 65,
			label: () => "DSH Crew"
		}, () => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuickPanel, { ctx }));
	});
}
//#endregion
//#region src/client/quick-entry.tsx
const inject = ["slots", "locale"];
function apply(ctx) {
	applyQuick(ctx);
}
//#endregion
exports.apply = apply;
exports.inject = inject;

return module.exports; } });
