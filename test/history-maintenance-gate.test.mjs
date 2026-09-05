import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = () => import('../src/history/admission-gate.mjs');

test('maintenance fences pending creations as well as existing agents', async () => {
  const { installHistoryAdmissionGate } = await load();
  let finish;
  let pending = false;
  const agents = { list: () => [], create: () => new Promise(resolve => { finish = resolve; }) };
  const gate = installHistoryAdmissionGate(agents, () => pending);
  const creating = agents.create({});
  assert.equal(gate.idle(), false);
  pending = true;
  await assert.rejects(() => agents.create({}), /HISTORY_MAINTENANCE_PENDING/);
  finish({}); await creating;
  assert.equal(gate.idle(), true);
  gate.dispose();
});

test('no active agent, including an idle native conversation, may be stopped for cleanup', async () => {
  const { installHistoryAdmissionGate } = await load();
  const agents = { list: () => [{ status: 'idle' }], create: async () => ({}) };
  const gate = installHistoryAdmissionGate(agents, () => false);
  assert.equal(gate.idle(), false);
  gate.dispose();
});

test('failing creation releases its admission count and disposal preserves other wrappers', async () => {
  const { installHistoryAdmissionGate } = await load();
  const agents = { list: () => [], create: async () => { throw Error('creation failed'); } };
  const gate = installHistoryAdmissionGate(agents, () => false);
  await assert.rejects(() => agents.create(), /creation failed/);
  assert.equal(gate.idle(), true);
  const other = async () => ({}); agents.create = other;
  gate.dispose(); assert.equal(agents.create, other);
});

test('missing authority and unreadable persistent gate fail closed', async () => {
  const { installHistoryAdmissionGate } = await load();
  assert.throws(() => installHistoryAdmissionGate({}, () => false));
  const agents = { list: () => [], create: async () => ({}) };
  const gate = installHistoryAdmissionGate(agents, () => { throw Error('corrupt marker'); });
  await assert.rejects(() => agents.create(), /corrupt marker/);
  assert.equal(gate.idle(), true);
  gate.dispose();
});

test('double installation, replaced admission method and broken live inventory cannot claim idle', async () => {
  const { installHistoryAdmissionGate } = await load();
  const agents = { list: () => [], create: async () => ({}) };
  const gate = installHistoryAdmissionGate(agents, () => false);
  assert.throws(() => installHistoryAdmissionGate(agents, () => false), /ALREADY_INSTALLED/);
  agents.list = () => { throw Error('unavailable'); };
  assert.equal(gate.idle(), false);
  agents.list = () => []; agents.create = async () => ({});
  assert.equal(gate.idle(), false);
  gate.dispose();
});

test('Cordis-style method proxies preserve ownership and fence both create and resume', async () => {
  const { installHistoryAdmissionGate } = await load();
  let pending = false;
  const raw = { list: () => [], create: async () => ({}), resume: async () => ({}) };
  const agents = new Proxy(raw, { get(target, name, receiver) { const value = Reflect.get(target, name, receiver); return typeof value === 'function' ? new Proxy(value, { apply: (fn, self, args) => Reflect.apply(fn, self, args) }) : value; } });
  const gate = installHistoryAdmissionGate(agents, () => pending);
  assert.equal(gate.idle(), true, 'proxy allocates a fresh callable on each property read');
  pending = true;
  await assert.rejects(() => agents.resume({}), /MAINTENANCE_PENDING/);
  await assert.rejects(() => agents.create({}), /MAINTENANCE_PENDING/);
  gate.dispose();
  await agents.resume({});
});

test('real official Cordis service proxies support the history admission adapter', async t => {
  const require = createRequire(import.meta.url);
  const peer = require.resolve('@deepseek-ai/cordis', { paths: [dirname(require.resolve('@deepseek-ai/dsh-agent'))] });
  const { Context, Service } = await import(pathToFileURL(peer).href);
  const { installHistoryAdmissionGate } = await load();
  const ctx = new Context();
  class Agents extends Service {
    constructor(ctx) { super(ctx, 'historyTestAgents'); }
    list() { return []; }
    async create() { return {}; }
    async resume() { return {}; }
  }
  const ready = new Promise(resolve => ctx.inject(['historyTestAgents'], () => { resolve(); }));
  const scope = ctx.plugin(Agents); t.after(() => scope.dispose()); await ready;
  let pending = false;
  const gate = installHistoryAdmissionGate(ctx.historyTestAgents, () => pending); t.after(() => gate.dispose());
  assert.equal(gate.idle(), true); pending = true;
  await assert.rejects(() => ctx.historyTestAgents.resume(), /MAINTENANCE_PENDING/);
});
