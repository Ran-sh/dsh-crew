import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRuntimeEndpoint } from '../src/hub/entry.mjs';
import { getHubRuntimeIdentity } from '../src/runtime-identity.mjs';

test('Hub entry registers a runtime compatibility endpoint without changing legacy ping', () => {
  let registration;
  const ctx = {
    inject(deps, setup) {
      assert.deepEqual(deps, ['webServer']);
      return setup({
        webServer: {
          register(value) {
            registration = value;
            return () => {};
          },
        },
      });
    },
  };

  registerRuntimeEndpoint(ctx);
  assert.equal(registration.kind, 'exact');
  assert.equal(registration.path, '/_dsh/dsh-crew/runtime');

  let status;
  let headers;
  let body = '';
  registration.handler({}, {
    writeHead(value, nextHeaders) { status = value; headers = nextHeaders; },
    end(value) { body = value; },
  });

  assert.equal(status, 200);
  assert.equal(headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(body), { ok: true, ...getHubRuntimeIdentity() });
});
