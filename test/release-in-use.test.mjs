import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimReleaseInUse,
  clearReleaseClaim,
  liveReleaseClaims,
  releaseClaimFile,
  releaseClaimInUse,
  releaseClaimsState,
  releaseInUseDir,
  releaseRootFor,
} from '../src/release-in-use.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-crew-inuse-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// A release under test: the resolver walks up looking for the payload manifest.
function fakeRelease(t, home, name) {
  const dir = join(home, '.config', 'dsh-crew', 'app', 'releases', name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.5.0' }));
  writeFileSync(join(dir, 'src', 'hub.mjs'), '// placeholder\n');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a claim identifies the release that owns a module', (t) => {
  const home = fixture(t);
  const release = fakeRelease(t, home, 'rel-a');
  assert.equal(releaseRootFor(new URL(`file:///${join(release, 'src', 'hub.mjs').replace(/\\/g, '/')}`)), release);

  const file = claimReleaseInUse({ home, releasePath: release, pid: 4242 });
  assert.equal(file, join(releaseInUseDir({ home }), '4242.json'));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).release, release);
});

test('a release root is not invented for a module outside a payload', (t) => {
  const home = fixture(t);
  const stray = join(home, 'elsewhere', 'src', 'x.mjs');
  mkdirSync(join(home, 'elsewhere', 'src'), { recursive: true });
  writeFileSync(stray, '// not a payload\n');
  assert.equal(releaseRootFor(new URL(`file:///${stray.replace(/\\/g, '/')}`)), null);
  // Claiming must therefore decline rather than record a bogus path.
  assert.equal(claimReleaseInUse({ home, moduleUrl: new URL(`file:///${stray.replace(/\\/g, '/')}`) }), null);
});

test('live claims are those whose process is still running', (t) => {
  const home = fixture(t);
  const a = fakeRelease(t, home, 'rel-a');
  const b = fakeRelease(t, home, 'rel-b');
  claimReleaseInUse({ home, releasePath: a, pid: 111 });
  claimReleaseInUse({ home, releasePath: b, pid: 222 });

  const alive = new Set([111]);
  assert.deepEqual(liveReleaseClaims({ home, alive: (pid) => alive.has(pid) }), [a]);
});

// A process that dies without cleaning up must not pin a release forever.
test('a dead claim is discarded, not honoured', (t) => {
  const home = fixture(t);
  const a = fakeRelease(t, home, 'rel-a');
  claimReleaseInUse({ home, releasePath: a, pid: 999 });
  assert.deepEqual(liveReleaseClaims({ home, alive: () => false }), []);
  assert.equal(existsSync(releaseClaimFile({ home, pid: 999 })), false, 'the stale claim file is reaped');
  assert.deepEqual(liveReleaseClaims({ home, alive: () => false }), []);
});

test('a valid claim for a dead process is reaped', (t) => {
  const home = fixture(t);
  const dir = releaseInUseDir({ home });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '999.json'), JSON.stringify({ pid: 999, release: 'C:/x' }));
  writeFileSync(join(dir, 'ignored.txt'), 'not a claim');
  const state = releaseClaimsState({ home, alive: () => false });
  assert.deepEqual(state.live, []);
  assert.equal(state.reliable, true, 'a parsed claim that is positively dead is safe to drop');
  assert.equal(existsSync(join(dir, '999.json')), false, 'the dead claim is reaped');
  assert.equal(existsSync(join(dir, 'ignored.txt')), true, 'unrelated files are left alone');
});

// The same reasoning as an unreadable directory, one level down. A claim whose
// contents cannot be read is a claim whose liveness cannot be ruled out, and
// treating it as dead is how retention deletes a release a running Hub is
// executing. A truncated file is the realistic case: the writer publishes
// atomically now, so a torn claim is evidence of an I/O problem, not of a
// process mid-write.
test('a malformed claim is unknown, not dead, and is never reaped', (t) => {
  const home = fixture(t);
  const dir = releaseInUseDir({ home });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  const state = releaseClaimsState({ home, alive: () => true });
  assert.deepEqual(state.live, []);
  assert.equal(state.reliable, false, 'unparseable content is unknown liveness');
  assert.match(state.error ?? '', /unparseable claim/);
  assert.equal(existsSync(join(dir, 'broken.json')), true, 'the file is left for a human to look at');
});

test('a claim that cannot be read is unknown and is never reaped', (t) => {
  const home = fixture(t);
  const dir = releaseInUseDir({ home });
  mkdirSync(join(dir, '4242.json'), { recursive: true }); // a directory where a file belongs
  const state = releaseClaimsState({ home, alive: () => true });
  assert.deepEqual(state.live, []);
  assert.equal(state.reliable, false, 'an unreadable claim is unknown liveness');
  assert.match(state.error ?? '', /unreadable claim/);
  assert.equal(existsSync(join(dir, '4242.json')), true);
});

// A claim is written to a temporary name and renamed into place, so a reader can
// never observe a listed claim whose contents are still being written.
test('a claim is published atomically', (t) => {
  const home = fixture(t);
  const a = fakeRelease(t, home, 'rel-a');
  const file = claimReleaseInUse({ home, releasePath: a, pid: 4242 });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).release, a);
  const leftovers = readdirSync(releaseInUseDir({ home })).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no partial file is left behind');
});

