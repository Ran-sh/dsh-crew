import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditOfficialDshCohort,
  satisfiesCohortRange,
  supportedDshVersion,
} from '../scripts/verify-npm-install.mjs';

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

function candidateManifest() {
  return {
    name: '@ran-sh/dsh-crew',
    version: '0.3.1',
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

test('cohort range evaluator accepts the official rc.2 cohort and rejects rc.6', () => {
  assert.equal(satisfiesCohortRange(supportedDshVersion, '^0.1.1-rc.2'), true);
  assert.equal(satisfiesCohortRange(supportedDshVersion, '0.1.1-rc.2'), true);
  assert.equal(satisfiesCohortRange(supportedDshVersion, '0.1.0-rc.6'), false);
  assert.equal(satisfiesCohortRange(supportedDshVersion, '*'), false);
});

test('official cohort audit passes with authoritative exact manifests and compatible ranges', async () => {
  const result = await auditOfficialDshCohort({
    candidateManifest: candidateManifest(),
    fetchManifest: fetcherFrom(manifestMap()),
  });

  assert.deepEqual(result, {
    marker: 'PASS',
    candidate: '0.3.1',
    officialDsh: supportedDshVersion,
    directPeerCount: 20,
    manifestCount: 21,
    crossCohortChecks: 21,
  });
});

test('official cohort audit fails closed when a direct manifest is missing', async () => {
  const manifests = manifestMap();
  manifests.delete('@deepseek-ai/dsh-tool-todo');

  await assert.rejects(
    auditOfficialDshCohort({ candidateManifest: candidateManifest(), fetchManifest: fetcherFrom(manifests) }),
    /invalid registry manifest/,
  );
});

test('official cohort audit fails closed on an incompatible cross-cohort peer range', async () => {
  const manifests = manifestMap();
  manifests.get('@deepseek-ai/dsh-tool-todo').peerDependencies['@deepseek-ai/dsh-agent'] = '0.1.0-rc.6';

  await assert.rejects(
    auditOfficialDshCohort({ candidateManifest: candidateManifest(), fetchManifest: fetcherFrom(manifests) }),
    /incompatible .* range/,
  );
});
