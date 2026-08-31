import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

test('fork package identity is consistent across manifest, Cordis, and client artifact', () => {
  const manifest = JSON.parse(read('package.json'));
  const cordis = read('cordis.patch.yml');
  const client = read('lib/client.js');

  assert.equal(manifest.name, '@ran-sh/dsh-crew');
  assert.equal(manifest.repository?.url, 'git+https://github.com/Ran-sh/dsh-crew.git');
  assert.equal(manifest.homepage, 'https://github.com/Ran-sh/dsh-crew');
  assert.equal(manifest.bugs?.url, 'https://github.com/Ran-sh/dsh-crew/issues');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.dependencies?.['@modelcontextprotocol/sdk'], '^1.25.4');
  assert.equal('publishConfig' in manifest, false);
  for (const lifecycle of ['prepare', 'preinstall', 'postinstall', 'preuninstall', 'postuninstall']) {
    assert.equal(lifecycle in (manifest.scripts ?? {}), false, `${lifecycle} must not mutate host state`);
  }
  assert.ok(manifest.files.includes('windows'), 'Windows login-start assets must ship');
  assert.ok(manifest.files.includes('codex'), 'global Codex policy template must ship');
  assert.ok(manifest.files.includes('zcode'), 'ZCode policy/agent templates must ship');
  assert.match(read('codex/AGENTS.md'), /Global capability-aware delegation policy/);
  assert.match(read('zcode/AGENTS.md'), /Global capability-aware delegation policy for ZCode/);
  const launcher = read('windows/start-dsh-crew.cmd');
  const helper = read('windows/start-dsh-crew.ps1');
  const startup = read('windows/start-dsh-crew.vbs');
  assert.match(launcher, /start-dsh-crew\.ps1/);
  assert.match(launcher, /%\*/);
  const directoryCapture = launcher.indexOf('set "LAUNCH_DIR=%~dp0"');
  const firstShift = launcher.indexOf('shift');
  assert.ok(directoryCapture >= 0 && directoryCapture < firstShift, 'launcher directory must be captured before shifting arguments');
  assert.match(launcher, /%LAUNCH_DIR%start-dsh-crew\.ps1/);
  assert.match(helper, /127\.0\.0\.1:3210/);
  assert.match(helper, /127\.0\.0\.1:3080/);
  assert.match(helper, /ValidateSet\(['"]background['"],\s*['"]open['"],\s*['"]watch['"]\)/);
  assert.match(helper, /RedirectStandardOutput/);
  assert.match(helper, /RedirectStandardError/);
  assert.match(helper, /IPGlobalProperties/);
  assert.doesNotMatch(helper, /BeginConnect|TcpClient/);
  assert.match(helper, /dsh-crew-launcher\.log/);
  assert.match(helper, /System\.Threading\.Mutex/);
  assert.match(helper, /DSHCrewServiceSupervisor/);
  assert.match(helper, /Supervisor (?:active|recovery)/);
  assert.match(helper, /while \(\$true\)/);
  assert.match(helper, /RootPid/);
  assert.match(helper, /Get-TrackedProcessTree/);
  assert.match(helper, /owned listener/i);
  assert.match(helper, /Stop-Process/);
  assert.match(helper, /ConsecutiveFailures/);
  assert.match(helper, /ConsecutiveFailures -lt 3/);
  assert.match(helper, /consecutive failed health checks/i);
  assert.match(helper, /ManagedByBridge/);
  assert.match(helper, /Start-BridgedCrewService/);
  assert.equal((helper.match(/@\(\$services \| Where-Object State -eq 'starting'\)\.Count/g) ?? []).length, 3);
  assert.doesNotMatch(helper, /(?:while|if) \(\(\$services \| Where-Object State -eq 'starting'\)\.Count/);
  assert.match(startup, /__LAUNCHER__/);
  assert.match(startup, /--watch/);

  assert.match(cordis, new RegExp(`name: ['"]${manifest.name.replace('/', '\\/')}['"]`));
  assert.match(client, new RegExp(`ModuleLoader__\\.load\\(\\{ id: ["']${manifest.name.replace('/', '\\/')}["']`));
});

