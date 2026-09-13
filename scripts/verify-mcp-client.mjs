// Drives the installed release's own MCP server over stdio, so the client-side
// dispatch path is exercised by the shipped code rather than by a long-running
// session whose MCP process predates the fix.
import { spawn } from 'node:child_process';

const serverPath = process.argv[2];
const scenario = process.argv[3] ?? 'zero-change';
const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });

let buffer = '';
let nextId = 1;
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve } = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  }
});
const stderr = [];
child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

function send(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, { resolve }));
}
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const scenarios = {
  'zero-change': {
    tool: 'dsh_run_worker',
    arguments: {
      task: 'Create a temporary PowerShell script at work/tmp-hello.ps1 that writes exactly the text 你好 to standard output with no trailing newline, run it, and verify its stdout is exactly 你好 byte-for-byte under both CP936 and UTF-8. Then delete the script and confirm the path no longer exists. Do not leave any file behind: the final workspace must be unchanged.',
      cwd: 'D:/Users/48376/Desktop/crew-verify-1',
      role: 'worker',
      workspace: { worktree: 'none' },
      constraints: { allow_no_changes: true, timeout_seconds: 600 },
    },
  },
  'tool-list': { tool: null },
};

const scenarioSpec = scenarios[scenario];
const init = await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'crew-verify', version: '1' },
});
if (init.error) {
  console.log('INIT_FAILED', JSON.stringify(init.error));
  process.exit(1);
}
notify('notifications/initialized', {});
console.log('SERVER', JSON.stringify(init.result?.serverInfo ?? null));

const listed = await send('tools/list', {});
const tools = (listed.result?.tools ?? []).map((t) => t.name);
console.log('TOOLS', JSON.stringify(tools));

if (scenarioSpec.tool) {
  const started = Date.now();
  const call = await send('tools/call', { name: scenarioSpec.tool, arguments: scenarioSpec.arguments });
  console.log('ELAPSED_MS', Date.now() - started);
  if (call.error) {
    console.log('CALL_ERROR', JSON.stringify(call.error));
  } else {
    const text = (call.result?.content ?? []).map((c) => c.text ?? '').join('');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* keep raw */ }
    if (parsed) {
      const summary = parsed.evidence?.summary ?? {};
      console.log('RESULT', JSON.stringify({
        id: parsed.id,
        phase: parsed.phase,
        status: parsed.status,
        isolation: parsed.isolation,
        execution_cwd: parsed.execution_cwd,
        task_status: summary.task_status,
        tests_status: summary.tests_status,
        delivery_complete: summary.delivery_complete,
        workspace_evidence_ok: parsed.workspace_evidence_ok ?? parsed.evidence?.workspace_evidence_ok,
        no_change_verified: parsed.outcome?.no_change_verified,
        failure: parsed.failure?.reason_code ?? null,
        error: parsed.error ?? null,
      }, null, 1));
    } else {
      console.log('RAW', text.slice(0, 1500));
    }
  }
}

child.kill();
if (stderr.length) console.log('STDERR_SAMPLE', stderr.join('').slice(0, 400));
