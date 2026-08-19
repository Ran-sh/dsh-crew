// Functional probe of the real MCP stdio server (src/server.mjs), no DSH
// instance and no DeepSeek credentials needed: policy rejections must happen
// before any worker runtime is touched.
// Run: node scripts/policy-probe.mjs

import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['src/server.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function call(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } });
await new Promise((r) => setTimeout(r, 200));

// 1. Read config: must expose the new effective policy fields.
const cfg = await call('tools/call', { name: 'dsh_worker_config', arguments: {} });
const cfgText = cfg.result?.content?.[0]?.text;
let cfgJson = null;
try { cfgJson = JSON.parse(cfgText); } catch {}
check('config returns effective policy', !!cfgJson && typeof cfgJson.flash_state === 'string' && typeof cfgJson.pro_state === 'string' && typeof cfgJson.routing_guidance === 'string',
  cfgJson ? `flash=${cfgJson.flash_state} pro=${cfgJson.pro_state} mode=${cfgJson.collaboration_mode}` : cfgText?.slice(0, 120));
check('config hides API keys', cfgText !== undefined && !/api_key|sk-/.test(cfgText));
check('config reports effective_policy + roles + legacy_source', !!cfgJson
  && typeof cfgJson.effective_policy === 'string' && cfgJson.effective_policy.includes('mode=')
  && Array.isArray(cfgJson.flash_roles) && cfgJson.flash_roles.length > 0
  && Array.isArray(cfgJson.pro_roles) && cfgJson.pro_roles.length > 0
  && typeof cfgJson.legacy_source === 'string',
  cfgJson ? cfgJson.effective_policy : undefined);
check('config reflects main_agent_mode', !!cfgJson && ['direct-allowed', 'coordinator-first', 'dispatcher-only'].includes(cfgJson.main_agent_mode), cfgJson?.main_agent_mode);

// 2. Session clamp: flash-only + explicit pro must be refused with TIER_DISABLED.
const clamp = await call('tools/call', { name: 'dsh_worker_config', arguments: { tier_policy: 'flash-only' } });
check('session tier_policy clamp set', clamp.result !== undefined && !clamp.result.isError);

const refusePro = await call('tools/call', { name: 'dsh_run_worker', arguments: { task: 'probe', tier: 'pro' } });
const refuseText = refusePro.result?.content?.[0]?.text ?? '';
check('pro refused under flash-only', /TIER_DISABLED/.test(refuseText), refuseText.slice(0, 120));

// 3. subagents master switch via session enabled=false.
const off = await call('tools/call', { name: 'dsh_worker_config', arguments: { reset: true, enabled: false } });
check('session enabled=false set', off.result !== undefined && !off.result.isError);
const refuseAll = await call('tools/call', { name: 'dsh_run_worker', arguments: { task: 'probe' } });
const refuseAllText = refuseAll.result?.content?.[0]?.text ?? '';
check('dispatch refused when disabled', /SUBAGENTS_DISABLED/.test(refuseAllText), refuseAllText.slice(0, 120));

// 4. dsh_spawn_worker shares the same policy.
const refuseSpawn = await call('tools/call', { name: 'dsh_spawn_worker', arguments: { task: 'probe' } });
const refuseSpawnText = refuseSpawn.result?.content?.[0]?.text ?? '';
check('spawn refused when disabled', /SUBAGENTS_DISABLED/.test(refuseSpawnText));

// 5. Manual semantics: flash manual + pro auto, no explicit tier → pro is chosen, never flash.
const manual = await call('tools/call', { name: 'dsh_worker_config', arguments: { reset: true, tier_policy: 'auto' } });
// global config is balanced here; exercise manual via session state override:
const manualSet = await call('tools/call', { name: 'dsh_worker_config', arguments: { collaboration_mode: 'custom', flash_state: 'manual', pro_state: 'auto', default_tier: 'flash' } });
check('manual/custom session set', manualSet.result !== undefined && !manualSet.result.isError);
const manualCfg = await call('tools/call', { name: 'dsh_worker_config', arguments: {} });
const manualCfgJson = JSON.parse(manualCfg.result.content[0].text);
check('manual tier never auto-default (effective_default_tier=pro)',
  manualCfgJson.effective_default_tier === 'pro', `got ${manualCfgJson.effective_default_tier}`);
check('effective states reported', manualCfgJson.flash_state === 'manual' && manualCfgJson.pro_state === 'auto');

// 6. Reset back to global defaults.
const reset = await call('tools/call', { name: 'dsh_worker_config', arguments: { reset: true } });
check('reset restores defaults', reset.result !== undefined && !reset.result.isError);

child.kill();
await new Promise((r) => setTimeout(r, 100));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
