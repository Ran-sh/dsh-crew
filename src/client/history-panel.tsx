import { useEffect, useState } from 'react';

const API = '/_dsh/dsh-crew/history/';
const pending = (phase?: string) => !!phase && !['IDLE', 'DONE', 'FAILED', 'ROLLED_BACK'].includes(phase);
const copy = {
  zh: {
    title: '工作区与会话清理', intro: '仅影响 3210 的工作区记录与会话日志；不删除项目文件、附件或 3080 数据。',
    operation: '操作', archive: '归档（可恢复）', delete: '删除（不可恢复）', scope: '时间范围', all: '全部', before: '指定时间之前',
    time: '创建时间早于', timeHint: '按本机时区选择，严格按创建时间筛选；包含新会话的工作区会保留。',
    preview: '预览清理范围', confirm: '确认执行', acknowledgement: '删除确认：请输入 DELETE', idle: '会短暂停止并重启 3210；请先结束或关闭所有正在使用的 3210 会话。',
    consent: '我已确认范围，并同意短暂重启 3210', restore: '恢复', archives: '已归档批次', empty: '暂无可恢复的归档',
    working: '维护中，正在等待 3210 重新连接…', refresh: '刷新页面与工作区列表', recover: '恢复未完成的维护',
    recovery: '维护尚未完成，请使用恢复按钮；若 3210 无法连接，在终端运行 dsh-crew history recover。',
    count: (w: number, s: number) => `${w} 个工作区 · ${s} 个会话`, confirmRestore: '恢复这一批归档？将短暂重启 3210，不会覆盖冲突数据。',
    phase: { IDLE: '就绪', QUEUED: '已提交', STOPPING: '停止后台', APPLYING: '处理数据', STARTING: '启动后台', VERIFYING: '验证结果', DONE: '已完成', FAILED: '未执行成功', ROLLED_BACK: '已回滚', RECOVERY_REQUIRED: '需要恢复' },
  },
  en: {
    title: 'Workspace & session cleanup', intro: 'Only 3210 workspace records and session logs. Project files, attachments and 3080 data are untouched.',
    operation: 'Action', archive: 'Archive (restorable)', delete: 'Delete (permanent)', scope: 'Time range', all: 'All', before: 'Before a date',
    time: 'Created before', timeHint: 'Local timezone; strict creation-time cutoff. Workspaces with newer sessions are kept.',
    preview: 'Preview cleanup', confirm: 'Confirm operation', acknowledgement: 'Type DELETE to confirm deletion', idle: '3210 will briefly stop and restart. End or close all active 3210 conversations first.',
    consent: 'I reviewed the scope and agree to restart 3210', restore: 'Restore', archives: 'Archived batches', empty: 'No restorable archives',
    working: 'Maintenance in progress; waiting for 3210 to reconnect…', refresh: 'Reload page and workspace list', recover: 'Recover unfinished maintenance',
    recovery: 'Maintenance is unfinished. Use recovery; if 3210 is unreachable, run dsh-crew history recover in a terminal.',
    count: (w: number, s: number) => `${w} workspaces · ${s} sessions`, confirmRestore: 'Restore this archive? 3210 will briefly restart; conflicting data will not be overwritten.',
    phase: { IDLE: 'Ready', QUEUED: 'Queued', STOPPING: 'Stopping backend', APPLYING: 'Processing data', STARTING: 'Starting backend', VERIFYING: 'Verifying', DONE: 'Completed', FAILED: 'Failed', ROLLED_BACK: 'Rolled back', RECOVERY_REQUIRED: 'Recovery required' },
  },
};

