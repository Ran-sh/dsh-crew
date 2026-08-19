// Live policy acceptance matrix against the running DSH hub (loopback API).
// Uses the config route to switch policy states and the jobs route to verify
// dispatch decisions. Jobs that actually start a worker will fail later with
// a credential error — that is fine: what we assert here is the POLICY layer
// (tier chosen / rejection code), which happens before any LLM call.
// Usage: node scripts/live-policy-matrix.mjs

import { tmpdir } from 'node:os';
import { join } from 'node:path';
const BASE = 'http://127.0.0.1:3080/_dsh/dsh-crew';
const CWD = 'D:/Users/48376/Desktop';

let passed = 0, failed = 0;
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

async function setConfig(patch) {
  const res = await fetch(`${BASE}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`config write failed: ${JSON.stringify(body)}`);
  return body.config;
}

async function getConfig() {
  const res = await fetch(`${BASE}/config`);
  return (await res.json()).config;
}

async function spawn(body) {
  const res = await fetch(`${BASE}/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: CWD, ...body }),
  });
  return res.json();
}

// Baseline: record the pre-test config so the caller can restore it.
const baseline = await getConfig();
console.log('baseline config:', JSON.stringify({ collaboration_mode: baseline.collaboration_mode, flash_state: baseline.flash_state, pro_state: baseline.pro_state, subagents_enabled: baseline.subagents_enabled, vision_enabled: baseline.vision_enabled, imagegen_enabled: baseline.imagegen_enabled }));
await import('node:fs').then(({ writeFileSync }) => writeFileSync(join(tmpdir(), 'dsh-crew-live-baseline.json'), JSON.stringify(baseline)));

// ---------- Test A: Subagents OFF ----------
await setConfig({ subagents_enabled: false, collaboration_mode: 'balanced' });
{
  const r = await spawn({ task: 't', tier: 'flash' });
  check('A1: Subagents OFF blocks flash dispatch', r.ok === false && r.code === 'SUBAGENTS_DISABLED', r.error ?? '');
  const r2 = await spawn({ task: 't' });
  check('A2: Subagents OFF blocks default dispatch too', r2.ok === false && r2.code === 'SUBAGENTS_DISABLED', r2.error ?? '');
}

// ---------- Test B/C: Flash Only ----------
await setConfig({ subagents_enabled: true, collaboration_mode: 'flash-only' });
{
  const r = await spawn({ task: 't' });
  check('B1: Flash Only + missing tier spawns flash', r.ok === true && r.job.tier === 'flash', r.ok ? `tier=${r.job.tier}` : r.error);
  const r2 = await spawn({ task: 't', tier: 'pro' });
  check('C1: Flash Only + explicit pro rejected TIER_DISABLED', r2.ok === false && r2.code === 'TIER_DISABLED', r2.error ?? '');
}

// ---------- Test D/E: Pro Only ----------
await setConfig({ collaboration_mode: 'pro-only' });
{
  const r = await spawn({ task: 't' });
  check('D1: Pro Only + missing tier spawns pro (resolved-tier regression)', r.ok === true && r.job.tier === 'pro', r.ok ? `tier=${r.job.tier}` : r.error);
  const r2 = await spawn({ task: 't', tier: 'flash' });
  check('E1: Pro Only + explicit flash rejected TIER_DISABLED', r2.ok === false && r2.code === 'TIER_DISABLED', r2.error ?? '');
}

// ---------- Test F: Balanced ----------
await setConfig({ collaboration_mode: 'balanced', flash_state: 'auto', pro_state: 'auto' });
{
  const r = await spawn({ task: 't' });
  check('F1: Balanced + missing tier uses default (flash)', r.ok === true && r.job.tier === 'flash', r.ok ? `tier=${r.job.tier}` : r.error);
  const r2 = await spawn({ task: 't', tier: 'pro' });
  check('F2: Balanced + explicit pro allowed', r2.ok === true && r2.job.tier === 'pro', r2.ok ? `tier=${r2.job.tier}` : r2.error);
}

// ---------- Test G: Manual semantics ----------
await setConfig({ collaboration_mode: 'custom', flash_state: 'auto', pro_state: 'manual' });
{
  const r = await spawn({ task: 't' });
  check('G1: Custom flash=auto/pro=manual + no tier → flash (manual not auto-default)', r.ok === true && r.job.tier === 'flash', r.ok ? `tier=${r.job.tier}` : r.error);
  const r2 = await spawn({ task: 't', tier: 'pro' });
  check('G2: Custom + explicit pro allowed (manual is callable when named)', r2.ok === true && r2.job.tier === 'pro', r2.ok ? `tier=${r2.job.tier}` : r2.error);
}

// ---------- Test H: both disabled ----------
await setConfig({ collaboration_mode: 'custom', flash_state: 'disabled', pro_state: 'disabled' });
{
  const r = await spawn({ task: 't' });
  check('H1: both disabled → NO_WORKER_TIER (no fallback)', r.ok === false && r.code === 'NO_WORKER_TIER', r.error ?? '');
  const r2 = await spawn({ task: 't', tier: 'flash' });
  check('H2: both disabled + explicit flash still rejected', r2.ok === false && r2.code === 'TIER_DISABLED', r2.error ?? '');
}

// ---------- Test I: Review Pipeline config semantics ----------
await setConfig({ collaboration_mode: 'review-pipeline' });
{
  const c = await getConfig();
  // The hub config GET is the raw editable source for the Settings page
  // (pro_reviews_flash stays false on disk); the EFFECTIVE review decision is
  // derived at the policy layer (MCP dsh_worker_config returns it as true).
  check('I1: review-pipeline keeps raw pro_reviews_flash on disk', c.pro_reviews_flash === false, `raw=${c.pro_reviews_flash}`);
  const { normalizeGlobalConfig, shouldRunProReview } = await import('../src/policy.mjs');
  const eff = shouldRunProReview(normalizeGlobalConfig(c));
  check('I1b: review-pipeline effective pro_reviews_flash=true (policy layer)', eff === true, `effective=${eff}`);
  const r = await spawn({ task: 't' });
  check('I2: review-pipeline default tier flash', r.ok === true && r.job.tier === 'flash', r.ok ? `tier=${r.job.tier}` : r.error);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
