// Isolated browser acceptance of the shipped modules. All HTTP requests are
// intercepted: no real Crew configuration or host browser profile is accessed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.CREW_PLAYWRIGHT_MODULE || 'playwright');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = mkdtempSync(join(tmpdir(), 'crew-ui-polish-'));
const browser = await chromium.launch({ headless: true,
  ...(process.env.CREW_BROWSER_EXE ? { executablePath: process.env.CREW_BROWSER_EXE } : {}),
});
const errors = [];
const results = [];
const baseConfig = {
  subagents_enabled: true, collaboration_mode: 'balanced', main_agent_mode: 'direct-allowed',
  flash_state: 'auto', pro_state: 'auto', isolation: 'worktree', max_parallel: 16,
  default_tier: 'flash', default_effort: 'max', mode: 'auto',
  vision_enabled: true, imagegen_enabled: false, vision_provider: 'example', imagegen_provider: 'example',
  flash_model_priority: [
    { provider: 'example-provider', model: 'long-model-name-for-responsive-layout-check' },
    { provider: 'example-provider', model: 'second-model' },
  ], pro_model_priority: [],
};

async function mount(surface, locale = 'zh') {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  let config = structuredClone(baseConfig);
  const patches = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:41790') return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#f6f7f9;color:#20252b;font-family:Arial,sans-serif}main{max-width:760px;margin:24px auto;padding:20px;background:white;border-radius:16px}@media(prefers-color-scheme:dark){body{background:#16191d;color:#e5e7eb}main{background:#20242a}}</style></head><body><main id="root"></main></body></html>' });
    const suffix = url.pathname.replace('/_dsh/dsh-crew', '');
    let body = { ok: true };
    if (suffix === '/bridge-status') body = surface === 'quick' ? { ok: true, surface: 'official-bridge' } : { ok: false };
    else if (suffix === '/runtime') body = { ok: true, service: 'dsh-crew-hub', profile: 'dsh-crew', listen_port: 3210, execution_plane: 'hub-3210', runtime_version: 'test', protocol_version: 1 };
    else if (suffix === '/quick-config' && request.method() === 'POST') {
      const patch = request.postDataJSON(); patches.push(patch); config = { ...config, ...patch }; body = { ok: true, config };
    } else if (suffix === '/quick-status' || suffix === '/config') body = { ok: true, config };
    else if (suffix === '/jobs') body = { ok: true, jobs: [] };
    else if (suffix === '/install/status') body = { ok: true, status: { codex: { ready: true, installed: true }, claude: { ready: true, installed: true }, zcode: { ready: true, installed: true } } };
    else if (suffix === '/model-catalog' || suffix === '/providers') body = { ok: true, providers: [], records: [] };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://127.0.0.1:41790/');
  await page.waitForLoadState('networkidle');
  await page.addScriptTag({ content: readFileSync(join(root, 'node_modules/react/umd/react.development.js'), 'utf8') });
  await page.addScriptTag({ content: readFileSync(join(root, 'node_modules/react-dom/umd/react-dom.development.js'), 'utf8') });
  await page.evaluate(locale => {
    const ctx = {
      on: () => () => {}, locale: { getLocale: () => ({ active: locale }) },
      slots: { inject: (_name, callback) => callback(), register: (_meta, render) => { window.crewRoot.render(render()); return () => {}; } },
    };
    window.crewRoot = window.ReactDOM.createRoot(document.getElementById('root'));
    window.__ModuleLoader__ = { load({ factory }) {
      const jsx = (tag, props, key) => window.React.createElement(tag, { ...props, ...(key === undefined ? {} : { key }) });
      factory(id => {
        if (id === 'react') return window.React;
        if (id === 'react-dom' || id === 'react-dom/client') return window.ReactDOM;
        if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: window.React.Fragment };
        throw Error('Unexpected fixture dependency: ' + id);
      }).apply(ctx);
    } };
  }, locale);
  await page.addScriptTag({ content: readFileSync(join(root, surface === 'quick' ? 'official-web-bridge/lib/client.js' : 'lib/client.js'), 'utf8') });
  try { await page.locator('.crew-panel-header').waitFor({ timeout: 10000 }); }
  catch (error) {
    console.error(JSON.stringify({ surface, errors, body: (await page.locator('body').innerText()).slice(0, 1600) }));
    throw error;
  }
  return { page, patches };
}

try {
  const { page, patches } = await mount('quick');
  await page.getByRole('link', { name: '打开 3210 后台 →' }).waitFor();
  assert.equal(await page.getByRole('link', { name: '打开 3210 后台 →' }).getAttribute('href'), 'http://127.0.0.1:3210/');
  await page.screenshot({ path: join(output, '3080-quick.png'), fullPage: true });
  const worker = page.locator('details.crew-quick-group').filter({ has: page.locator('summary strong', { hasText: 'Worker / Flash' }) });
  await worker.getByRole('button', { name: '下移 long-model-name-for-responsive-layout-check' }).click();
  await page.waitForFunction(() => document.querySelector('.crew-quick-list li .crew-quick-model-name')?.textContent === 'second-model');
  assert.equal(patches.at(-1).flash_model_priority[0].model, 'second-model');
  await worker.getByRole('button', { name: '从优先级移除 second-model' }).click();
  await worker.locator('li').first().waitFor();
  await worker.locator('.crew-quick-add > summary').click();
  await worker.getByRole('textbox', { name: 'Worker / Flash Provider', exact: true }).fill('added-provider');
  await worker.getByRole('textbox', { name: 'Worker / Flash 模型', exact: true }).fill('added-model');
  await worker.getByRole('button', { name: '+ 添加模型', exact: true }).click();
  await worker.getByText('added-model', { exact: true }).waitFor();
  assert.equal(patches.at(-1).flash_model_priority.at(-1).model, 'added-model');
  await page.getByRole('checkbox', { name: '启用子 Agent' }).uncheck();
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]').disabled);
  assert.equal(patches.at(-1).subagents_enabled, false);
  await worker.locator(':scope > summary').click();
  assert.equal(await worker.getAttribute('open'), null);
  await page.setViewportSize({ width: 420, height: 900 });
  await worker.locator(':scope > summary').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, '3080-narrow.png'), fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: join(output, '3080-dark.png'), fullPage: true });
  results.push('quick: reorder/remove/add/toggle/collapse/narrow/dark');
  await page.close();

  const { page: backend } = await mount('full');
  const backLink = backend.getByRole('link', { name: '打开 3080 官方界面 →' });
  assert.equal(await backLink.getAttribute('href'), 'http://127.0.0.1:3080/');
  await backend.getByRole('button', { name: '全部折叠', exact: true }).click();
  await backend.screenshot({ path: join(output, '3210-backend.png'), fullPage: true });
  await backend.getByRole('button', { name: '全部展开', exact: true }).click();
  assert.equal(await backend.locator('.crew-section-trigger[aria-expanded=false]').count(), 0);
  await backend.getByRole('button', { name: '全部折叠', exact: true }).click();
  await backend.setViewportSize({ width: 420, height: 900 });
  assert.equal(await backend.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await backend.screenshot({ path: join(output, '3210-narrow.png'), fullPage: true });
  results.push('backend: reciprocal link/expand all/collapse all/narrow');
  await backend.close();
  const { page: english } = await mount('quick', 'en');
  await english.getByRole('button', { name: 'Move down long-model-name-for-responsive-layout-check' }).waitFor();
  await english.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, results, consoleErrors: errors, screenshots: output }));
} finally { await browser.close(); }
