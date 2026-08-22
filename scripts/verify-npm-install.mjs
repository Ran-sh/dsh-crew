#!/usr/bin/env node

// Regression gate for the published-package peer contract.
// This intentionally uses npm's default resolver: no peer-resolution bypass
// or equivalent override is permitted here.
//
// The candidate itself is materially installed from its packed tarball. The
// official DSH coexistence check is resolver-only (`--package-lock-only`) so
// npm must accept the complete peer graph without expanding the very large DSH
// dependency tree onto disk.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const registry = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org/';
const candidateVersion = '0.3.1';
const supportedDshVersion = '0.1.1-rc.2';
const verifyOfficialDsh = process.argv.includes('--with-official-dsh');

function run(args, cwd = root) {
  const result = spawnSync(npmCommand, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function fail(label, result) {
  const detail = `${result.stdout}\n${result.stderr}`.trim().replace(/\s+/g, ' ').slice(0, 800);
  throw new Error(`${label} failed (exit ${result.status}): ${detail}`);
}

async function assertInstalled(prefix, label) {
  const packageRoot = path.join(prefix, 'node_modules', '@ran-sh', 'dsh-crew');
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const runtimeSource = await readFile(path.join(packageRoot, 'src', 'runtime-identity.mjs'), 'utf8');
  const runtimeVersion = runtimeSource.match(/RUNTIME_VERSION\s*=\s*'([^']+)'/)?.[1];
  const entryExists = await readFile(path.join(packageRoot, 'src', 'hub', 'entry.mjs')).then(() => true, () => false);
  const clientExists = await readFile(path.join(packageRoot, 'lib', 'client.js')).then(() => true, () => false);
  if (packageJson.version !== candidateVersion || runtimeVersion !== candidateVersion || !entryExists || !clientExists) {
    throw new Error(`${label} did not install the expected ${candidateVersion} package/runtime entries`);
  }
}

async function assertOfficialResolution(prefix) {
  const lock = JSON.parse(await readFile(path.join(prefix, 'package-lock.json'), 'utf8'));
  const packages = lock.packages ?? {};
  const crew = packages['node_modules/@ran-sh/dsh-crew'];
  const dsh = packages['node_modules/@deepseek-ai/dsh'];

  if (crew?.version !== candidateVersion) {
    throw new Error(`official DSH resolver gate did not lock @ran-sh/dsh-crew@${candidateVersion}`);
  }
  if (dsh?.version !== supportedDshVersion) {
    throw new Error(`official DSH resolver gate did not lock @deepseek-ai/dsh@${supportedDshVersion}`);
  }
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-crew-v031-install-'));
const paths = {
  pack: await mkdtemp(path.join(tempRoot, 'pack-')),
  standalone: await mkdtemp(path.join(tempRoot, 'standalone-')),
  host: await mkdtemp(path.join(tempRoot, 'official-host-')),
};

try {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (packageJson.version !== candidateVersion) throw new Error(`package.json must be ${candidateVersion}`);

  const packed = run(['pack', '--json', '--pack-destination', paths.pack]);
  if (packed.status !== 0) fail('npm pack', packed);
  const packInfo = JSON.parse(packed.stdout)[0];
  const tarball = path.join(paths.pack, packInfo.filename);

  const standalone = run([
    'install', '--prefix', paths.standalone, '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry', registry, tarball,
  ]);
  if (standalone.status !== 0) fail('plain npm candidate install', standalone);
  await assertInstalled(paths.standalone, 'standalone candidate');

  if (verifyOfficialDsh) {
    await writeFile(path.join(paths.host, 'package.json'), `${JSON.stringify({
      name: 'dsh-crew-v031-official-resolver-gate',
      version: '0.0.0',
      private: true,
    }, null, 2)}\n`);

    const withOfficialHost = run([
      'install', '--prefix', paths.host, '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund',
      '--registry', registry, `@deepseek-ai/dsh@${supportedDshVersion}`, tarball,
    ]);
    if (withOfficialHost.status !== 0) fail('default npm resolver candidate + official DSH', withOfficialHost);
    await assertOfficialResolution(paths.host);
  }

  console.log(`NPM_INSTALL_CONTRACT=PASS candidate=${candidateVersion} official_dsh=${verifyOfficialDsh ? `${supportedDshVersion}:resolver-lock` : 'not-run'}`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
