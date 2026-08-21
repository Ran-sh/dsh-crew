import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { apply as applyCrew, inject as crewInject } from './index';
import { ActivationSummary } from './activation-summary';

export const inject = crewInject;
const API = '/_dsh/dsh-crew';

type AdaptiveConfig = {
  enabled: boolean;
  window_size: number;
  min_samples: number;
};

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

function useLocale(ctx: any) {
  return useSyncExternalStore(
    (notify: () => void) => ctx.on('locale/change', notify),
    () => ctx.locale.getLocale().active,
    () => ctx.locale.getLocale().active,
  );
}

function AdaptiveRoutingPanel({ ctx }: { ctx: any }) {
  const locale = useLocale(ctx);
  const zh = locale === 'zh';
  const [adaptive, setAdaptive] = useState<AdaptiveConfig>(DEFAULT_ADAPTIVE);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const copy = zh ? {
    title: '自适应模型路由（实验）',
    hint: '默认关闭。仅对系统自动产生的候选做健康排序；显式 Provider / Model 优先级永远保持原序。信号只来自本进程内 Crew 已观察到的成功、失败、超时与粗粒度延迟，不读取额度、价格或凭据。重启 Hub 会清空健康历史。',
    enabled: '启用自适应路由',
    window: '健康窗口',
    minSamples: '最少样本',
    windowHint: '每个 role/provider/model 最多参考最近 1–32 次结果。',
    minHint: '达到该样本数后才允许健康分数影响自动候选顺序。',
    boundary: '生效边界：下一工作流',
    saved: '已保存',
    loading: '加载中…',
  } : {
    title: 'Adaptive Model Routing (experimental)',
    hint: 'Off by default. Health ordering applies only to automatically derived candidates; explicit Provider / Model priorities always keep their order. Signals are limited to Crew-observed success, failure, timeout, and coarse latency in this process—never quota, pricing, or credentials. Restarting the Hub clears the history.',
    enabled: 'Enable adaptive routing',
    window: 'Health window',
    minSamples: 'Minimum samples',
    windowHint: 'Use at most the most recent 1–32 outcomes per role/provider/model.',
    minHint: 'Health may affect automatic candidate order only after this many samples.',
    boundary: 'Activation boundary: next workflow',
    saved: 'Saved',
    loading: 'Loading…',
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const lang = zh ? 'zh' : 'en';
        const res = await fetch(`${API}/config?lang=${lang}`, { cache: 'no-store' });
        const body = await res.json();
        if (!res.ok || body?.ok === false) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setAdaptive(normalizeAdaptive(body?.config?.worker?.model_policy?.adaptive));
          setMessage('');
          setLoaded(true);
        }
      } catch (err: any) {
        if (!cancelled) {
          setMessage(err?.message ?? String(err));
          setLoaded(true);
        }
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [zh]);

  const save = async (candidate: AdaptiveConfig) => {
    const next = normalizeAdaptive(candidate);
    setAdaptive(next);
    setSaving(true);
    try {
      const lang = zh ? 'zh' : 'en';
      const res = await fetch(`${API}/config?lang=${lang}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ worker: { model_policy: { adaptive: next } } }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setAdaptive(normalizeAdaptive(body?.config?.worker?.model_policy?.adaptive));
      setMessage(copy.saved);
      setTimeout(() => setMessage(''), 1500);
    } catch (err: any) {
      setMessage(err?.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return <div style={{ fontSize: 12, opacity: 0.6 }}>{copy.loading}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, lineHeight: 1.55 }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{copy.title}</div>
        <div style={{ opacity: 0.68, fontSize: 12, marginTop: 2 }}>{copy.hint}</div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <input
          type="checkbox"
          checked={adaptive.enabled}
          disabled={saving}
          onChange={(event) => { void save({ ...adaptive, enabled: event.target.checked }); }}
        />
        <span>{copy.enabled}</span>
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>{copy.window}</span>
          <input
            type="number"
            min={1}
            max={32}
            value={adaptive.window_size}
            disabled={saving}
            onChange={(event) => {
              const windowSize = clampInt(event.target.value, adaptive.window_size, 1, 32);
              setAdaptive((current) => ({
                ...current,
                window_size: windowSize,
                min_samples: Math.min(current.min_samples, windowSize),
              }));
            }}
            onBlur={() => { void save(adaptive); }}
            style={{ padding: '5px 7px', borderRadius: 5, border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit' }}
          />
          <span style={{ fontSize: 10.5, opacity: 0.55 }}>{copy.windowHint}</span>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>{copy.minSamples}</span>
          <input
            type="number"
            min={1}
            max={adaptive.window_size}
            value={adaptive.min_samples}
            disabled={saving}
            onChange={(event) => setAdaptive((current) => ({
              ...current,
              min_samples: clampInt(event.target.value, current.min_samples, 1, current.window_size),
            }))}
            onBlur={() => { void save(adaptive); }}
            style={{ padding: '5px 7px', borderRadius: 5, border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit' }}
          />
          <span style={{ fontSize: 10.5, opacity: 0.55 }}>{copy.minHint}</span>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11.5, opacity: 0.62 }}>
        <span>{copy.boundary}</span>
        {message && <span>· {message}</span>}
      </div>
    </div>
  );
}

function ActivationBoundaryPanel({ ctx }: { ctx: any }) {
  const locale = useLocale(ctx);
  const [activation, setActivation] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const lang = locale === 'zh' ? 'zh' : 'en';
        const res = await fetch(`${API}/config?lang=${lang}`, { cache: 'no-store' });
        const body = await res.json();
        if (!cancelled) {
          if (!res.ok || body?.ok === false) throw new Error(body?.error ?? `HTTP ${res.status}`);
          setActivation(body?.config?.config_activation ?? null);
          setError('');
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? String(err));
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [locale]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.55 }}>
      {error && <div style={{ fontSize: 11.5, opacity: 0.6 }}>{error}</div>}
      <ActivationSummary activation={activation ?? undefined} locale={locale} />
    </div>
  );
}

export function apply(ctx: any): void {
  applyCrew(ctx);
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'dsh-crew-adaptive-routing',
      order: 65,
      label: () => ctx.locale.getLocale().active === 'zh' ? 'DSH Crew · 自适应路由' : 'DSH Crew · Adaptive Routing',
    },
    () => <AdaptiveRoutingPanel ctx={ctx} />,
  ));
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'dsh-crew-runtime-controls',
      order: 66,
      label: () => ctx.locale.getLocale().active === 'zh' ? 'DSH Crew · 生效边界' : 'DSH Crew · Activation',
    },
    () => <ActivationBoundaryPanel ctx={ctx} />,
  ));
}
