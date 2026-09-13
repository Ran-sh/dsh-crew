import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareProcessToken,
  processStartToken,
  resetProcessStartTokenCache,
} from '../src/process-identity.mjs';

test('a pid with no start token is unknown, never an identity', () => {
  for (const pid of [0, -1, 1.5, 'x', null, undefined]) {
    assert.equal(processStartToken(pid), null);
  }
  assert.equal(compareProcessToken({ pid: process.pid }), 'unknown');
  assert.equal(compareProcessToken({ pid: process.pid, process_start_token: '' }), 'unknown');
  assert.equal(compareProcessToken(null), 'unknown');
});

test('the recorded token decides whether a live pid is the same process', () => {
  resetProcessStartTokenCache();
  const probe = () => 'win-ticks:1000';
  assert.equal(processStartToken(4242, { probe }), 'win-ticks:1000');
  assert.equal(compareProcessToken({ pid: 4242, process_start_token: 'win-ticks:1000' }, { probe }), 'same');
  assert.equal(compareProcessToken({ pid: 4242, process_start_token: 'win-ticks:999' }, { probe }), 'different');
  resetProcessStartTokenCache();
});

test('a probe that cannot answer never reports a recycled pid', () => {
  resetProcessStartTokenCache();
  // The safe direction: without a start time, "different" is unknowable, and
  // the caller falls back to the PID-only verdict instead of stealing a lock.
  const silent = { probe: () => null };
  assert.equal(processStartToken(5150, silent), null);
  assert.equal(compareProcessToken({ pid: 5150, process_start_token: 'win-ticks:123' }, silent), 'unknown');
  const throwing = { probe: () => { throw new Error('no powershell'); } };
  resetProcessStartTokenCache();
  assert.equal(processStartToken(5151, throwing), null);
  assert.equal(compareProcessToken({ pid: 5151, process_start_token: 'win-ticks:123' }, throwing), 'unknown');
  resetProcessStartTokenCache();
});

test('the token is a stable pair for a real process on this platform', (t) => {
  resetProcessStartTokenCache();
  const token = processStartToken(process.pid);
  if (token === null) { t.skip(`no start-time probe for ${process.platform}`); return; }
  assert.match(token, /^(win-ticks|linux-starttime):/);
  // Caching is what makes this affordable in a lock loop, so it must not vary.
  assert.equal(processStartToken(process.pid), token);
  assert.equal(compareProcessToken({ pid: process.pid, process_start_token: token }), 'same');
  resetProcessStartTokenCache();
});

test('a decoy pid whose token differs is reported as recycled', () => {
  // The probe is injected here: this asserts the comparison, and asking the real
  // platform for a start time spawns a process that can time out under load,
  // which would make the verdict `unknown` and the test flaky rather than wrong.
  resetProcessStartTokenCache();
  const own = processStartToken(process.pid, { probe: () => 'win-ticks:111' });
  assert.equal(own, 'win-ticks:111');
  resetProcessStartTokenCache();
  assert.equal(
    compareProcessToken({ pid: process.pid, process_start_token: 'win-ticks:222' }, { probe: () => 'win-ticks:111' }),
    'different',
    'the pid is alive and it is not the owner',
  );
  resetProcessStartTokenCache();
});
