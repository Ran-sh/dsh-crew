// Live policy acceptance matrix against a Crew-owned dsh-crew Hub (loopback
// API). Targets the dedicated Crew Hub (DSH_CREW_HUB env or default
// http://127.0.0.1:3210); it never targets or mutates the official web profile.
//
// Safety guarantees:
//  - the worker cwd is always an auto-created temp fixture under os.tmpdir()
//    (never a real user path — no hardcoded Desktop/Users paths);
//  - the pre-test Crew config is snapshotted and restored in a try/finally, so
//    the matrix can never leave the DSH policy in a test state, even on error;
//  - if there was no ~/.config/dsh-crew/config.json before the run, that
//    absence cannot be recreated through the public API (the config route only
//    merges), so the script reports it instead of pretending.
//
// The helpers (createLiveFixture / withBaselineRestore / configFileExists) are
// exported and unit-tested in test/live-policy-matrix.test.mjs.
//
// Usage: node scripts/live-policy-matrix.mjs

import os from 'node:os';
import path from 'node:path';
import fs, { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const BASE = (process.env.DSH_CREW_HUB ?? 'http://127.0.0.1:3210').replace(/\/$/, '') + '/_dsh/dsh-crew';
const CREW_CONFIG = () => path.join(homedir(), '.config', 'dsh-crew', 'config.json');

/** True when the global config file exists on disk before the run. */
export function configFileExists(configPath = CREW_CONFIG()) {
  return existsSync(configPath);
}

/** Create a throwaway fixture dir under os.tmpdir() with minimal safe files. */
export async function createLiveFixture(opts = {}) {
  const prefix = opts.prefix ?? 'dsh-crew-live-acceptance-';
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-crew-live-fixture', private: true, type: 'module' }, null, 2) + '\n');
  writeFileSync(path.join(src, 'math.js'), 'export function add(a, b) { return a + b; }\n');
  writeFileSync(path.join(dir, 'README.md'), '# dsh-crew live acceptance fixture\n');
  return dir;
}

/** Remove a fixture dir created by createLiveFixture. */
export function removeLiveFixture(dir) {
  if (dir && dir.startsWith(os.tmpdir())) rmSync(dir, { recursive: true, force: true });
}

/**
 * Snapshot the current config, run fn(), then restore the snapshot —
 * always, even when fn() throws. Returns fn()'s value or rethrows.
 */
export async function withBaselineRestore(getConfig, setConfig, fn) {
  const baseline = await getConfig();
  try {
    return await fn();
  } finally {
    try { await setConfig(baseline); } catch (err) { console.error('LIVE MATRIX: baseline restore failed —', err?.message ?? err); }
  }
}

async function getConfig() {
  const res = await fetch(`${BASE}/config`);
  const body = await res.json();
  if (!body.ok) throw new Error(`config GET failed: ${JSON.stringify(body)}`);
  return body.config;
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

async function spawn(body) {
  const res = await fetch(`${BASE}/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  let passed = 0, failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    ok ? passed++ : failed++;
  };

  const fixture = await createLiveFixture();
  const CWD = fixture;
  const hadConfig = configFileExists();
  console.log(`fixture: ${CWD} (exists=${existsSync(CWD)})`);
  console.log(`config file existed before run: ${hadConfig}`);

  await withBaselineRestore(getConfig, setConfig, async () => {
    // ---------- Test A: Subagents OFF ----------
    await setConfig({ subagents_enabled: false, collaboration_mode: 'balanced' });
    {
      const r = await spawn({ task: 't', tier: 'flash', cwd: CWD });
      check('A1: Subagents OFF blocks flash dispatch', r.ok === false && r.code === 'SUBAGENTS_DISABLED', r.error ?? '');
      const r2 = await spawn({ task: 't', cwd: CWD });
      check('A2: Subagents OFF blocks default dispatch too', r2.ok === false && r2.code === 'SUBAGENTS_DISABLED', r2.error ?? '');
    }

    // ---------- Test B/C: Flash Only ----------
    await setConfig({ subagents_enabled: true, collaboration_mode: 'flash-only' });
    {
      const r = await spawn({ task: 't', cwd: CWD });
      check('B1: Flash Only + missing tier spawns flash', r.ok === true && r.job.tier === 'flash', r.ok ? `tier=${r.job.tier}` : r.error);
      const r2 = await spawn({ task: 't', tier: 'pro', cwd: CWD });
      check('C1: Flash Only + explicit pro rejected TIER_DISABLED', r2.ok === false && r2.code === 'TIER_DISABLED', r2.error ?? '');
    }

    // ---------- Test D/E: Pro Only ----------
    await setConfig({ collaboration_mode: 'pro-only' });
    {
      const r = await spawn({ task: 't', cwd: CWD });
      check('D1: Pro Only + missing tier spawns pro (resolved-tier regression)', r.ok === true && r.job.tier === 'pro', r.ok ? `tier=${r.job.tier}` : r.error);
      const r2 = await spawn({ task: 't', tier: 'flash', cwd: CWD });
      check('E1: Pro Only + explicit flash rejected TIER_DISABLED', r2.ok === false && r2.code === 'TIER_DISABLED', r2.error ?? '');
    }

    // ---------- Test F: Balanced ----------
    await setConfig({ collaboration_mode: 'balanced', flash_state: 'auto', pro_state: 'auto' });
    {
      const r = await spawn({ task: 't', cwd: CWD });
      check('F1: Balanced + missing tier uses default (flash)', r.ok === true && r.job.tier === 'flash', r.ok ? `tier=${r.job.tier}` : r.error);
      const r2 = await spawn({ task: 't', tier: 'pro', cwd: CWD });
      check('F2: Balanced + explicit pro allowed', r2.ok === true && r2.job.tier === 'pro', r2.ok ? `tier=${r2.job.tier}` : r2.error);
    }

    // ---------- Test G: Manual semantics ----------
    await setConfig({ collaboration_mode: 'custom', flash_state: 'auto', pro_state: 'manual' });
    {
      const r = await spawn({ task: 't', cwd: CWD });
      check('G1: Custom flash=auto/pro=manual + no tier → flash (manual not auto-default)', r.ok === true && r.job.tier === 'flash', r.ok ? `tier=${r.job.tier}` : r.error);
      const r2 = await spawn({ task: 't', tier: 'pro', cwd: CWD });
      check('G2: Custom + explicit pro allowed (manual is callable when named)', r2.ok === true && r2.job.tier === 'pro', r2.ok ? `tier=${r2.job.tier}` : r2.error);
    }

    // ---------- Test H: both disabled ----------
    await setConfig({ collaboration_mode: 'custom', flash_state: 'disabled', pro_state: 'disabled' });
    {
      const r = await spawn({ task: 't', cwd: CWD });
      check('H1: both disabled → NO_WORKER_TIER (no fallback)', r.ok === false && r.code === 'NO_WORKER_TIER', r.error ?? '');
      const r2 = await spawn({ task: 't', tier: 'flash', cwd: CWD });
      check('H2: both disabled + explicit flash still rejected', r2.ok === false && r2.code === 'TIER_DISABLED', r2.error ?? '');
    }

    // ---------- Test I: Review Pipeline config semantics ----------
    await setConfig({ collaboration_mode: 'review-pipeline' });
    {
      const c = await getConfig();
      check('I1: review-pipeline keeps raw pro_reviews_flash on disk', c.pro_reviews_flash === false, `raw=${c.pro_reviews_flash}`);
      const { normalizeGlobalConfig, shouldRunProReview } = await import('../src/policy.mjs');
      check('I1b: review-pipeline effective pro_reviews_flash=true (policy layer)', shouldRunProReview(normalizeGlobalConfig(c)) === true);
      const r = await spawn({ task: 't', cwd: CWD });
      check('I2: review-pipeline default tier flash', r.ok === true && r.job.tier === 'flash', r.ok ? `tier=${r.job.tier}` : r.error);
    }
  });

  removeLiveFixture(fixture);
  const restored = await getConfig();
  console.log(`\nrestore check: mode=${restored.collaboration_mode} flash=${restored.flash_state} pro=${restored.pro_state} subagents=${restored.subagents_enabled}`);
  if (!hadConfig && configFileExists()) {
    console.log('NOTE: ~/.config/dsh-crew/config.json was absent before this run; the public API cannot delete it, so the file remains (values were reset to the pre-test snapshot).');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
