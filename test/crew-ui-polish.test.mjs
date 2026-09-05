import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const client = fileURLToPath(new URL('../src/client/', import.meta.url));

function loadPanel(config) {
  let hook = 0;
  function load(file) {
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    const localRequire = (id) => {
      if (id === 'react') return { ...React,
        useState: (initial) => [hook++ === 0 ? config : typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {}, useCallback: (fn) => fn,
      };
      if (id.startsWith('.')) {
        const target = resolve(dirname(file), id);
        return load(existsSync(target) ? target : `${target}.tsx`);
      }
      return require(id);
    };
    vm.runInNewContext(code, { module, exports: module.exports, require: localRequire, setTimeout, clearTimeout });
    return module.exports;
  }
  return load(resolve(client, 'quick-panel.tsx')).QuickPanel;
}

const config = {
  subagents_enabled: true,
  flash_model_priority: [{ provider: 'my-provider', model: 'my-long-model' }],
  pro_model_priority: [], vision_enabled: false, imagegen_enabled: false,
};
const render = (locale = 'zh', value = config) => renderToStaticMarkup(
  React.createElement(loadPanel(value), { ctx: { locale: { getLocale: () => ({ active: locale }) } } }),
);

test('quick panel separates model identity and exposes accessible ordered-list actions', () => {
  const html = render();
  assert.match(html, /<ol/);
  assert.match(html, /aria-label="上移 my-long-model"/);
  assert.match(html, /aria-label="下移 my-long-model"/);
  assert.match(html, /aria-label="从优先级移除 my-long-model"/);
  assert.match(html, /aria-label="Worker \/ Flash Provider"/);
  assert.match(html, /aria-label="Worker \/ Flash 模型"/);
});

test('quick panel offers native collapsible groups, empty guidance and safe backend navigation', () => {
  const html = render();
  assert.ok((html.match(/<details/g) ?? []).length >= 3);
  assert.match(html, /未配置优先模型/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /打开 3210 后台/);
  assert.match(html, /focus-visible/);
  assert.match(html, /minmax\(0, 1fr\)/);
});

test('English quick controls retain English action names and do not imply real model callability', () => {
  const html = render('en');
  assert.match(html, /aria-label="Move up my-long-model"/);
  assert.match(html, /No priority models/);
  assert.match(html, /Backend connected/);
  assert.doesNotMatch(html, /models are callable|models ready/i);
});

test('backend uses the shared compact header and stacked accessible section headings', () => {
  const source = readFileSync(resolve(client, 'index.tsx'), 'utf8');
  assert.match(source, /<PanelHeader/);
  assert.match(source, /className="crew-section-heading"/);
  assert.match(source, /aria-expanded=\{expanded\}/);
  assert.match(source, /copy\.runningCount/);
  assert.doesNotMatch(source, /'Claude READY'|'Codex READY'|'ZCode READY'/);
});
