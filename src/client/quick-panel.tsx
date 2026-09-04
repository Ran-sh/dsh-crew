import { useCallback, useEffect, useState } from 'react';

// DSH Crew QUICK CONTROLS panel for the official 3080 surface.
//
// Narrow by design: only the user-facing master switch, flash/pro model
// priority lists and vision/imagegen toggles — all other operations belong
// to the native 3210 full control plane. Talks only to the quick endpoints
// (/_dsh/dsh-crew/quick-config, /quick-status, /runtime/restart-request,
// /runtime/restart-status). NEVER writes to any other surface.

const API = '/_dsh/dsh-crew';
const CREW_CONTROL_PLANE_URL = 'http://127.0.0.1:3210/';
const FULL = 'http://127.0.0.1:3210/';

type ModelEntry = { provider: string; model: string };
type QuickConfig = {
  subagents_enabled?: boolean;
  flash_model_priority?: ModelEntry[];
  pro_model_priority?: ModelEntry[];
  vision_enabled?: boolean;
  imagegen_enabled?: boolean;
  vision_provider?: string;
  imagegen_provider?: string;
};

const RESTART_KEYS = new Set([
  'vision_enabled',
  'imagegen_enabled',
  'vision_provider',
  'imagegen_provider',
]);

const T = {
  zh: {
    title: 'DSH Crew 快捷控制',
    openFull: '打开完整设置 →',
    running: '运行中',
    unavailable: 'Crew 后端不可用',
    openDiag: '打开诊断',
    crew: 'Crew',
    enabled: '启用子 Agent',
    flash: 'Flash 模型',
    pro: 'Pro 模型',
    addModel: '+ 添加模型',
    multimodal: '多模态',
    vision: '视觉',
    imagegen: '生图',
    provider: 'Provider',
    applyRestart: '应用并重启 Crew',
    savedNeedsRestart: '配置已保存 · 需要重启 Crew 才会生效',
    saved: '已保存',
    working: '处理中…',
    providerPlaceholder: 'provider',
    modelPlaceholder: 'model',
  },
  en: {
    title: 'DSH Crew Quick Controls',
    openFull: 'Open full settings →',
    running: 'Running',
    unavailable: 'Crew backend unavailable',
    openDiag: 'Open diagnostics',
    crew: 'Crew',
    enabled: 'Enable sub-agents',
    flash: 'Flash models',
    pro: 'Pro models',
    addModel: '+ Add model',
    multimodal: 'Multimodal',
    vision: 'Vision',
    imagegen: 'Imagegen',
    provider: 'Provider',
    applyRestart: 'Apply & restart Crew',
    savedNeedsRestart: 'Saved · restart Crew to take effect',
    saved: 'Saved',
    working: 'Working…',
    providerPlaceholder: 'provider',
    modelPlaceholder: 'model',
  },
};

function LocalStyles() {
  return (
    <style>{`
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
    `}</style>
  );
}

async function readJson(res: Response) {
  if (!res.ok) return { ok: false, status: res.status };
  try { return await res.json(); } catch { return { ok: false }; }
}

