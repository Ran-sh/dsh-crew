#!/usr/bin/env node

// Regression gate for the published-package peer contract.
// This intentionally uses npm's default resolver for the candidate install:
// no peer-resolution bypass or equivalent override is permitted here.
//
// The official DSH check is deliberately bounded. It audits authoritative
// public registry manifests and cross-cohort ranges instead of materializing
// or fully resolving the very large official DSH dependency graph.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org/';
export const supportedDshVersion = '0.1.2-alpha.5';
const verifyOfficialDsh = process.argv.includes('--with-official-dsh');
const DSH_PACKAGE = '@deepseek-ai/dsh';
const DSH_PREFIX = '@deepseek-ai/dsh-';
const MAX_DIRECT_PEERS = 64;

export function resolveNpmInvocation({
  platform = process.platform,
  nodePath = process.execPath,
  fileExists = existsSync,
} = {}) {
  if (platform !== 'win32') return { command: 'npm', argsPrefix: [] };
  const npmCli = path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fileExists(npmCli)) throw new Error(`npm CLI was not found beside Node.js: ${npmCli}`);
  return { command: nodePath, argsPrefix: [npmCli] };
}

const npmInvocation = resolveNpmInvocation();

/**
 * The candidate version is derived from the candidate package manifest at the
 * checkout root instead of a hard-coded release literal, so the verifier never
 * needs a source edit for the next candidate version. The audit guard still
 * requires the passed-in manifest to match this authoritative value.
 */
export async function readCandidateVersion({ rootDir = root, readFileImpl = readFile } = {}) {
  const packageJson = await readFileImpl(path.join(rootDir, 'package.json'), 'utf8');
  return JSON.parse(packageJson).version;
}

function isDshPackage(name) {
  return name === DSH_PACKAGE || name.startsWith(DSH_PREFIX);
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) return Number(a) > Number(b) ? 1 : -1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

function upperBoundForCaret(version) {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0, prerelease: [] };
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] };
  return { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] };
}

function upperBoundForTilde(version) {
  return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] };
}

function satisfiesComparator(version, operator, expected) {
  const comparison = compareVersions(version, expected);
  if (operator === '>') return comparison > 0;
  if (operator === '>=') return comparison >= 0;
  if (operator === '<') return comparison < 0;
  if (operator === '<=') return comparison <= 0;
  return comparison === 0;
}

function satisfiesAlternative(version, alternative) {
  const normalized = alternative.trim();
  if (!normalized || /[*xX]|workspace:|^npm:|^file:|^git:/.test(normalized)) return false;
  const tokens = normalized.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  return tokens.every((token) => {
    const prefix = /^(\^|~|>=|<=|>|<|=)/.exec(token)?.[1] ?? '';
    const raw = prefix ? token.slice(prefix.length) : token;
    const expected = parseVersion(raw);
    if (!expected) return false;
    if (prefix === '^') {
      return compareVersions(version, expected) >= 0 && compareVersions(version, upperBoundForCaret(expected)) < 0;
    }
    if (prefix === '~') {
      return compareVersions(version, expected) >= 0 && compareVersions(version, upperBoundForTilde(expected)) < 0;
    }
    return satisfiesComparator(version, prefix, expected);
  });
}

export function satisfiesCohortRange(versionString, range) {
  const version = parseVersion(versionString);
  if (!version || typeof range !== 'string') return false;
  return range.split(/\s*\|\|\s*/).some((alternative) => satisfiesAlternative(version, alternative));
}

function assertManifest(manifest, expectedName, expectedVersion) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`invalid registry manifest for ${expectedName}@${expectedVersion}`);
  }
  if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
    throw new Error(`registry manifest identity mismatch for ${expectedName}@${expectedVersion}`);
  }
  return manifest;
}

function manifestUrl(registryUrl, name, version) {
  const encodedName = name.startsWith('@') ? name.replace('/', '%2f') : encodeURIComponent(name);
  return `${registryUrl.replace(/\/+$/, '')}/${encodedName}/${encodeURIComponent(version)}`;
}

export async function fetchPublicManifest(name, version, {
  registryUrl = registry,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');
  const response = await fetchImpl(manifestUrl(registryUrl, name, version), {
    headers: { accept: 'application/json', 'user-agent': 'dsh-crew-cohort-audit' },
  });
  if (!response?.ok) throw new Error(`public manifest unavailable for ${name}@${version} (HTTP ${response?.status ?? 'unknown'})`);
  let manifest;
  try {
    manifest = await response.json();
  } catch {
    throw new Error(`public manifest was not valid JSON for ${name}@${version}`);
  }
  return assertManifest(manifest, name, version);
}

function dshReferences(manifest) {
  return [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.optionalDependencies ?? {}),
    ...Object.entries(manifest.peerDependencies ?? {}),
  ].filter(([name]) => isDshPackage(name));
}