test('primary documentation uses the supported isolated source workflow', () => {
  const clone = 'git clone https://github.com/Ran-sh/dsh-crew.git';
  const install = 'node scripts/setup.mjs install';
  const uninstall = 'node scripts/setup.mjs uninstall';
  const legacyWebAdd = 'npx -y @deepseek-ai/dsh plugin --profile web add github:Ran-sh/dsh-crew';

  for (const file of ['README.md', 'README.zh.md']) {
    const doc = read(file);
    assert.match(doc, new RegExp(clone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(doc, new RegExp(install.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(doc, new RegExp(uninstall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(doc, /~\/\.config\/dsh-crew\/harness/);
    assert.match(doc, /profile:\s*dsh-crew/);
    assert.match(doc, /official [`']?web[`']? profile|官方 [`']?web[`']? profile/);
    assert.doesNotMatch(doc, new RegExp(legacyWebAdd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('package ships a lightweight official-web bridge instead of loading the full Hub into 3080', () => {
  const manifest = JSON.parse(read('package.json'));
  const bridge = JSON.parse(read('official-web-bridge/package.json'));
  const bridgePatch = read('official-web-bridge/cordis.patch.yml');
  const bridgeClient = read('official-web-bridge/lib/client.js');
  const bridgeEntry = read('official-web-bridge/entry.mjs');

  assert.ok(manifest.files.includes('official-web-bridge'));
  assert.equal(bridge.name, '@ran-sh/dsh-crew-web-bridge');
  assert.equal(bridge.main, './entry.mjs');
  assert.equal(bridge.exports?.['.'], './entry.mjs');
  assert.equal(bridge.exports?.['./client'], './lib/client.js');
  assert.notEqual(bridge.main, '../src/hub/entry.mjs');
  assert.match(bridgePatch, /@ran-sh\/dsh-crew-web-bridge/);
  assert.match(bridgeClient, /ModuleLoader__\.load\(\{ id: ["']@ran-sh\/dsh-crew-web-bridge["']/);
  assert.match(bridgeEntry, /official-web-bridge\.mjs/);
});

test('production dispatch is 3210-only and the control UI does not offer standalone execution', () => {
  const server = read('src/server.mjs');
  const client = read('src/client/index.tsx');
  assert.match(server, /resolveHubExecutionMode\(sessionConfig\.mode, status, \{ productionOnly: true \}\)/);
  assert.doesNotMatch(client, /\['auto', 'hub', 'standalone'\]/);
});

test('control UI labels legacy standalone metadata without implying a production route', () => {
  const client = read('src/client/index.tsx');
  assert.doesNotMatch(client, /Standalone (?:always uses|始终用)/i);
  assert.match(client, /legacy metadata|legacy migration metadata|旧版迁移元数据/i);
});

test('primary documentation states the legacy launcher migration boundary', () => {
  for (const file of ['README.md', 'README.zh.md']) {
    const doc = read(file);
    assert.match(doc, /(?:<=|≤)\s*0\.3\.3/);
    assert.match(doc, /npm install -g @ran-sh\/dsh-crew@latest[\s\S]*dsh-crew update/);
    assert.match(doc, /cannot (?:be retroactively fixed|discover newer)|无法(?:被追溯修复|发现更新)/i);
  }
});

test('translated READMEs do not advertise the upstream npm package as this fork', () => {
  const start = 'npx -y @deepseek-ai/dsh web';
  const translated = readdirSync(ROOT).filter((file) => /^README\..+\.md$/.test(file) && file !== 'README.zh.md');
  assert.ok(translated.length > 0);
  for (const file of translated) {
    const doc = read(file);
    const installSection = doc.split(/\r?\n/).slice(0, 150).join('\n');
    assert.doesNotMatch(doc, /npm:\s*<code>@zseven-w\/dsh-crew<\/code>/, file);
    assert.doesNotMatch(doc, /dsh plugin --profile web add @zseven-w\/dsh-crew@latest/, file);
    assert.doesNotMatch(doc, /^dsh (?:web|plugin )/m, file);
    assert.doesNotMatch(installSection, /\bnpm\b/i, file);
    assert.match(doc, /github:Ran-sh\/dsh-crew/, file);
    assert.match(doc, new RegExp(start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), file);
  }
});
