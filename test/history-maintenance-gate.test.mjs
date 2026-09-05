import test from 'node:test';
import assert from 'node:assert/strict';
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
