// Real DSH smoke for the v0.2 runtime path. Spawns this branch's MCP server
// (src/server.mjs) over stdio and drives it with the MCP SDK.
//   run|spawn : against a LIVE DSH hub (127.0.0.1:3080)
//   standalone: standalone worker path (jobs.mjs) routed at the DSH-configured
//               OpenAI-compatible gateway (base URL + key read from DSH's own
//               ~/.dsh store; injected as DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL,
//               never printed).
// Uses a throwaway temp git repo; never touches the web profile or user repos.
// Usage: node scripts/smoke-real.mjs <tempGitRepo> [run|spawn|standalone]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const repo = process.argv[2];
const mode = process.argv[3] ?? 'run';
const effort = process.argv[4] ?? 'max';
if (!repo) { console.error('usage: node scripts/smoke-real.mjs <tempGitRepo> [run|spawn|standalone] [effort]'); process.exit(2); }

/** Read KEY: value (credentials.yaml) with values redacted from logs. */
function readDshStore() {
  const cred = join(homedir(), '.dsh', '.credentials.yaml');
  const settings = join(homedir(), '.dsh', 'settings.yaml');
  const key = (file, name) => {
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`));
        if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
      }
    } catch {}
    return '';
  };
  // provider-level apiKey (settings.yaml) falls back to the credential store key
  return {
    apiKey: key(settings, 'apiKey') || key(cred, 'OPENCODE_GO_API_KEY'),
    baseURL: key(settings, 'baseURL') || 'https://opencode.ai/zen/go/v1',
  };
}

/** Session descriptor for the MCP child. NEVER logs the key. */
function serverTransport(extraEnv = {}) {
  return new StdioClientTransport({
    command: 'node',
    args: ['src/server.mjs'],
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stderr: process.stderr,
  });
}

const TASK = [
  'In this git repository, create the file src/answer.mjs with exactly the content: `export const answer = 40 + 2;`',
  'Then run the single-line check: node -e \'const a = require("./src/answer.mjs"); if (a.answer !== 42) process.exit(1); console.log("answer ok");\' (ESM note: use import("./src/answer.mjs") or write .cjs — pick whatever works and run it).',
  'End your final message with the required Delivery Report:',
  '## Diff',
  '- src/answer.mjs — added answer',
  '## Tests',
  'PASS — node check — answer is 42',
  '## Risks',
  'none',
].join('\n');

// For standalone mode, route the worker at the user's DSH-configured
// OpenAI-compatible gateway (key + base URL flow through the child env only,
// they are never logged).
const standaloneEnv = {};
if (mode === 'standalone') {
  const store = readDshStore();
  if (!store.apiKey) { console.error('[smoke] no OpenAI-compatible key found in ~/.dsh (OPENCODE_GO_API_KEY / settings apiKey)'); process.exit(2); }
  standaloneEnv.DEEPSEEK_API_KEY = store.apiKey;
  standaloneEnv.DEEPSEEK_BASE_URL = store.baseURL;
  standaloneEnv.DSH_SANDBOX_MODE = 'workspace-write';
  console.log(`[smoke] standalone: routing at ${store.baseURL} (key injected, not shown)`);
}
const transport = serverTransport(standaloneEnv);
const client = new Client({ name: 'dsh-crew-smoke', version: '1.0.0', requestTimeout: 600 * 1000 });

async function call(name, args, timeoutMs) {
  const res = await client.callTool({ name, arguments: args }, undefined, timeoutMs ? { timeout: timeoutMs } : undefined);
  return JSON.parse(res.content.find((c) => c.type === 'text').text);
}

try {
  await client.connect(transport);
  console.log(`[smoke] connected; mode=${mode} cwd=${repo}`);
  if (mode === 'standalone') {
    // Force the standalone execution path (session mode) so jobs.mjs handles it.
    await call('dsh_worker_config', { mode: 'standalone' });
  }

  if (mode === 'spawn') {
    const spawnView = await call('dsh_spawn_worker', { task: TASK, role: 'worker', cwd: repo });
    console.log('[smoke] spawn view:', JSON.stringify(spawnView, null, 2));
    const wfId = spawnView.workflow_id ?? spawnView.id;
    // poll a few times for the final result (workflow continues in background)
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const v = await call('dsh_worker_result', { job_id: wfId, wait_seconds: 0 });
      if (v.status !== 'running') {
        console.log('[smoke] final (spawn):', JSON.stringify({ id: v.id, role: v.role, phase: v.phase, status: v.status, isolation: v.isolation, attempt: v.attempt, review: v.review?.verdict ?? null, candidate: v.candidate?.changed_files ?? null, error: v.error }, null, 2));
        await client.close();
        process.exit(v.status === 'done' ? 0 : 1);
      }
      if (i === 23) console.log('[smoke] still running after poll window: ', JSON.stringify(v));
    }
    await client.close();
    process.exit(2);
  }

    const view = await call('dsh_run_worker', { task: TASK, role: 'worker', cwd: repo, effort, timeout_seconds: 540 }, 560 * 1000);
  const k = (o) => ({ id: o.id, role: o.role, phase: o.phase, status: o.status, isolation: o.isolation, execution_cwd: o.execution_cwd, base_revision: o.base_revision, attempt: o.attempt, decision: o.decision, review: o.review?.verdict ?? null, candidate_available: o.candidate_available, candidate_changed: o.candidate?.changed_files ?? null, outcome_task: o.outcome?.task_status ?? null, tests: o.outcome?.tests_status ?? null, error: o.error, error_code: o.error_code, cleanup_warning: o.cleanup_warning, primary_dirty_hint: o.primary_workspace_dirty });
  console.log('[smoke] final (run):', JSON.stringify(k(view), null, 2));
  await client.close();
  process.exit(view.status === 'done' ? 0 : 1);
} catch (err) {
  console.error('[smoke] ERROR:', err?.message ?? err);
  try { await client.close(); } catch {}
  process.exit(3);
}
