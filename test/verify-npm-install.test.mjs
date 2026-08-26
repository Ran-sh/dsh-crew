import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  auditOfficialDshCohort,
  satisfiesCohortRange,
  supportedDshVersion,
  readCandidateVersion,
  assertInstalled,
} from '../scripts/verify-npm-install.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const verifierSource = readFileSync(join(here, '..', 'scripts', 'verify-npm-install.mjs'), 'utf8');
const packageManifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const directPeerNames = [
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-agent-spine-demo',
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-fs-observation-policy',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-sdk-client',
  '@deepseek-ai/dsh-sdk-jsonrpc-demo',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-todo',
];

test('CLI package keeps host-provided peers optional for global npm installs', () => {
  const peerNames = Object.keys(packageManifest.peerDependencies ?? {});
  assert.ok(peerNames.length > 0, 'expected host peer dependencies');
  assert.deepEqual(
    peerNames.filter((name) => packageManifest.peerDependenciesMeta?.[name]?.optional !== true),
    [],
    'global CLI installs must not auto-install the Harness and React host dependency graph',
  );
});

test('npm install verifier never passes argument arrays through a shell', () => {
  assert.doesNotMatch(verifierSource, /shell:\s*process\.platform\s*===\s*['"]win32['"]/);
  assert.match(verifierSource, /process\.execPath/);
  assert.match(verifierSource, /npm-cli\.js/);
});

function candidateManifest(version = '0.3.2') {
  return {
    name: '@ran-sh/dsh-crew',
    version,
    peerDependencies: Object.fromEntries(directPeerNames.map((name) => [name, supportedDshVersion])),
  };
}

function manifestMap() {
  const manifests = new Map([
    ['@deepseek-ai/dsh', {
      name: '@deepseek-ai/dsh',
      version: supportedDshVersion,
      dependencies: { '@deepseek-ai/dsh-tool-fs': `^${supportedDshVersion}` },
    }],
  ]);
  for (const name of directPeerNames) {
    manifests.set(name, {
      name,
      version: supportedDshVersion,
      peerDependencies: { '@deepseek-ai/dsh-agent': `^${supportedDshVersion}` },
    });
  }
  return manifests;
}

function fetcherFrom(manifests) {
  return async (name) => manifests.get(name);
}

async function withTempRoot(packageJson, fn) {
  const rootDir = await mkdtemp(join(os.tmpdir(), 'dsh-crew-verify-test-'));
  try {
    await writeFile(join(rootDir, 'package.json'), JSON.stringify(packageJson));
    return await fn(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test('cohort range evaluator accepts the official rc.2 cohort and rejects rc.6', () => {
  assert.equal(satisfiesCohortRange(supportedDshVersion, '^0.1.1-rc.2'), true);
  assert.equal(satisfiesCohortRange(supportedDshVersion, '0.1.1-rc.2'), true);
  assert.equal(satisfiesCohortRange(supportedDshVersion, '0.1.0-rc.6'), false);
  assert.equal(satisfiesCohortRange(supportedDshVersion, '*'), false);
});

test('candidate version is derived from the manifest, not from a source constant', async () => {
  await withTempRoot({ name: '@ran-sh/dsh-crew', version: '0.3.2' }, async (rootDir) => {
    assert.equal(await readCandidateVersion({ rootDir }), '0.3.2');
  });
  await withTempRoot({ name: '@ran-sh/dsh-crew', version: '9.9.9' }, async (rootDir) => {
    assert.equal(await readCandidateVersion({ rootDir }), '9.9.9');
  });
  assert.match(verifierSource, /readCandidateVersion/);
  assert.doesNotMatch(verifierSource, /candidateVersion\s*=\s*'0\.3/);
  assert.doesNotMatch(verifierSource, /v031/);
});

test('official cohort audit passes with a 0.3.2 manifest matching the expected candidate version', async () => {
  const result = await auditOfficialDshCohort({
    candidateManifest: candidateManifest('0.3.2'),
    expectedCandidateVersion: '0.3.2',
    fetchManifest: fetcherFrom(manifestMap()),
  });

  assert.deepEqual(result, {
    marker: 'PASS',
    candidate: '0.3.2',
    officialDsh: supportedDshVersion,
    directPeerCount: 20,
    manifestCount: 21,
    crossCohortChecks: 21,
  });
});

test('official cohort audit fails closed when the manifest version mismatches the expected candidate version', async () => {
  await assert.rejects(
    auditOfficialDshCohort({
      candidateManifest: candidateManifest('0.3.2'),
      expectedCandidateVersion: '9.9.9',
      fetchManifest: fetcherFrom(manifestMap()),
    }),
    /package\.json must be 9\.9\.9/,
  );
  await assert.rejects(
    auditOfficialDshCohort({ candidateManifest: candidateManifest('0.3.2') }),
    /expectedCandidateVersion is required/,
  );
});

test('official cohort audit fails closed when a direct manifest is missing', async () => {
  const manifests = manifestMap();
  manifests.delete('@deepseek-ai/dsh-tool-todo');

  await assert.rejects(
    auditOfficialDshCohort({
      candidateManifest: candidateManifest('0.3.2'),
      expectedCandidateVersion: '0.3.2',
      fetchManifest: fetcherFrom(manifests),
    }),
    /invalid registry manifest/,
  );
});

test('official cohort audit fails closed on an incompatible cross-cohort peer range', async () => {
  const manifests = manifestMap();
  manifests.get('@deepseek-ai/dsh-tool-todo').peerDependencies['@deepseek-ai/dsh-agent'] = '0.1.0-rc.6';

  await assert.rejects(
    auditOfficialDshCohort({
      candidateManifest: candidateManifest('0.3.2'),
      expectedCandidateVersion: '0.3.2',
      fetchManifest: fetcherFrom(manifests),
    }),
    /incompatible .* range/,
  );
});

async function withFakeInstalledTree({ packageVersion, runtimeVersion, includeHubEntry = true, includeClient = true }, fn) {
  const prefix = await mkdtemp(join(os.tmpdir(), 'dsh-crew-installed-test-'));
  const packageRoot = join(prefix, 'node_modules', '@ran-sh', 'dsh-crew');
  try {
    await mkdir(join(packageRoot, 'src', 'hub'), { recursive: true });
    await mkdir(join(packageRoot, 'lib'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: packageVersion }));
    await writeFile(join(packageRoot, 'src', 'runtime-identity.mjs'), `export const RUNTIME_VERSION = '${runtimeVersion}';\n`);
    if (includeHubEntry) await writeFile(join(packageRoot, 'src', 'hub', 'entry.mjs'), 'export const ok = true;\n');
    if (includeClient) await writeFile(join(packageRoot, 'lib', 'client.js'), 'window.__ModuleLoader__;\n');
    return await fn(prefix);
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
}

test('assertInstalled accepts a matching installed package/runtime identity', async () => {
  await withFakeInstalledTree({ packageVersion: '0.3.2', runtimeVersion: '0.3.2' }, async (prefix) => {
    await assertInstalled(prefix, 'standalone candidate', '0.3.2');
  });
});

test('assertInstalled fails on a mismatched installed package version', async () => {
  await withFakeInstalledTree({ packageVersion: '0.3.3', runtimeVersion: '0.3.2' }, async (prefix) => {
    await assert.rejects(
      assertInstalled(prefix, 'standalone candidate', '0.3.2'),
      /did not install the expected 0\.3\.2 package\/runtime entries/,
    );
  });
});

test('assertInstalled fails on a mismatched runtime identity', async () => {
  await withFakeInstalledTree({ packageVersion: '0.3.2', runtimeVersion: '0.3.3' }, async (prefix) => {
    await assert.rejects(
      assertInstalled(prefix, 'standalone candidate', '0.3.2'),
      /did not install the expected 0\.3\.2 package\/runtime entries/,
    );
  });
});

test('assertInstalled fails when the hub entry or client artifact is missing', async () => {
  await withFakeInstalledTree({ packageVersion: '0.3.2', runtimeVersion: '0.3.2', includeHubEntry: false }, async (prefix) => {
    await assert.rejects(assertInstalled(prefix, 'standalone candidate', '0.3.2'));
  });
  await withFakeInstalledTree({ packageVersion: '0.3.2', runtimeVersion: '0.3.2', includeClient: false }, async (prefix) => {
    await assert.rejects(assertInstalled(prefix, 'standalone candidate', '0.3.2'));
  });
});
