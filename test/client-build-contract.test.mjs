import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const buildScript = await readFile(new URL('../scripts/build-client.mjs', import.meta.url), 'utf8');
const setupSource = await readFile(new URL('../scripts/setup.mjs', import.meta.url), 'utf8');
const entrySource = await readFile(new URL('../src/client/entry.tsx', import.meta.url), 'utf8');
const panelSource = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8');

test('client build uses the activation wrapper entry', () => {
  assert.match(packageJson.scripts?.['build:client'] ?? '', /tsdown src\/client\/entry\.tsx\b/);
  assert.match(setupSource, /run\(['"]pnpm['"],\s*\[['"]run['"],\s*['"]build:client['"]\]/);
  assert.doesNotMatch(setupSource, /tsdown src\/client\/index\.tsx/);
});

test('client build does not pass invalid options to rolldown', () => {
  const result = spawnSync('pnpm run build:client', {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    timeout: 30_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  assert.equal(result.error, undefined, String(result.error ?? output));
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /Invalid input options|Expected never but received "define"/i);
});

test('client wrapper resolves the emitted cjs artifact instead of hard-coding index.cjs', () => {
  assert.match(buildScript, /readdir\(buildDir\)/);
  assert.match(buildScript, /endsWith\('\.cjs'\)/);
  assert.doesNotMatch(buildScript, /\.client-build['"],\s*['"]index\.cjs/);
});

test('3080 exposes one consolidated DSH Crew settings entry', () => {
  assert.doesNotMatch(entrySource, /dsh-crew-adaptive-routing|dsh-crew-runtime-controls/);
  assert.match(panelSource, /id: ['"]dsh-crew['"]/);
  assert.match(panelSource, /sectionId=["']adaptive["']/);
  assert.match(panelSource, /<ActivationSummary\b/);
});

test('daily console links explicitly to the isolated Crew Harness', () => {
  assert.match(panelSource, /http:\/\/127\.0\.0\.1:3210\/?/);
  assert.match(panelSource, /target=["']_blank["']/);
  assert.match(panelSource, /noopener noreferrer/);
});

test('failed settings saves are surfaced and refresh the authoritative config', () => {
  assert.match(panelSource, /catch \(error: any\)/);
  assert.match(panelSource, /setNotice\(String\(error\?\.message \?\? error\)\)/);
  assert.match(panelSource, /get\('\/config'\)/);
});

test('model activity table exposes complete ARIA table semantics', () => {
  for (const role of ['table', 'row', 'columnheader', 'cell']) {
    assert.match(panelSource, new RegExp(`role=["']${role}["']`));
  }
});

test('task status uses the compact table layout instead of stacked list cards', () => {
  assert.match(panelSource, /<table\b/);
  assert.match(panelSource, /copy\.col\.role/);
  assert.match(panelSource, /copy\.col\.model/);
  assert.doesNotMatch(panelSource, /role=["']listitem["']/);
});

test('provider lifecycle UI distinguishes Harness providers from multimodal adapters', () => {
  assert.match(panelSource, /get\('\/providers'\)/);
  assert.match(panelSource, /credential-references/);
  assert.match(panelSource, /credentialRefs/);
  assert.match(panelSource, /sectionId=["']harnessProviders["']/);
  assert.match(panelSource, /delete-plan/);
  assert.match(panelSource, /runtime\/restart-request/);
  assert.match(panelSource, /runtime\/restart-status/);
  assert.doesNotMatch(panelSource, /127\.0\.0\.1:3080\/_dsh\/dsh-crew\/supervisor\/restart/);
  assert.match(panelSource, /verify-delete/);
  assert.match(panelSource, /migrate-plan/);
  assert.match(panelSource, /verify-migration/);
  assert.match(panelSource, /rollback-migration/);
  assert.match(panelSource, /delete_capability/);
  assert.doesNotMatch(panelSource, /ownership === ['"]harness['"]|ownership !== ['"]harness['"]/);
  assert.match(panelSource, /deepseek-official/);
  assert.match(panelSource, /providerDeletePending/);
  assert.match(panelSource, /await refreshProviderInventory\(\)/);
  assert.match(panelSource, /ROLLBACK_PENDING/);
  assert.match(panelSource, /filter\(\(entry: any\) => entry\.provider_id === record\.id/);
  assert.match(panelSource, /recovery_transactions/);
  assert.match(panelSource, /recoveryUnresolved/);
  assert.match(panelSource, /providers\/_recovery\/quarantine/);
  assert.match(panelSource, /storage_id/);
  assert.match(panelSource, /action_id/);
  assert.match(panelSource, /ROLLBACK_RESTART_PENDING/);
  assert.match(panelSource, /ROLLBACK_APPLYING/);
  assert.match(panelSource, /Harness Providers|Harness Provider/);
  assert.match(panelSource, /Multimodal adapters|多模态适配器/);
});

test('provider lifecycle UI exposes rollback from backend transaction state', () => {
  assert.match(panelSource, /lifecycle_transactions/);
  assert.match(panelSource, /verify-rollback/);
  assert.match(panelSource, /providerRollback|rollbackProvider/);
  assert.match(panelSource, /rollbackHarnessMigration/);
});

test('credential lifecycle UI keeps purge separate from provider deletion', () => {
  assert.match(panelSource, /credentialPurgePlan/);
  assert.match(panelSource, /credentialPurgeConfirm/);
  assert.match(panelSource, /credentialLifecycleBusy/);
  assert.match(panelSource, /credential-references\/\$\{encoded\}\/purge-plan/);
  assert.match(panelSource, /method: 'DELETE'/);
  assert.match(panelSource, /purge_capability === 'eligible'/);
  assert.match(panelSource, /credentialUnverified/);
  assert.match(panelSource, /credentialPurgeUnverified/);
});

test('role-first routing UI exposes ordering, health gates, and reviewer gate', () => {
  assert.match(panelSource, /ordering: v/);
  assert.match(panelSource, /health_gate: v/);
  assert.match(panelSource, /reviewField\(\{ gate: v \}\)/);
  assert.match(panelSource, /health-aware/);
  assert.match(panelSource, /required.*optional.*off/s);
  assert.match(panelSource, /ordering = next\.enabled \? 'health-aware' : 'manual'/);
  assert.match(panelSource, /enabled: patch\.ordering === 'health-aware'/);
});

test('model priority rows render fresh provider health without treating catalog presence as callable', () => {
  assert.match(panelSource, /get\('\/provider-health'\)/);
  assert.match(panelSource, /entry\.provider === ref\.provider && entry\.model === ref\.model && entry\.fresh === true/);
  assert.match(panelSource, /healthUnprobed/);
  assert.match(panelSource, /health\?\.state === 'callable'/);
  assert.match(panelSource, /get\('\/provider-health'\)\.catch\(\(\) => null\)/);
});

test('shared client renders a full 3080 control plane and a minimal 3210 diagnostic surface', () => {
  assert.match(panelSource, /classifyCrewSurface/);
  assert.match(panelSource, /surfaceResponsibilities/);
  assert.match(panelSource, /<MinimalCrewPanel\b/);
  assert.match(panelSource, /fullControlPlane/);
  assert.match(panelSource, /http:\/\/127\.0\.0\.1:3080\/?/);
});

test('client consumes the Hub extension readiness snapshot instead of recomputing Crew state', () => {
  assert.match(panelSource, /get\('\/extension'\)\.catch\(\(\) => null\)/);
  assert.match(panelSource, /setReadinessSnapshot\(ext\.extension\?\.readiness_snapshot/);
  assert.match(panelSource, /readinessSnapshot \}/);
});

test('3080 readiness matrix names every required host integration', () => {
  for (const label of ['Codex MCP', 'ds-worker', 'ds-reviewer', 'Claude plugin', 'ZCode MCP', 'Crew Harness', 'Official bridge']) {
    assert.match(panelSource, new RegExp(label));
  }
});

test('quick bundle is capability-light compared to the full bundle', async () => {
  const quick = await readFile(new URL('../official-web-bridge/lib/client.js', import.meta.url), 'utf8');
  const full = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  // Quick surface talks only to narrow endpoints.
  assert.match(quick, /quick-config/);
  assert.match(quick, /restart-request/);
  // Quick surface must NOT ship full control-plane capabilities.
  for (const forbidden of ['credentialPurgePlan', 'rollback-migration', 'quarantine', 'install/status', 'providerLifecycleError', 'delete-plan']) {
    assert.doesNotMatch(quick, new RegExp(forbidden));
  }
  // It must not hardcode the legacy 3080 supervisor endpoint either.
  assert.doesNotMatch(quick, /127\.0\.0\.1:3080\/_dsh\/dsh-crew\/supervisor\/restart/);
  // Full bundle keeps the complete control plane including quick API usage.
  assert.match(full, /credentialPurgePlan/);
  // Quick is genuinely smaller than full.
  assert.ok(quick.length < full.length / 5, `quick ${quick.length} vs full ${full.length}`);
});
