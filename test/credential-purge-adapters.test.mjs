import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCredentialPurgeFileHooks } from '../src/credential-purge-adapters.mjs';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-credential-store-'));
  const credentialsFile = join(dir, '.credentials.yaml');
  writeFileSync(credentialsFile, [
    'version: 1',
    'refs:',
    '  OPENCODE_GO_API_KEY: "crew-secret-go"',
    '  OPENCODE_MUSE_API_KEY: "crew-secret-muse"',
    '  KEEP_API_KEY: "keep-me"',
    '',
  ].join('\n'));
  return { dir, credentialsFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('credential purge adapter removes only the selected Crew-owned env ref and verifies absence', async () => {
  const t = tempStore();
  try {
    const hooks = createCredentialPurgeFileHooks({ credentialsFile: t.credentialsFile, crewHome: t.dir });
    assert.equal(hooks.ok, true, JSON.stringify(hooks));
    const plan = { reference_id: 'env:OPENCODE_GO_API_KEY', kind: 'env', name_or_handle: 'OPENCODE_GO_API_KEY' };
    const purged = await hooks.purge(plan);
    assert.deepEqual(purged, { ok: true, reference_id: plan.reference_id });
    const verified = await hooks.verify(plan);
    assert.deepEqual(verified, { ok: true, absent: true, reference_id: plan.reference_id });
    const after = readFileSync(t.credentialsFile, 'utf8');
    assert.equal(after.includes('OPENCODE_GO_API_KEY'), false);
    assert.equal(after.includes('OPENCODE_MUSE_API_KEY'), true);
    assert.equal(after.includes('KEEP_API_KEY'), true);
    assert.equal(after.includes('crew-secret-go'), false);
    assert.equal(JSON.stringify({ purged, verified }).includes('crew-secret'), false);
  } finally { t.cleanup(); }
});

test('credential purge adapter rejects unsafe stores and unsupported reference kinds', async () => {
  const t = tempStore();
  try {
    const unsafe = createCredentialPurgeFileHooks({ credentialsFile: join(tmpdir(), 'outside-credentials.yaml'), crewHome: t.dir });
    assert.deepEqual(unsafe, { ok: false, code: 'CREDENTIAL_STORE_PATH_UNSAFE' });
    const hooks = createCredentialPurgeFileHooks({ credentialsFile: t.credentialsFile, crewHome: t.dir });
    await assert.rejects(
      () => hooks.purge({ reference_id: 'file:token', kind: 'file', name_or_handle: 'token' }),
      (error) => error?.code === 'CREDENTIAL_PURGE_KIND_UNSUPPORTED',
    );
  } finally { t.cleanup(); }
});

test('credential purge adapter fails closed for missing or malformed refs without exposing store content', async () => {
  const t = tempStore();
  try {
    const hooks = createCredentialPurgeFileHooks({ credentialsFile: t.credentialsFile, crewHome: t.dir });
    await assert.rejects(
      () => hooks.purge({ reference_id: 'env:MISSING', kind: 'env', name_or_handle: 'MISSING' }),
      (error) => error?.code === 'CREDENTIAL_REFERENCE_NOT_FOUND' && !String(error).includes('crew-secret'),
    );
    writeFileSync(t.credentialsFile, 'refs:\n    broken: [\n');
    await assert.rejects(
      () => hooks.purge({ reference_id: 'env:OPENCODE_GO_API_KEY', kind: 'env', name_or_handle: 'OPENCODE_GO_API_KEY' }),
      (error) => error?.code === 'CREDENTIAL_STORE_MALFORMED' && !String(error).includes('crew-secret'),
    );
  } finally { t.cleanup(); }
});
