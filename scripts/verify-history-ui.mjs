// Full browser -> HTTP handler -> controller -> executor -> real TEMP files.
// Supervisor process control is simulated; never addresses real 3080/3210.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createHistoryService } from '../src/history/service.mjs';
import { registerHistoryHttp } from '../src/history/http.mjs';
import { runHistoryOperation } from '../src/history/operation.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.CREW_PLAYWRIGHT_MODULE || 'playwright');
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'crew-history-e2e-'));
const output = mkdtempSync(join(tmpdir(), 'crew-history-ui-shots-'));
mkdirSync(join(root, 'harness/storages'), { recursive: true });
mkdirSync(join(root, 'harness/sessions/example/session-test'), { recursive: true });
const file = join(root, 'harness/sessions/example/session-test/session.jsonl');
writeFileSync(file, 'DISPOSABLE TEST CONVERSATION');
writeFileSync(join(root, 'harness/storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['test-workspace'], archivedSessionIds: [] }, tables: { workspaces: { 'test-workspace': { path: '/example/project', title: 'Disposable workspace', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', sessionIds: ['session-test'] } } } }));
const errors = []; let stopped = false; let operationPromise;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const service = createHistoryService({ crewRoot: root, runtimeId: 'test', agents: { list: () => [], create: async () => ({}) },
  persistence: { supportsRawArtifacts: true, listSnapshots: async () => existsSync(file) ? [{ header: { id: 'session-test', createdAt: 1767225600000 }, revision: 'r1' }] : [], locate: () => ({ kind: 'jsonl', path: file }) },
  launch: async id => { operationPromise = pause(200).then(() => runHistoryOperation({ crewRoot: root, id,
    acquire: () => ({ ok: true }), release: () => ({ ok: true }), checkFence: () => service.fencedCheck(), assertStopped: () => stopped,
    supervisor: { stopOwnedBackend: async () => { stopped = true; await pause(150); return { ok: true }; }, startOwnedBackend: async () => { await pause(150); stopped = false; return { ok: true }; } }, verifyRunning: async () => !stopped,
  })); operationPromise.catch(error => errors.push(error.message)); },
});
let historyHandler;
registerHistoryHttp({ register: route => { historyHandler = route.handler; return () => {}; } }, service);
const browser = await chromium.launch({ headless: true, ...(process.env.CREW_BROWSER_EXE ? { executablePath: process.env.CREW_BROWSER_EXE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:41791') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<html><head><meta charset="utf-8"></head><body style="font:14px Arial;background:#f5f6f8"><main id="root" style="padding:24px;max-width:800px;margin:auto;background:white"></main></body></html>' });
    if (url.pathname.includes('/history/')) {
      if (stopped) return route.abort();
      const req = Readable.from([Buffer.from(request.postData() ?? '{}')]);
      Object.assign(req, { url: url.pathname, method: request.method(), headers: { host: url.host, origin: url.origin }, socket: { remoteAddress: '127.0.0.1' } });
      let status, body;
      await historyHandler(req, { writeHead: n => { status = n; }, end: s => { body = s; } });
      return route.fulfill({ status, contentType: 'application/json', body });
    }
    const suffix = url.pathname.split('/').pop(); let body = { ok: true };
    if (suffix === 'runtime') body = { ok: true, service: 'dsh-crew-hub', profile: 'dsh-crew', listen_port: 3210 };
    if (suffix === 'bridge-status') body = { ok: false };
    if (suffix === 'config') body = { ok: true, config: { flash_model_priority: [], pro_model_priority: [], default_timeout_seconds: 1800 } };
    if (suffix === 'status') body = { ok: true, status: {} };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://127.0.0.1:41791/'); await page.waitForLoadState('networkidle');
  await page.addScriptTag({ content: readFileSync(join(repo, 'node_modules/react/umd/react.development.js'), 'utf8') });
  await page.addScriptTag({ content: readFileSync(join(repo, 'node_modules/react-dom/umd/react-dom.development.js'), 'utf8') });
  await page.evaluate(() => {
    const root = window.ReactDOM.createRoot(document.getElementById('root'));
    const ctx = { on: () => () => {}, locale: { getLocale: () => ({ active: 'zh' }) }, slots: { inject: (_n, callback) => callback(), register: (_meta, render) => { root.render(render()); return () => {}; } } };
    window.__ModuleLoader__ = { load({ factory }) { const jsx = (tag, props, key) => window.React.createElement(tag, { ...props, ...(key === undefined ? {} : { key }) }); factory(id => {
      if (id === 'react') return window.React;
      if (id === 'react-dom' || id === 'react-dom/client') return window.ReactDOM;
      if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: window.React.Fragment };
      throw Error('Unexpected dependency');
    }).apply(ctx); } };
  });
  await page.addScriptTag({ content: readFileSync(join(repo, 'lib/client.js'), 'utf8') });
  await page.getByText('工作区与会话清理', { exact: true }).click();
  const preview = page.getByRole('button', { name: '预览清理范围', exact: true });
  await preview.click();
  await page.getByText('1 个工作区 · 1 个会话', { exact: true }).first().waitFor();
  const confirm = page.getByRole('button', { name: '确认执行', exact: true });
  assert.equal(await confirm.isEnabled(), false);
  await page.getByRole('checkbox', { name: '我已确认范围，并同意短暂重启 3210' }).check();
  await page.screenshot({ path: join(output, 'preview.png'), fullPage: true });
  await confirm.click(); await page.getByRole('button', { name: '恢复', exact: true }).waitFor({ timeout: 15000 }); await operationPromise;
  assert.equal(existsSync(file), false);
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[role=status]')].some(el => el.textContent === '已完成'));
  await operationPromise; assert.equal(readFileSync(file, 'utf8'), 'DISPOSABLE TEST CONVERSATION');
  await page.getByRole('combobox', { name: '操作', exact: true }).selectOption('delete');
  await page.getByRole('combobox', { name: '时间范围', exact: true }).selectOption('before');
  await page.getByLabel('创建时间早于', { exact: true }).fill('2027-01-01T00:00');
  await preview.click(); await page.getByRole('checkbox', { name: '我已确认范围，并同意短暂重启 3210' }).check();
  assert.equal(await confirm.isEnabled(), false);
  await page.getByLabel('删除确认：请输入 DELETE', { exact: true }).fill('DELETE'); await confirm.click();
  await page.waitForFunction(() => [...document.querySelectorAll('[role=status]')].some(el => el.textContent === '已完成'));
  await operationPromise; assert.equal(existsSync(file), false); assert.deepEqual(service.archives(), []);
  await page.screenshot({ path: join(output, 'completed.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, flows: ['archive all', 'restore', 'delete before date', 'confirmation guards', 'reconnect'], screenshots: output }));
} finally { await browser.close(); service.dispose(); rmSync(root, { recursive: true, force: true }); }
