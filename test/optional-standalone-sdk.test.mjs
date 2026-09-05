import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('job utilities load when the optional official SDK cannot be resolved', () => {
  const hook = `export async function resolve(specifier, context, next) { if (specifier === '@deepseek-ai/dsh-sdk-client') throw Object.assign(new Error('SDK intentionally absent'), { code: 'ERR_MODULE_NOT_FOUND' }); return next(specifier, context); }`;
  const script = `import {register} from 'node:module'; register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(hook))}, import.meta.url); const m = await import(${JSON.stringify(new URL('../src/jobs.mjs', import.meta.url).href)}); if(typeof m.jobView !== 'function') throw Error('missing export');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test('SDK loads only when standalone run is requested and closes the real harness', async () => {
  const { createStandaloneHarness } = await import('../src/standalone-sdk.mjs');
  let loads = 0; let closes = 0;
  const harness = createStandaloneHarness({ profile: 'sdk-minimal' }, { load: async () => { loads++; return { DeepSeekHarness: class {
    constructor(options) { assert.equal(options.profile, 'sdk-minimal'); }
    async run(prompt) { return prompt; }
    async close() { closes++; }
  } }; } });
  assert.equal(loads, 0);
  assert.equal(await harness.run('test'), 'test');
  await harness.close(); assert.equal(closes, 1);
});

test('cancellation during SDK loading never constructs or starts a harness', async () => {
  const { createStandaloneHarness } = await import('../src/standalone-sdk.mjs');
  let resolve; let created = 0;
  const harness = createStandaloneHarness({}, { load: () => new Promise(r => { resolve = r; }) });
  const running = harness.run('test');
  await harness.close();
  resolve({ DeepSeekHarness: class { constructor() { created++; } } });
  await assert.rejects(running, /cancelled/); assert.equal(created, 0);
});

test('missing standalone SDK returns a bounded actionable error rather than crashing MCP startup', async () => {
  const { createStandaloneHarness } = await import('../src/standalone-sdk.mjs');
  const harness = createStandaloneHarness({}, { load: async () => { throw Object.assign(Error('private loader path'), { code: 'ERR_MODULE_NOT_FOUND' }); } });
  await assert.rejects(harness.run('test'), error => error.code === 'STANDALONE_SDK_UNAVAILABLE' && !error.message.includes('private loader path'));
});
