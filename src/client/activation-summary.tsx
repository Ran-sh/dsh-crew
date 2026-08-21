import React from 'react';

type Boundary = 'live' | 'next-workflow' | 'next-session' | 'restart-required';
type ActivationEntry = { global?: Boundary; session?: Boundary | null; note?: string };

const ORDER: Boundary[] = ['live', 'next-workflow', 'next-session', 'restart-required'];

const LABELS = {
  zh: {
    title: '配置生效边界',
    hint: '这里显示全局 Settings 保存后的实际生效时机；会话内 dsh_worker_config 覆盖可能更早生效。',
    boundary: {
      live: 'Live · 当前运行时',
      'next-workflow': 'Next workflow · 下一个任务',
      'next-session': 'Next session · 新 CC / Codex 会话',
      'restart-required': 'Restart required · 重启 DSH / MCP',
    } as Record<Boundary, string>,
  },
  en: {
    title: 'Configuration activation boundaries',
    hint: 'Shows when persisted Settings changes actually take effect. Session-level dsh_worker_config overrides may activate earlier.',
    boundary: {
      live: 'Live · current runtime',
      'next-workflow': 'Next workflow',
      'next-session': 'Next session · new CC / Codex session',
      'restart-required': 'Restart required · restart DSH / MCP',
    } as Record<Boundary, string>,
  },
};

export function groupActivationBoundaries(activation: Record<string, ActivationEntry> = {}) {
  const grouped = Object.fromEntries(ORDER.map((boundary) => [boundary, [] as string[]])) as Record<Boundary, string[]>;
  for (const [key, entry] of Object.entries(activation)) {
    if (entry?.global && grouped[entry.global]) grouped[entry.global].push(key);
  }
  for (const boundary of ORDER) grouped[boundary].sort();
  return grouped;
}

export function ActivationSummary({ activation, locale }: {
  activation?: Record<string, ActivationEntry>;
  locale?: string;
}) {
  if (!activation || Object.keys(activation).length === 0) return null;
  const lang = locale === 'zh' ? 'zh' : 'en';
  const copy = LABELS[lang];
  const grouped = groupActivationBoundaries(activation);
  return (
    <div style={{ border: '1px solid rgba(128,128,128,0.22)', borderRadius: 8, padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ fontWeight: 600, fontSize: 12.5 }}>{copy.title}</div>
      <div style={{ fontSize: 11, opacity: 0.6 }}>{copy.hint}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '5px 12px' }}>
        {ORDER.map((boundary) => (
          <div key={boundary} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10.5, opacity: 0.7, fontWeight: 600 }}>{copy.boundary[boundary]}</div>
            <div style={{ fontSize: 10.5, opacity: 0.55, wordBreak: 'break-word' }}>
              {grouped[boundary].length ? grouped[boundary].join(' · ') : '—'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
