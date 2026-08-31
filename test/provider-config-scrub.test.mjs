import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubProviderReferences } from '../src/provider-config-scrub.mjs';

const CONFIG = {
  flash_model_priority: [
    { provider: 'opencode-go', model: 'm1' },
    { provider: 'openrouter', model: 'm2' },
  ],
  flash_model_priority_configured: true,
  pro_model_priority: [{ provider: 'opencode-go', model: 'm3' }],
  pro_model_priority_configured: true,
  worker: {
    model_policy: {
      priority: [{ provider: 'opencode-go', model: 'm1' }, { provider: 'openrouter', model: 'm2' }],
      escalation_priority: [{ provider: 'opencode-go', model: 'm3' }],
      priorityConfigured: true,
      escalation_priority_configured: true,
    },
  },
  review: {
    model_policy: { priority: [{ provider: 'opencode-go', model: 'm3' }], priorityConfigured: true },
  },
  harness_default: { provider: 'opencode-go', model: 'm1' },
};

test('scrub removes provider references across legacy and canonical policy mirrors', () => {
  const result = scrubProviderReferences(CONFIG, ['opencode-go']);
  assert.deepEqual(result.config.flash_model_priority, [{ provider: 'openrouter', model: 'm2' }]);
  assert.deepEqual(result.config.pro_model_priority, []);
  assert.deepEqual(result.config.worker.model_policy.priority, [{ provider: 'openrouter', model: 'm2' }]);
  assert.deepEqual(result.config.worker.model_policy.escalation_priority, []);
  assert.deepEqual(result.config.review.model_policy.priority, []);
  assert.equal(result.config.harness_default, null);
  assert.equal(result.config.flash_model_priority_configured, true);
  assert.equal(result.config.pro_model_priority_configured, true);
  assert.equal(result.config.worker.model_policy.priorityConfigured, true);
});

test('scrub is immutable and reports only bounded removals', () => {
  const result = scrubProviderReferences(CONFIG, ['opencode-go', 'missing']);
  assert.notEqual(result.config, CONFIG);
  assert.deepEqual(CONFIG.harness_default, { provider: 'opencode-go', model: 'm1' });
  assert.deepEqual(result.removed, ['opencode-go']);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('invalid provider ids fail closed without changing input', () => {
  assert.throws(() => scrubProviderReferences(CONFIG, ['']), /provider id/);
  assert.throws(() => scrubProviderReferences(CONFIG, 'opencode-go'), /provider ids/);
});