export function HistoryPanel({ locale }: { locale: string }) {
  const t = copy[locale === 'zh' ? 'zh' : 'en'];
  const [open, setOpen] = useState(false);
  const [operation, setOperation] = useState('archive');
  const [scope, setScope] = useState('all');
  const [before, setBefore] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [status, setStatus] = useState<any>({ phase: 'IDLE' });
  const [archives, setArchives] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [ack, setAck] = useState('');
  const [notice, setNotice] = useState('');
  const [connected, setConnected] = useState(false);
  const locked = busy || pending(status.phase);
  const invalidate = () => { setPreview(null); setConsent(false); setAck(''); };

  async function request(action: string, body?: unknown) {
    const res = await fetch(API + action, { cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await res.json();
    if (!res.ok || !data.ok) throw Error(data.code ?? `HTTP ${res.status}`);
    return data;
  }
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    const poll = async () => {
      try {
        const [s, a] = await Promise.all([request('status'), request('archives')]);
        if (!disposed) { setStatus(s.status); setArchives(a.archives); setConnected(true); }
      } catch { if (!disposed) setConnected(false); }
    };
    void poll(); const timer = setInterval(poll, 2500);
    return () => { disposed = true; clearInterval(timer); };
  }, [open]);

  async function act(action: string, body: any) {
    setBusy(true); setNotice('');
    try {
      const result = await request(action, body);
      if (result.preview) { setPreview(result.preview); setConsent(false); setAck(''); }
      if (result.status) { setStatus(result.status); setPreview(null); }
    } catch (error: any) { setNotice(String(error.message)); setPreview(null); }
    finally { setBusy(false); }
  }
  const style = { border: '1px solid rgba(128,128,128,.25)', borderRadius: 8, padding: '7px 10px', color: 'inherit', background: 'transparent', font: 'inherit' };
  return <details style={{ border: '1px solid rgba(128,128,128,.24)', borderRadius: 10, padding: '10px 13px' }} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary style={{ cursor: 'pointer', fontWeight: 650 }}>{t.title}</summary>
    {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
      <p style={{ margin: 0, opacity: .75 }}>{t.intro}</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label>{t.operation} <select style={style} value={operation} disabled={locked} onChange={e => { setOperation(e.target.value); invalidate(); }}><option value="archive">{t.archive}</option><option value="delete">{t.delete}</option></select></label>
        <label>{t.scope} <select style={style} value={scope} disabled={locked} onChange={e => { setScope(e.target.value); invalidate(); }}><option value="all">{t.all}</option><option value="before">{t.before}</option></select></label>
      </div>
      {scope === 'before' && <label>{t.time} <input type="datetime-local" style={style} value={before} disabled={locked} onChange={e => { setBefore(e.target.value); invalidate(); }} /></label>}
      <div style={{ fontSize: 11.5, opacity: .7 }}>{t.timeHint}</div>
      <button type="button" style={style} disabled={locked || !connected || (scope === 'before' && !Number.isFinite(new Date(before).getTime()))} onClick={() => void act('preview', { operation, scope, ...(scope === 'before' ? { before: new Date(before).toISOString() } : {}) })}>{t.preview}</button>
      {preview && <div style={{ ...style, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <strong>{t.count(preview.counts.workspaces, preview.counts.sessions)}</strong>
        {preview.before && <span>{t.time}: {new Date(preview.before).toLocaleString()}</span>}
        <details><summary>{t.preview}</summary><ul>{preview.items?.map((item: any) => <li key={item.id}>{item.title} <small>{item.id}</small></li>)}</ul><div style={{ overflowWrap: 'anywhere', fontSize: 11 }}>{preview.sessionIds?.slice(0, 100).join(', ')}{preview.sessionIds?.length > 100 ? ' …' : ''}</div></details>
        {!preview.executable && <div role="alert">{preview.blockedReason}</div>}
        <div>{t.idle}</div>
        <label><input type="checkbox" checked={consent} disabled={locked} onChange={e => setConsent(e.target.checked)} /> {t.consent}</label>
        {operation === 'delete' && <label>{t.acknowledgement} <input style={style} value={ack} disabled={locked} onChange={e => setAck(e.target.value)} /></label>}
        <button type="button" style={style} disabled={locked || !consent || !preview.executable || (operation === 'delete' && ack !== 'DELETE')} onClick={() => void act('execute', { planId: preview.planId, confirm: true, acknowledgement: ack })}>{t.confirm}</button>
      </div>}
      <div role="status" aria-live="polite">{(t.phase as any)[status.phase] ?? status.phase}{status.code ? ` · ${status.code}` : ''}{notice ? ` · ${notice}` : ''}</div>
      {!connected && <div role="status">{pending(status.phase) ? t.working : '3210 history API unavailable'}<p>{t.recovery}</p></div>}
      {['RECOVERY_REQUIRED', 'QUEUED'].includes(status.phase) && <div><p>{t.recovery}</p><button type="button" style={style} disabled={busy} onClick={() => { if (window.confirm(t.recovery)) void act('recover', { confirm: true }); }}>{t.recover}</button></div>}
      {['DONE', 'ROLLED_BACK'].includes(status.phase) && <button type="button" style={style} onClick={() => window.location.reload()}>{t.refresh}</button>}
      <strong>{t.archives}</strong>
      {archives.length === 0 && <span style={{ opacity: .6 }}>{t.empty}</span>}
      {archives.map(a => <div key={a.id} style={{ ...style, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><span style={{ flex: 1 }}>{a.invalid ? `${a.id} · ${a.code}` : `${new Date(a.createdAt).toLocaleString()} · ${t.count(a.workspaces, a.sessions)}`}</span><button type="button" style={style} disabled={locked || a.invalid} onClick={() => { if (window.confirm(t.confirmRestore)) void act('restore', { archiveId: a.id, confirm: true }); }}>{t.restore}</button></div>)}
    </div>}
  </details>;
}
