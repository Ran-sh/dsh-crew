window.__ModuleLoader__.load({ id: "@ran-sh/dsh-crew-web-bridge", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
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
		openFull: "打开完整设置 →",
		running: "运行中",
		unavailable: "Crew 后端不可用",
		openDiag: "打开诊断",
		crew: "Crew",
		enabled: "启用子 Agent",
		flash: "Flash 模型",
		pro: "Pro 模型",
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
		openFull: "Open full settings →",
		running: "Running",
		unavailable: "Crew backend unavailable",
		openDiag: "Open diagnostics",
		crew: "Crew",
		enabled: "Enable sub-agents",
		flash: "Flash models",
		pro: "Pro models",
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
		modelPlaceholder: "model"
	}
};
function LocalStyles() {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: `
      .crew-quick-card { border: 1px solid rgba(128,128,128,0.24); border-radius: 12px; padding: 14px 15px; font-size: 13px; line-height: 1.55; display: flex; flex-direction: column; gap: 10px; background: linear-gradient(135deg, rgba(74,158,255,0.10), rgba(128,128,128,0.025) 56%); }
      .crew-quick-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .crew-quick-title { font-size: 16px; font-weight: 680; }
      .crew-quick-section { font-weight: 650; opacity: 0.85; }
      .crew-quick-chip { border: 1px solid rgba(128,128,128,0.35); border-radius: 999px; padding: 1px 10px; font-size: 12px; }
      .crew-quick-btn { border: 1px solid rgba(128,128,128,0.4); border-radius: 8px; padding: 2px 10px; cursor: pointer; background: transparent; font-size: 12.5px; }
      .crew-quick-btn.primary { border-color: #4a9eff; color: #4a9eff; font-weight: 650; }
      .crew-quick-input { border: 1px solid rgba(128,128,128,0.35); border-radius: 6px; padding: 2px 8px; font-size: 12.5px; width: 130px; background: transparent; color: inherit; }
      .crew-quick-notice { opacity: 0.75; font-size: 12.5px; }
      .crew-quick-model { display: flex; gap: 6px; align-items: center; font-size: 12.5px; }
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
	const applyRestart = (0, react.useCallback)(async () => {
		setBusy(true);
		setNotice(t.working);
		try {
			const created = await readJson(await fetch(`${API}/runtime/restart-request`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					confirm: true,
					reason: "quick panel restart"
				})
			}));
			if (!created.ok) throw new Error(created.code ?? created.error ?? "restart failed");
			const requestId = created.request_id;
			const deadline = Date.now() + 9e4;
			for (;;) {
				await new Promise((r) => setTimeout(r, 1e3));
				if (Date.now() > deadline) throw new Error("restart timed out");
				const status = await readJson(await fetch(`${API}/runtime/restart-status?id=${encodeURIComponent(requestId)}`, { cache: "no-store" }));
				if (!status.ok) continue;
				if (status.state === "VERIFIED") {
					setRestartPending(false);
					setNotice(t.saved);
					return;
				}
				if (status.state !== "RESTART_REQUESTED") throw new Error(status.state ?? "restart failed");
			}
		} catch (e) {
			setNotice(String(e?.message ?? e));
		} finally {
			setBusy(false);
		}
	}, [t]);
	const modelList = (listKey, label) => {
		const list = config?.[listKey] ?? [];
		const draft = drafts[listKey] ?? {
			provider: "",
			model: ""
		};
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "flex",
				flexDirection: "column",
				gap: 4
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "crew-quick-section",
					children: label
				}),
				list.map((entry, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "crew-quick-model",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							i + 1,
							". ",
							entry.provider,
							" / ",
							entry.model
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "crew-quick-btn",
							disabled: busy || i === 0,
							onClick: () => moveModel(listKey, i, -1),
							children: "↑"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "crew-quick-btn",
							disabled: busy || i === list.length - 1,
							onClick: () => moveModel(listKey, i, 1),
							children: "↓"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: "crew-quick-btn",
							disabled: busy,
							onClick: () => removeModel(listKey, i),
							children: "×"
						})
					]
				}, `${entry.provider}/${entry.model}/${i}`)),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "crew-quick-row",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "crew-quick-input",
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
							className: "crew-quick-btn",
							disabled: busy,
							onClick: () => addModel(listKey),
							children: t.addModel
						})
					]
				})
			]
		});
	};
	if (ready === false) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "crew-quick-card",
		children: [
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
					href: FULL,
					target: "_blank",
					rel: "noreferrer",
					children: t.openDiag
				})
			})
		]
	});
	if (config === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "crew-quick-card",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LocalStyles, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "crew-quick-notice",
			children: t.working
		})]
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "crew-quick-card",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(LocalStyles, {}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "crew-quick-row",
				style: { justifyContent: "space-between" },
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "crew-quick-title",
						children: t.title
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "crew-quick-chip",
						children: [t.running, " · 3210"]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
						href: FULL,
						target: "_blank",
						rel: "noreferrer",
						children: t.openFull
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "crew-quick-row",
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
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 4
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "crew-quick-section",
						children: t.multimodal
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "crew-quick-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									disabled: busy,
									checked: config.vision_enabled === true,
									onChange: (e) => toggle("vision_enabled", e.target.checked)
								}),
								" ",
								t.vision
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t.provider }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: "crew-quick-input",
								disabled: busy,
								defaultValue: config.vision_provider ?? "",
								onBlur: (e) => setProvider("vision_provider", e.target.value)
							}, `vision-${config.vision_provider ?? ""}`)
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "crew-quick-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									disabled: busy,
									checked: config.imagegen_enabled === true,
									onChange: (e) => toggle("imagegen_enabled", e.target.checked)
								}),
								" ",
								t.imagegen
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t.provider }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: "crew-quick-input",
								disabled: busy,
								defaultValue: config.imagegen_provider ?? "",
								onBlur: (e) => setProvider("imagegen_provider", e.target.value)
							})
						]
					})
				]
			}),
			restartPending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "crew-quick-row",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					className: "crew-quick-btn primary",
					disabled: busy,
					onClick: () => void applyRestart(),
					children: t.applyRestart
				})
			}),
			notice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "crew-quick-notice",
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
