import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { commitActivatedRelease, crewAppRoot, updateJournalFile } from '../src/install/npx-lifecycle.mjs';
import { crewDshHome } from '../src/install/install.mjs';

// The retained-runtime GC runs at the same commit points as release pruning: a
// cohort is kept only while some surviving release resolves to it. These tests
// pin the resolution chain (manifest pin, then the release-cohort.json sidecar)
// and the fail-closed behaviour, none of which the release-pruning tests reach.

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-retained-gc-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const releasesDir = (home) => join(crewAppRoot({ home }), 'releases');
const retainedRoot = (home) => join(crewDshHome({ home }), 'retained-runtimes');

/** A managed release: its own directory with a payload manifest. */
function seedRelease(home, name, { crewVersion = '9.9.9', dshPin = null, sidecarCohort = null } = {}) {
  const dir = join(releasesDir(home), name);
  mkdirSync(dir, { recursive: true });
  const manifest = { name: '@ran-sh/dsh-crew', version: crewVersion };
  if (dshPin) manifest.dependencies = { '@deepseek-ai/dsh': dshPin };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  if (sidecarCohort) {
    writeFileSync(join(dir, 'release-cohort.json'), JSON.stringify({
      schema_version: 1,
      release: crewVersion,
      dsh_version: sidecarCohort,
    }));
  }
  return { dir, manifest };
}

/** A retained runtime cohort, the shape restoreRetainedRuntime expects. */
function seedCohort(home, version) {
  const dir = join(retainedRoot(home), version);
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  return dir;
}

const commit = (home, stageDir, manifest) => commitActivatedRelease({ stageDir, manifest, home, prior: null });

test('a cohort pinned by a surviving release is kept, an unpinned one is pruned', () => {
  const t = tempHome();
  try {
    const kept = seedCohort(t.dir, '0.1.2-alpha.5');
    const dropped = seedCohort(t.dir, '0.9.9-unpinned');
    const { dir, manifest } = seedRelease(t.dir, 'r-pinned', { dshPin: '0.1.2-alpha.5' });

    commit(t.dir, dir, manifest);

    assert.equal(existsSync(kept), true, 'the pinned cohort survives');
    assert.equal(existsSync(dropped), false, 'a cohort no release pins is pruned');
  } finally { t.cleanup(); }
});

test('a release naming its cohort only in the release-cohort.json sidecar keeps that cohort', () => {
  const t = tempHome();
  try {
    // Legacy releases (pre-1.0.4) did not pin @deepseek-ai/dsh in their
    // manifest; resolveReleaseCohort reads the sidecar for exactly this case.
    const kept = seedCohort(t.dir, '0.1.2-alpha.5');
    const { dir, manifest } = seedRelease(t.dir, 'r-sidecar-only', { dshPin: null, sidecarCohort: '0.1.2-alpha.5' });

    commit(t.dir, dir, manifest);

    assert.equal(existsSync(kept), true, 'the sidecar-recorded cohort must not be pruned');
  } finally { t.cleanup(); }
});

test('a release directory that resolves to no cohort disables pruning for the whole pass', async () => {
  const t = tempHome();
  try {
    const survivor = seedCohort(t.dir, '0.9.9-unpinned');
    const { dir, manifest } = seedRelease(t.dir, 'r-pinned', { dshPin: '0.1.2-alpha.5' });
    seedCohort(t.dir, '0.1.2-alpha.5');
    // No manifest and no sidecar: the pin set is not trustworthy this pass.
    mkdirSync(join(releasesDir(t.dir), 'r-unresolvable'), { recursive: true });

    const warnings = [];
    const onWarning = (warning) => warnings.push(String(warning.message ?? warning));
    process.on('warning', onWarning);
    try {
      commit(t.dir, dir, manifest);
      // process.emitWarning delivers on a later tick; let it arrive before the
      // listener is removed.
      await new Promise((resolve) => setImmediate(resolve));
    } finally { process.off('warning', onWarning); }

    assert.equal(existsSync(survivor), true, 'nothing is pruned when a release cannot name its cohort');
    assert.ok(
      warnings.some((w) => w.includes('r-unresolvable') && w.includes('retained-runtime pruning')),
      `expected a warning naming the unresolved release, got ${JSON.stringify(warnings)}`,
    );
  } finally { t.cleanup(); }
});

test('a retained-runtimes path that is not a directory does not fail the commit', () => {
  const t = tempHome();
  try {
    const { dir, manifest } = seedRelease(t.dir, 'r-pinned', { dshPin: '0.1.2-alpha.5' });
    mkdirSync(join(crewDshHome({ home: t.dir }), 'retained-runtimes'), { recursive: true });
    rmSync(retainedRoot(t.dir), { recursive: true, force: true });
    writeFileSync(retainedRoot(t.dir), 'not a directory');

    // Pruning is best-effort: the pointer and the journal are already committed
    // by the time it runs, so it must never throw out of the commit.
    assert.doesNotThrow(() => commit(t.dir, dir, manifest));
    assert.equal(existsSync(updateJournalFile({ home: t.dir })), false, 'the journal is still cleared');
    assert.equal(existsSync(join(crewAppRoot({ home: t.dir }), 'current.json')), true, 'the pointer is still written');
  } finally { t.cleanup(); }
});
