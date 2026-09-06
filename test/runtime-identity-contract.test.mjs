import test from 'node:test';
import assert from 'node:assert/strict';
import { isCompleteRuntimeIdentity, isExactNativeCrewIdentity, sameCompleteRuntimeIdentity } from '../src/runtime-identity-contract.mjs';

const native = { execution_plane: 'hub-3210', profile: 'dsh-crew', listen_port: 3210, runtime_id: 'r1' };

test('runtime identity requires all four non-coerced fields', () => {
  assert.equal(isCompleteRuntimeIdentity(native), true);
  for (const field of ['execution_plane', 'profile', 'listen_port', 'runtime_id']) {
    const invalid = { ...native, [field]: field === 'listen_port' ? null : '' };
    assert.equal(isCompleteRuntimeIdentity(invalid), false, field);
  }
  assert.equal(isExactNativeCrewIdentity(native), true);
  assert.equal(isExactNativeCrewIdentity({ ...native, listen_port: 3080 }), false);
  assert.equal(sameCompleteRuntimeIdentity(native, { ...native }), true);
  assert.equal(sameCompleteRuntimeIdentity(native, { ...native, profile: 'official' }), false);
  assert.equal(sameCompleteRuntimeIdentity({ runtime_id: 'r1' }, { runtime_id: 'r1' }), false);
});