function assertCrossCohortRanges(manifest, label) {
  const references = dshReferences(manifest);
  for (const [name, range] of references) {
    if (!satisfiesCohortRange(supportedDshVersion, range)) {
      throw new Error(`${label} has incompatible ${name} range ${JSON.stringify(range)} for ${supportedDshVersion}`);
    }
  }
  return references.length;
}

export async function auditOfficialDshCohort({
  candidateManifest,
  expectedCandidateVersion,
  registryUrl = registry,
  fetchManifest = (name, version) => fetchPublicManifest(name, version, { registryUrl }),
} = {}) {
  if (!candidateManifest || typeof candidateManifest !== 'object') throw new Error('candidate package manifest is missing');
  if (typeof expectedCandidateVersion !== 'string' || expectedCandidateVersion.length === 0) {
    throw new Error('expectedCandidateVersion is required (derive it with readCandidateVersion)');
  }
  if (candidateManifest.version !== expectedCandidateVersion) {
    throw new Error(`package.json must be ${expectedCandidateVersion}`);
  }

  const directPeers = Object.entries(candidateManifest.peerDependencies ?? {})
    .filter(([name]) => isDshPackage(name));
  if (directPeers.length === 0 || directPeers.length > MAX_DIRECT_PEERS) {
    throw new Error(`candidate DSH peer count is outside the bounded audit limit: ${directPeers.length}`);
  }
  for (const [name, range] of directPeers) {
    if (range !== supportedDshVersion) {
      throw new Error(`candidate peer ${name} must pin exact cohort ${supportedDshVersion}, got ${JSON.stringify(range)}`);
    }
  }

  const officialManifest = assertManifest(
    await fetchManifest(DSH_PACKAGE, supportedDshVersion),
    DSH_PACKAGE,
    supportedDshVersion,
  );
  const manifests = [officialManifest];
  let crossCohortChecks = assertCrossCohortRanges(officialManifest, `${DSH_PACKAGE}@${supportedDshVersion}`);

  for (const [name] of directPeers) {
    const manifest = assertManifest(await fetchManifest(name, supportedDshVersion), name, supportedDshVersion);
    manifests.push(manifest);
    crossCohortChecks += assertCrossCohortRanges(manifest, `${name}@${supportedDshVersion}`);
  }

  return {
    marker: 'PASS',
    candidate: expectedCandidateVersion,
    officialDsh: supportedDshVersion,
    directPeerCount: directPeers.length,
    manifestCount: manifests.length,
    crossCohortChecks,
  };
}

function run(args, cwd = root) {
  const result = spawnSync(npmInvocation.command, [...npmInvocation.argsPrefix, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
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

export async function assertInstalled(prefix, label, expectedVersion) {
  const packageRoot = path.join(prefix, 'node_modules', '@ran-sh', 'dsh-crew');
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const runtimeSource = await readFile(path.join(packageRoot, 'src', 'runtime-identity.mjs'), 'utf8');
  const runtimeVersion = runtimeSource.match(/RUNTIME_VERSION\s*=\s*'([^']+)'/)?.[1];
  const entryExists = await readFile(path.join(packageRoot, 'src', 'hub', 'entry.mjs')).then(() => true, () => false);
  const clientExists = await readFile(path.join(packageRoot, 'lib', 'client.js')).then(() => true, () => false);
  if (packageJson.version !== expectedVersion || runtimeVersion !== expectedVersion || !entryExists || !clientExists) {
    throw new Error(`${label} did not install the expected ${expectedVersion} package/runtime entries`);
  }
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-crew-install-verify-'));
  const paths = {
    pack: await mkdtemp(path.join(tempRoot, 'pack-')),
    standalone: await mkdtemp(path.join(tempRoot, 'standalone-')),
  };

  try {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const candidateVersion = await readCandidateVersion();
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
    await assertInstalled(paths.standalone, 'standalone candidate', candidateVersion);

    let officialMarker = 'not-run';
    if (verifyOfficialDsh) {
      const audit = await auditOfficialDshCohort({
        candidateManifest: packageJson,
        expectedCandidateVersion: candidateVersion,
        registryUrl: registry,
      });
      officialMarker = `${supportedDshVersion}:manifest-audit`;
      console.log(`DSH_COHORT_AUDIT=PASS official_dsh=${audit.officialDsh} direct_peers=${audit.directPeerCount} manifests=${audit.manifestCount} cross_cohort_checks=${audit.crossCohortChecks}`);
    }

    console.log(`NPM_INSTALL_CONTRACT=PASS candidate=${candidateVersion} official_dsh=${officialMarker}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
