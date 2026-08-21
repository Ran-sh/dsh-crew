import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { apply as applyCrew, inject as crewInject } from './index';
import { ActivationSummary } from './activation-summary';

export const inject = crewInject;
const API = '/_dsh/dsh-crew';

function ActivationBoundaryPanel({ ctx }: { ctx: any }) {
  const locale = useSyncExternalStore(
    (notify: () => void) => ctx.on('locale/change', notify),
    () => ctx.locale.getLocale().active,
    () => ctx.locale.getLocale().active,
  );
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
      id: 'dsh-crew-runtime-controls',
      order: 66,
      label: () => ctx.locale.getLocale().active === 'zh' ? 'DSH Crew · 生效边界' : 'DSH Crew · Activation',
    },
    () => <ActivationBoundaryPanel ctx={ctx} />,
  ));
}
