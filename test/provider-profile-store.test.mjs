import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasInlineProviderCredentials,
  inspectProviderProfile,
  readProviderDeclarations,
  removeProviderDeclarations,
} from '../src/provider-profile-store.mjs';

const PROFILE = `# managed provider patch\n- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        displayName: OpenCode Go\n        apiKeyEnv: OPENCODE_GO_API_KEY\n      opencode-alt:\n        displayName: Opencode\n        apiKeyEnv: OPENCODE_ALT_API_KEY\n      opencode-muse:\n        displayName: opencode-go-muse\n        apiKeyEnv: OPENCODE_MUSE_API_KEY\n      openrouter:\n        displayName: openrouter\n        apiKeyEnv: OPENROUTER_API_KEY\n- insert:\n    - id: dsh-crew-hub\n      name: '@ran-sh/dsh-crew'\n`;

test('fresh Harness empty profile patch is valid and contains no provider declarations', () => {
  const inspected = inspectProviderProfile('[]\n');
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.providerIds, []);
  assert.match(inspected.revision, /^[a-f0-9]{64}$/u);
  assert.deepEqual(readProviderDeclarations('[]\n'), { ok: true, declarations: [] });
  assert.deepEqual(hasInlineProviderCredentials('[]\n'), { ok: true, inline: false });
});

test('inspectProviderProfile returns provider ids and a revision without values', () => {
  const result = inspectProviderProfile(PROFILE);
  assert.equal(result.ok, true);
  assert.deepEqual(result.providerIds, ['opencode-go', 'opencode-alt', 'opencode-muse', 'openrouter']);
  assert.match(result.revision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('OPENCODE_GO_API_KEY'), false);
});

