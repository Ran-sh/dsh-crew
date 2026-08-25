// Real, disposable official-UI acceptance for the 3080 -> isolated 3210 bridge.
// It never edits the user's official profile or Crew installation.

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npxInstall, npxIntegrate } from '../src/install/npx-lifecycle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidateVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (typeof candidateVersion !== 'string' || candidateVersion === '') throw new Error('candidate package version is unavailable');
const realHome = homedir();
const runtimeRoot = join(realHome, '.config', 'dsh-crew', 'harness', 'runtime');
const runtimeModule = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (!existsSync(runtimeModule)) throw new Error('real Crew DSH runtime is not installed');

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-crew-official-e2e-'));
const officialHome = join(sandbox, '.dsh');
const crewRoot = join(sandbox, '.config', 'dsh-crew');
const harnessHome = join(crewRoot, 'harness');
const profileRoot = join(officialHome, 'profiles', 'web');
const logs = [];
let official;

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

const officialPort = await reservePort();
const crewPort = await reservePort();
const officialUrl = `http://127.0.0.1:${officialPort}`;
const crewUrl = `http://127.0.0.1:${crewPort}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(url, { timeout = 30_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response;
      last = `HTTP ${response.status}`;
    } catch (error) { last = error?.message ?? String(error); }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${last}`);
}

async function waitForPageMarker(url, marker, { timeout = 30_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const body = await response.text();
      if (response.ok && body.includes(marker)) return body;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`timed out waiting for ${marker} in ${url}`);
}

function stopOwnedProcesses() {
  if (process.platform !== 'win32') return;
  const escaped = sandbox.replace(/'/g, "''");
  const command = [
    `$sandbox = '${escaped}'`,
    "$processes = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
    'foreach ($process in $processes) {',
    '  if ($process.CommandLine -and $process.CommandLine.Contains($sandbox)) { Stop-Process -Id $process.ProcessId -Force }',
    '}',
  ].join('; ');
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
}

try {
  mkdirSync(profileRoot, { recursive: true });
  writeFileSync(join(profileRoot, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2));
  writeFileSync(join(profileRoot, 'cordis.patch.yml'), '[]\n');
  writeFileSync(join(profileRoot, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');

  const currentConfig = join(realHome, '.config', 'dsh-crew', 'config.json');
  let sandboxConfig = {};
  if (existsSync(currentConfig)) {
    mkdirSync(crewRoot, { recursive: true });
    sandboxConfig = JSON.parse(readFileSync(currentConfig, 'utf8'));
  }
  mkdirSync(crewRoot, { recursive: true });
  writeFileSync(join(crewRoot, 'config.json'), JSON.stringify({ ...sandboxConfig, hub_url: crewUrl }, null, 2));

  const installer = {
    installCodex: () => ({ ok: true, actions: [] }),
    installClaudeCode: async () => ({ ok: true, actions: [] }),
    installStatus: () => ({ codex: { installed: true }, claude: { installed: true } }),
  };
  const installed = await npxInstall({
    home: sandbox,
    sourceRoot: root,
    installer,
    log: (line) => logs.push(line),
    ensureRuntime: async () => {
      const target = join(harnessHome, 'runtime');
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(realpathSync(runtimeRoot), target, process.platform === 'win32' ? 'junction' : 'dir');
      return { ok: true, version: '0.1.1-rc.2' };
    },
  });
  assert(installed.ok, `disposable install failed: ${logs.join(' | ')}`);
  const integrated = await npxIntegrate({ home: sandbox, log: (line) => logs.push(line) });
  assert(integrated.ok, `disposable integrate failed: ${logs.join(' | ')}`);

  official = spawn(process.execPath, [
    runtimeModule, '--profile', 'web', '--host', '127.0.0.1', '--port', String(officialPort), '--no-open',
  ], {
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, DSH_HOME: officialHome, DSH_CREW_BRIDGE_TARGET: crewUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const capture = (chunk) => { if (logs.join('\n').length < 20_000) logs.push(String(chunk)); };
  official.stdout.on('data', capture);
  official.stderr.on('data', capture);

  await waitForPageMarker(`${officialUrl}/`, '@ran-sh/dsh-crew-web-bridge');
  const bridgeStatus = await (await waitFor(`${officialUrl}/_dsh/dsh-crew/bridge-status`)).json();
  assert(bridgeStatus.mode === 'official-3080-isolated-3210', 'bridge status mode mismatch');
  const proxiedRuntime = await (await waitFor(`${officialUrl}/_dsh/dsh-crew/runtime`, { timeout: 45_000 })).json();
  assert(proxiedRuntime.runtime_version === candidateVersion, `proxied runtime version mismatch (${proxiedRuntime.runtime_version} != ${candidateVersion})`);
  const directRuntime = await (await waitFor(`${crewUrl}/_dsh/dsh-crew/runtime`)).json();
  assert(directRuntime.runtime_version === candidateVersion, `direct runtime version mismatch (${directRuntime.runtime_version} != ${candidateVersion})`);
  const models = await (await waitFor(`${officialUrl}/_dsh/dsh-crew/models`)).json();
  assert(Array.isArray(models.providers), 'proxied model catalog missing providers');

  console.log(JSON.stringify({
    ok: true,
    official_ui: officialUrl,
    isolated_backend: crewUrl,
    runtime_version: proxiedRuntime.runtime_version,
    provider_count: models.providers.length,
    official_profile: profileRoot,
    crew_home: harnessHome,
  }));
} catch (error) {
  console.error(`OFFICIAL_BRIDGE_E2E_FAIL=${error?.message ?? error}`);
  console.error(logs.join('\n').slice(-8_000));
  process.exitCode = 1;
} finally {
  if (official && official.exitCode === null) official.kill();
  stopOwnedProcesses();
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  const resolvedSandbox = resolve(sandbox);
  assert(resolvedSandbox.startsWith(resolve(tmpdir())), 'refusing to remove non-temp sandbox');
  if (process.env.DSH_CREW_E2E_KEEP === '1') console.error(`OFFICIAL_BRIDGE_E2E_SANDBOX=${resolvedSandbox}`);
  else rmSync(resolvedSandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
