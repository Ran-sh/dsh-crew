import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const buildScript = await readFile(new URL('../scripts/build-client.mjs', import.meta.url), 'utf8');
const entrySource = await readFile(new URL('../src/client/entry.tsx', import.meta.url), 'utf8');
const panelSource = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8');

test('client build uses the activation wrapper entry', () => {
  assert.match(packageJson.scripts?.['build:client'] ?? '', /tsdown src\/client\/entry\.tsx\b/);
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

test('shared client renders a full 3080 control plane and a minimal 3210 diagnostic surface', () => {
  assert.match(panelSource, /classifyCrewSurface/);
  assert.match(panelSource, /surfaceResponsibilities/);
  assert.match(panelSource, /<MinimalCrewPanel\b/);
  assert.match(panelSource, /fullControlPlane/);
  assert.match(panelSource, /http:\/\/127\.0\.0\.1:3080\/?/);
});

test('3080 readiness matrix names every required host integration', () => {
  for (const label of ['Codex MCP', 'ds-worker', 'ds-reviewer', 'Claude plugin', 'ZCode MCP', 'Crew Harness', 'Official bridge']) {
    assert.match(panelSource, new RegExp(label));
  }
});