export function QuickPanel({ ctx }: { ctx: any }) {
  const locale = ctx?.locale?.getLocale?.().active === 'zh' ? 'zh' : 'en';
  const t = (T as any)[locale] ?? T.zh;
  const [config, setConfig] = useState<QuickConfig | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, ModelEntry>>({});

  const load = useCallback(async () => {
    try {
      const status = await readJson(await fetch(`${API}/quick-status`, { cache: 'no-store' }));
      if (!status.ok) { setReady(false); return; }
      setReady(true);
      setConfig(status.config ?? {});
    } catch { setReady(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const patch = useCallback(async (next: QuickConfig) => {
    setBusy(true); setNotice(t.working);
    try {
      const res = await readJson(await fetch(`${API}/quick-config`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      }));
      if (!res.ok) throw new Error(res.code ?? res.error ?? 'save failed');
      setConfig(res.config ?? {});
      const needsRestart = Object.keys(next).some((k) => RESTART_KEYS.has(k));
      if (needsRestart) { setRestartPending(true); setNotice(t.savedNeedsRestart); }
      else { setNotice(t.saved); setTimeout(() => setNotice(''), 1500); }
      return true;
    } catch (e: any) {
      setNotice(String(e?.message ?? e));
      return false;
    } finally { setBusy(false); }
  }, [t]);

  const toggle = (key: 'subagents_enabled' | 'vision_enabled' | 'imagegen_enabled', value: boolean) => {
    setConfig((c) => ({ ...(c ?? {}), [key]: value }));
    void patch({ [key]: value } as QuickConfig);
  };

  const setProvider = (key: 'vision_provider' | 'imagegen_provider', value: string) => {
    setConfig((c) => ({ ...(c ?? {}), [key]: value }));
    void patch({ [key]: value } as QuickConfig);
  };

  const moveModel = (listKey: 'flash_model_priority' | 'pro_model_priority', index: number, dir: -1 | 1) => {
    const list = [...((config?.[listKey] as ModelEntry[] | undefined) ?? [])];
    const to = index + dir;
    if (to < 0 || to >= list.length) return;
    [list[index], list[to]] = [list[to], list[index]];
    setConfig((c) => ({ ...(c ?? {}), [listKey]: list }));
    void patch({ [listKey]: list } as unknown as QuickConfig);
  };

  const removeModel = (listKey: 'flash_model_priority' | 'pro_model_priority', index: number) => {
    const list = [...((config?.[listKey] as ModelEntry[] | undefined) ?? [])];
    list.splice(index, 1);
    setConfig((c) => ({ ...(c ?? {}), [listKey]: list }));
    void patch({ [listKey]: list } as unknown as QuickConfig);
  };

  const addModel = (listKey: 'flash_model_priority' | 'pro_model_priority') => {
    const draft = drafts[listKey] ?? { provider: '', model: '' };
    if (!draft.provider.trim() || !draft.model.trim()) return;
    const list = [...((config?.[listKey] as ModelEntry[] | undefined) ?? []), { provider: draft.provider.trim(), model: draft.model.trim() }];
    setConfig((c) => ({ ...(c ?? {}), [listKey]: list }));
    setDrafts((d) => ({ ...d, [listKey]: { provider: '', model: '' } }));
    void patch({ [listKey]: list } as unknown as QuickConfig);
  };

  const applyRestart = useCallback(async () => {
    setBusy(true); setNotice(t.working);
    try {
      const created = await readJson(await fetch(`${API}/runtime/restart-request`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, reason: 'quick panel restart' }),
      }));
      if (!created.ok) throw new Error(created.code ?? created.error ?? 'restart failed');
      const requestId = created.request_id;
      const deadline = Date.now() + 90_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        if (Date.now() > deadline) throw new Error('restart timed out');
        const status = await readJson(await fetch(`${API}/runtime/restart-status?id=${encodeURIComponent(requestId)}`, { cache: 'no-store' }));
        if (!status.ok) continue;
        if (status.state === 'VERIFIED') { setRestartPending(false); setNotice(t.saved); return; }
        if (status.state !== 'RESTART_REQUESTED') throw new Error(status.state ?? 'restart failed');
      }
    } catch (e: any) {
      setNotice(String(e?.message ?? e));
    } finally { setBusy(false); }
  }, [t]);

  const modelList = (listKey: 'flash_model_priority' | 'pro_model_priority', label: string) => {
    const list: ModelEntry[] = (config?.[listKey] as ModelEntry[] | undefined) ?? [];
    const draft = drafts[listKey] ?? { provider: '', model: '' };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="crew-quick-section">{label}</div>
        {list.map((entry, i) => (
          <div key={`${entry.provider}/${entry.model}/${i}`} className="crew-quick-model">
            <span>{i + 1}. {entry.provider} / {entry.model}</span>
            <button className="crew-quick-btn" disabled={busy || i === 0} onClick={() => moveModel(listKey, i, -1)}>↑</button>
            <button className="crew-quick-btn" disabled={busy || i === list.length - 1} onClick={() => moveModel(listKey, i, 1)}>↓</button>
            <button className="crew-quick-btn" disabled={busy} onClick={() => removeModel(listKey, i)}>×</button>
          </div>
        ))}
        <div className="crew-quick-row">
          <input className="crew-quick-input" placeholder={t.providerPlaceholder} disabled={busy}
            value={draft.provider} onChange={(e) => setDrafts((d) => ({ ...d, [listKey]: { ...draft, provider: e.target.value } }))} />
          <input className="crew-quick-input" placeholder={t.modelPlaceholder} disabled={busy}
            value={draft.model} onChange={(e) => setDrafts((d) => ({ ...d, [listKey]: { ...draft, model: e.target.value } }))} />
          <button className="crew-quick-btn" disabled={busy} onClick={() => addModel(listKey)}>{t.addModel}</button>
        </div>
      </div>
    );
  };

  if (ready === false) {
    return (
      <div className="crew-quick-card">
        <LocalStyles />
        <div className="crew-quick-title">{t.title}</div>
        <div className="crew-quick-notice">{t.unavailable}</div>
        <div className="crew-quick-row">
          <a href={FULL} target="_blank" rel="noreferrer">{t.openDiag}</a>
        </div>
      </div>
    );
  }
  if (config === null) {
    return (<div className="crew-quick-card"><LocalStyles /><div className="crew-quick-notice">{t.working}</div></div>);
  }

  return (
    <div className="crew-quick-card">
      <LocalStyles />
      <div className="crew-quick-row" style={{ justifyContent: 'space-between' }}>
        <span className="crew-quick-title">{t.title}</span>
        <span className="crew-quick-chip">{t.running} · 3210</span>
        <a href={FULL} target="_blank" rel="noreferrer">{t.openFull}</a>
      </div>
      <div className="crew-quick-row">
        <span className="crew-quick-section">{t.crew}</span>
        <label><input type="checkbox" disabled={busy} checked={config.subagents_enabled !== false}
          onChange={(e) => toggle('subagents_enabled', e.target.checked)} /> {t.enabled}</label>
      </div>
      {modelList('flash_model_priority', t.flash)}
      {modelList('pro_model_priority', t.pro)}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="crew-quick-section">{t.multimodal}</div>
        <div className="crew-quick-row">
          <label><input type="checkbox" disabled={busy} checked={config.vision_enabled === true}
            onChange={(e) => toggle('vision_enabled', e.target.checked)} /> {t.vision}</label>
          <span>{t.provider}</span>
          <input className="crew-quick-input" disabled={busy} defaultValue={config.vision_provider ?? ''} key={`vision-${config.vision_provider ?? ''}`}
            onBlur={(e) => setProvider('vision_provider', e.target.value)} />
        </div>
        <div className="crew-quick-row">
          <label><input type="checkbox" disabled={busy} checked={config.imagegen_enabled === true}
            onChange={(e) => toggle('imagegen_enabled', e.target.checked)} /> {t.imagegen}</label>
          <span>{t.provider}</span>
          <input className="crew-quick-input" disabled={busy} defaultValue={config.imagegen_provider ?? ''}
            onBlur={(e) => setProvider('imagegen_provider', e.target.value)} />
        </div>
      </div>
      {restartPending && (
        <div className="crew-quick-row">
          <button className="crew-quick-btn primary" disabled={busy} onClick={() => void applyRestart()}>{t.applyRestart}</button>
        </div>
      )}
      {notice && <div className="crew-quick-notice">{notice}</div>}
    </div>
  );
}

export function applyQuick(ctx: any): void {
  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-crew-quick',
        order: 65,
        label: () => 'DSH Crew',
      },
      () => <QuickPanel ctx={ctx} />,
    );
  });
}
