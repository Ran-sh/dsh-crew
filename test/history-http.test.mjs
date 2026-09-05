import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

test('history endpoints require same-origin local access and no GET triggers a mutation', async () => {
  const { registerHistoryHttp } = await import('../src/history/http.mjs');
  let handler; let calls = 0; let registeredPath;
  registerHistoryHttp({ register: r => { handler = r.handler; registeredPath = r.path; return () => {}; } }, {
    status: () => ({ phase: 'IDLE' }), archives: () => [], preview: async () => ({ planId: 'test' }),
    execute: async () => { calls++; return { phase: 'QUEUED' }; }, restore: async () => { calls++; return {}; }, recover: async () => { calls++; return {}; }, fencedCheck: async () => true,
  });
  assert.equal(registeredPath, '/_dsh/dsh-crew/history', 'official prefix matcher appends its own slash boundary');
  async function request(path, method = 'GET', body = {}, headers = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { url: '/_dsh/dsh-crew/history/' + path, method, headers: { host: '127.0.0.1:3210', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    let status, payload;
    await handler(req, { writeHead: n => { status = n; }, end: s => { payload = JSON.parse(s); } });
    return { status, payload };
  }
  assert.equal((await request('execute')).status, 405);
  assert.equal((await request('execute', 'POST', {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await request('execute', 'POST', {}, { origin: 'http://127.0.0.1:3080' })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await request('preview', 'POST')).status, 200);
  assert.equal((await request('execute', 'POST')).status, 202);
  assert.equal(calls, 1);
  assert.equal((await request('status')).payload.status.phase, 'IDLE');
  assert.deepEqual((await request('archives')).payload.archives, []);
  assert.equal((await request('restore', 'POST')).status, 202);
  assert.equal((await request('recover', 'POST')).status, 202);
  assert.equal((await request('fenced-check', 'POST')).status, 200);
  assert.equal((await request('unknown', 'POST')).status, 404);
  assert.equal((await request('status', 'PUT')).status, 405);
  assert.equal((await request('preview', 'POST', [])).status, 400);
  assert.equal((await request('preview', 'POST', { large: 'x'.repeat(5000) })).status, 413);
});