test('readProviderDeclarations returns provenance and credential references only', () => {
  const result = readProviderDeclarations(PROFILE, { file: 'profiles/dsh-crew/cordis.patch.yml' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.declarations, [
    {
      id: 'opencode-go', display_name: 'OpenCode Go', origin: 'profile-managed',
      ownership: 'crew-managed-profile', file: 'profiles/dsh-crew/cordis.patch.yml', declaration_authority: { kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.opencode-go' },
      credential_ref: 'OPENCODE_GO_API_KEY',
    },
    {
      id: 'opencode-alt', display_name: 'Opencode', origin: 'profile-managed',
      ownership: 'crew-managed-profile', file: 'profiles/dsh-crew/cordis.patch.yml', declaration_authority: { kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.opencode-alt' },
      credential_ref: 'OPENCODE_ALT_API_KEY',
    },
    {
      id: 'opencode-muse', display_name: 'opencode-go-muse', origin: 'profile-managed',
      ownership: 'crew-managed-profile', file: 'profiles/dsh-crew/cordis.patch.yml', declaration_authority: { kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.opencode-muse' },
      credential_ref: 'OPENCODE_MUSE_API_KEY',
    },
    {
      id: 'openrouter', display_name: 'openrouter', origin: 'profile-managed',
      ownership: 'crew-managed-profile', file: 'profiles/dsh-crew/cordis.patch.yml', declaration_authority: { kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.openrouter' },
      credential_ref: 'OPENROUTER_API_KEY',
    },
  ]);
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('profile credential values are redacted while presence remains visible', () => {
  for (const value of ['sk-live-secret', 'secret_LIVE123', 'token_ABC123', 'sk_live_ABC123']) {
    const source = PROFILE.replace('apiKeyEnv: OPENCODE_GO_API_KEY', `apiKeyEnv: ${value}`);
    const result = readProviderDeclarations(source);
    const declaration = result.declarations.find((entry) => entry.id === 'opencode-go');
    assert.equal(declaration.credential_ref, undefined, value);
    assert.equal(declaration.credential_status, 'present-redacted', value);
    assert.equal(JSON.stringify(result).includes(value), false, value);
  }
});

test('provider declarations carry an explicit mutation authority locator', () => {
  const result = readProviderDeclarations(PROFILE, { file: 'profiles/dsh-crew/cordis.patch.yml' });
  assert.deepEqual(result.declarations[0].declaration_authority, {
    kind: 'crew-profile', locator: 'llm-pi-ai.config.providers.opencode-go',
  });
});

test('removeProviderDeclarations removes only selected providers and preserves the rest', () => {
  const inspected = inspectProviderProfile(PROFILE);
  const result = removeProviderDeclarations(PROFILE, {
    providerIds: ['opencode-go', 'opencode-alt', 'opencode-muse'],
    expectedRevision: inspected.revision,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.removed, ['opencode-go', 'opencode-alt', 'opencode-muse']);
  assert.deepEqual(result.remaining, ['openrouter']);
  assert.equal(result.text.includes('opencode-go:'), false);
  assert.equal(result.text.includes('opencode-alt:'), false);
  assert.equal(result.text.includes('opencode-muse:'), false);
  assert.equal(result.text.includes('openrouter:'), true);
  assert.equal(result.text.includes('dsh-crew-hub'), true);
});

test('profile revision mismatch fails closed before writing', () => {
  const result = removeProviderDeclarations(PROFILE, {
    providerIds: ['opencode-go'],
    expectedRevision: '0'.repeat(64),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROVIDER_PROFILE_CHANGED');
  assert.equal(result.text, undefined);
});

test('unknown profile shape and missing provider fail closed', () => {
  const unknown = removeProviderDeclarations('- insert:\n    - id: other\n', {
    providerIds: ['opencode-go'],
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED');

  const missing = removeProviderDeclarations(PROFILE, { providerIds: ['missing'] });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PROVIDER_NOT_FOUND');
});

test('removing the final provider preserves the managed sequence and leaves an explicit empty map', () => {
  const source = `- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        displayName: OpenCode Go\n- insert:\n    - id: dsh-crew-hub\n`;
  const inspected = inspectProviderProfile(source);
  const result = removeProviderDeclarations(source, {
    providerIds: ['opencode-go'],
    expectedRevision: inspected.revision,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.remaining, []);
  assert.equal(result.text.includes('opencode-go:'), false);
  assert.match(result.text, /providers: \{\}/);
  assert.match(result.text, /- id: llm-pi-ai/);
  assert.equal(result.text.includes('dsh-crew-hub'), true);
});

test('removing the final provider preserves unrelated llm-pi-ai sibling fields', () => {
  const source = `- id: llm-pi-ai\n  config:\n    timeout: 30000\n    providers:\n      opencode-go:\n        displayName: OpenCode Go\n- insert:\n    - id: dsh-crew-hub\n`;
  const result = removeProviderDeclarations(source, { providerIds: ['opencode-go'], expectedRevision: inspectProviderProfile(source).revision });
  assert.equal(result.ok, true);
  assert.match(result.text, /timeout: 30000/);
  assert.match(result.text, /providers: \{\}/);
});

test('malformed nested sequence or unexpected dedent fails closed without partial deletion', () => {
  const nestedSequence = `- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        displayName: OpenCode Go\n        - unexpected: true\n      openrouter:\n        displayName: openrouter\n- insert:\n    - id: dsh-crew-hub\n`;
  const nested = removeProviderDeclarations(nestedSequence, { providerIds: ['opencode-go'] });
  assert.equal(nested.ok, false);
  assert.equal(nested.code, 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED');
  assert.equal(nested.text, undefined);

  const unexpectedDedent = `- id: llm-pi-ai\n  config:\n    providers:\n      opencode-go:\n        displayName: OpenCode Go\n    unexpected: true\n- insert:\n    - id: dsh-crew-hub\n`;
  const dedent = removeProviderDeclarations(unexpectedDedent, { providerIds: ['opencode-go'] });
  assert.equal(dedent.ok, false);
  assert.equal(dedent.code, 'PROVIDER_PROFILE_SCHEMA_UNSUPPORTED');
});