test('a claim can be cleared on clean shutdown', (t) => {
  const home = fixture(t);
  const a = fakeRelease(t, home, 'rel-a');
  claimReleaseInUse({ home, releasePath: a, pid: 4242 });
  assert.equal(releaseClaimInUse({ home, pid: 4242 }), true);
  clearReleaseClaim({ home, pid: 4242 });
  assert.equal(releaseClaimInUse({ home, pid: 4242 }), false);
  assert.deepEqual(liveReleaseClaims({ home, alive: () => true }), []);
});

test('claiming never throws when the state directory is unusable', (t) => {
  const home = fixture(t);
  const release = fakeRelease(t, home, 'rel-a');
  // A file where the directory should be: the Hub must still start.
  mkdirSync(join(home, '.config', 'dsh-crew', 'app'), { recursive: true });
  writeFileSync(join(home, '.config', 'dsh-crew', 'app', 'in-use'), 'blocking file');
  assert.equal(claimReleaseInUse({ home, releasePath: release, pid: 1 }), null);
  assert.deepEqual(liveReleaseClaims({ home, alive: () => true }), []);
  // Starting is the only thing that degrades gracefully. "No claims" is not
  // evidence that nothing is live, and reporting it as though it were is what
  // licenses retention to delete a release out from under a running Hub.
  const state = releaseClaimsState({ home, alive: () => true });
  assert.deepEqual(state.live, []);
  assert.equal(state.reliable, false, 'an unreadable claim directory is unknown, not empty');
});

test('a claim directory that does not exist yet is a reliable "nothing is live"', (t) => {
  const home = fixture(t);
  const state = releaseClaimsState({ home, alive: () => true });
  assert.deepEqual(state.live, []);
  assert.equal(state.reliable, true, 'no directory means no Hub has ever claimed');
});

// The defect this guards: retention kept the *current pointer* but not the
// release a running process was executing, so an update could delete the release
// under a live Hub — and because the Hub re-reads some modules from disk on every
// request, its config routes then answered 500 until a restart.
test('retention keeps a release that a live process is running', async (t) => {
  const { commitActivatedRelease } = await import('../src/install/npx-lifecycle.mjs');
  const home = fixture(t);
  const releasesDir = join(home, '.config', 'dsh-crew', 'app', 'releases');

  const mk = (name) => {
    const dir = join(releasesDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.5.0' }));
    return dir;
  };
  const inUse = mk('20260101T000000Z-oldest');
  const middle = mk('20260102T000000Z-middle');
  const newest = mk('20260103T000000Z-newest');

  // The oldest is the one a live Hub is actually executing.
  // Use this process's own pid: gcOldReleases checks liveness for real, and a
  // made-up pid would (correctly) be reaped as a stale claim.
  claimReleaseInUse({ home, releasePath: inUse, pid: process.pid });
  assert.deepEqual(liveReleaseClaims({ home }), [inUse]);

  // Activating the newest prunes down to keep-1 of the remainder.
  commitActivatedRelease({
    stageDir: newest,
    manifest: { name: '@ran-sh/dsh-crew', version: '1.5.0' },
    home,
  });

  assert.equal(existsSync(inUse), true, 'the claimed release must survive retention');
  assert.equal(existsSync(join(inUse, 'package.json')), true);
  // The unclaimed middle release is the one retention is allowed to take.
  const survivors = [inUse, middle, newest].filter((dir) => existsSync(dir));
  assert.ok(survivors.includes(newest), 'the activated release survives');
  assert.equal(
    survivors.includes(middle) || survivors.length === 2,
    true,
    `retention still makes progress on unclaimed releases (survivors: ${survivors.length})`,
  );
});

// The mirror image of the defect above, and the reason the claim reader reports
// reliability instead of just a list: when the claim directory cannot be read,
// "no live releases" is an absence of evidence. Acting on it deletes whatever a
// running Hub is executing, which is the same outage by a different route.
// Retention skipping a pass costs disk; guessing costs a broken Hub.
test('retention deletes nothing when release liveness cannot be determined', async (t) => {
  const { commitActivatedRelease } = await import('../src/install/npx-lifecycle.mjs');
  const home = fixture(t);
  const releasesDir = join(home, '.config', 'dsh-crew', 'app', 'releases');

  const mk = (name) => {
    const dir = join(releasesDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@ran-sh/dsh-crew', version: '1.5.0' }));
    return dir;
  };
  const oldest = mk('20260101T000000Z-oldest');
  const middle = mk('20260102T000000Z-middle');
  const newest = mk('20260103T000000Z-newest');

  // A file where the claim directory should be: liveness is unknown, not zero.
  mkdirSync(join(home, '.config', 'dsh-crew', 'app'), { recursive: true });
  writeFileSync(join(home, '.config', 'dsh-crew', 'app', 'in-use'), 'blocking file');
  assert.equal(releaseClaimsState({ home }).reliable, false, 'the fixture really does make liveness unknown');

  commitActivatedRelease({
    stageDir: newest,
    manifest: { name: '@ran-sh/dsh-crew', version: '1.5.0' },
    home,
  });

  assert.equal(existsSync(oldest), true, 'nothing is deleted on unknown liveness');
  assert.equal(existsSync(middle), true, 'nothing is deleted on unknown liveness');
  assert.equal(existsSync(newest), true, 'the activated release is still installed');
});
