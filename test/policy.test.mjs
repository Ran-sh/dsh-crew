// Pure policy tests: normalization, migration, tier resolution, escalation,
// review, roles and multimodal capability — no DSH, hub or worker runtime
// involved. Run with: node --test test/policy.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGlobalConfig,
  deriveLegacyConfig,
  resolveCollaborationPreset,
  getEffectiveTierState,
  isTierEnabled,
  isTierAutoEligible,
  chooseDefaultTier,
  canEscalateFlashToPro,
  shouldRunProReview,
  getRoutingGuidance,
  validateConfig,
  validateRoles,
  getCapabilities,
  getMultimodalRegistrationPlan,
  POLICY_ERROR_CODES,
  DEFAULT_FLASH_ROLES,
  DEFAULT_PRO_ROLES,
} from '../src/policy.mjs';

const LEGACY_AUTO = { default_tier: 'flash', tier_policy: 'auto' };
const LEGACY_FLASH = { default_tier: 'flash', tier_policy: 'flash-only' };
const LEGACY_PRO = { default_tier: 'pro', tier_policy: 'pro-only' };

function baseConfig(patch = {}) {
  return normalizeGlobalConfig({ ...LEGACY_AUTO, ...patch });
}

// ---------- config migration ----------

test('1. old auto → balanced + flash auto + pro auto', () => {
  const c = normalizeGlobalConfig(LEGACY_AUTO);
  assert.equal(c.collaboration_mode, 'balanced');
  assert.equal(c.flash_state, 'auto');
  assert.equal(c.pro_state, 'auto');
});

test('2. old flash-only → flash only', () => {
  const c = normalizeGlobalConfig(LEGACY_FLASH);
  assert.equal(c.collaboration_mode, 'flash-only');
  assert.equal(c.flash_state, 'auto');
  assert.equal(c.pro_state, 'disabled');
});

test('3. old pro-only → pro only', () => {
  const c = normalizeGlobalConfig(LEGACY_PRO);
  assert.equal(c.collaboration_mode, 'pro-only');
  assert.equal(c.flash_state, 'disabled');
  assert.equal(c.pro_state, 'auto');
});

test('4. old vision_provider=off → vision disabled', () => {
  const c = normalizeGlobalConfig({ vision_provider: 'off' });
  assert.equal(c.vision_enabled, false);
});

test('5. old imagegen_provider=off → imagegen disabled', () => {
  const c = normalizeGlobalConfig({ imagegen_provider: 'off' });
  assert.equal(c.imagegen_enabled, false);
});

test('legacy config keeps working through deriveLegacyConfig', () => {
  const legacy = deriveLegacyConfig(normalizeGlobalConfig(LEGACY_FLASH));
  assert.equal(legacy.tier_policy, 'flash-only');
  const legacyPro = deriveLegacyConfig(normalizeGlobalConfig(LEGACY_PRO));
  assert.equal(legacyPro.tier_policy, 'pro-only');
});

test('normalize never mutates its input', () => {
  const raw = { ...LEGACY_AUTO, tier_policy: 'auto' };
  normalizeGlobalConfig(raw);
  assert.deepEqual(raw, LEGACY_AUTO);
});

// ---------- tier resolution ----------

test('6. balanced + requested flash → flash', () => {
  const r = chooseDefaultTier(baseConfig(), 'flash');
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'flash');
});

test('7. balanced + requested pro → pro', () => {
  const r = chooseDefaultTier(baseConfig(), 'pro');
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'pro');
});

test('8. flash-only + requested pro → rejected TIER_DISABLED', () => {
  const r = chooseDefaultTier(baseConfig({ collaboration_mode: 'flash-only' }), 'pro');
  assert.equal(r.ok, false);
  assert.equal(r.error.policyCode, POLICY_ERROR_CODES.TIER_DISABLED);
});

test('9. pro-only + requested flash → rejected TIER_DISABLED', () => {
  const r = chooseDefaultTier(baseConfig({ collaboration_mode: 'pro-only' }), 'flash');
  assert.equal(r.ok, false);
  assert.equal(r.error.policyCode, POLICY_ERROR_CODES.TIER_DISABLED);
});

test('10. custom flash disabled / pro auto / default flash → pro', () => {
  const c = baseConfig({ collaboration_mode: 'custom', flash_state: 'disabled', pro_state: 'auto', default_tier: 'flash' });
  const r = chooseDefaultTier(c, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'pro');
});

test('11. custom flash auto / pro disabled / request pro → blocked (fixed behavior)', () => {
  const c = baseConfig({ collaboration_mode: 'custom', flash_state: 'auto', pro_state: 'disabled' });
  const r = chooseDefaultTier(c, 'pro');
  assert.equal(r.ok, false);
  assert.equal(r.error.policyCode, POLICY_ERROR_CODES.TIER_DISABLED);
});

test('12. both disabled → NO_WORKER_TIER', () => {
  const c = baseConfig({ collaboration_mode: 'custom', flash_state: 'disabled', pro_state: 'disabled' });
  const r = chooseDefaultTier(c, undefined);
  assert.equal(r.ok, false);
  assert.equal(r.error.policyCode, POLICY_ERROR_CODES.NO_WORKER_TIER);
});

test('13. manual tier does not participate in automatic default', () => {
  const c = baseConfig({ collaboration_mode: 'custom', flash_state: 'manual', pro_state: 'auto', default_tier: 'flash' });
  const r = chooseDefaultTier(c, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'pro'); // default_tier=flash is manual → skipped
});

test('13b. manual tier is callable when explicitly requested', () => {
  const c = baseConfig({ collaboration_mode: 'custom', flash_state: 'manual', pro_state: 'auto' });
  const r = chooseDefaultTier(c, 'flash');
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'flash');
});

test('14. manual pro does not participate in auto escalation', () => {
  const c = baseConfig({ collaboration_mode: 'custom', flash_state: 'auto', pro_state: 'manual', escalate_on_failure: true });
  assert.equal(canEscalateFlashToPro(c), false);
});

test('only-auto-tier carries all normal coding work even if default roles differ', () => {
  const c = baseConfig({ collaboration_mode: 'custom', flash_state: 'auto', pro_state: 'disabled' });
  const r = chooseDefaultTier(c, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'flash');
});

test('subagents_enabled=false rejects every dispatch', () => {
  const c = baseConfig({ subagents_enabled: false });
  const r = chooseDefaultTier(c, 'flash');
  assert.equal(r.ok, false);
  assert.equal(r.error.policyCode, POLICY_ERROR_CODES.SUBAGENTS_DISABLED);
});

test('session tier_policy clamp overrides global collaboration mode', () => {
  const c = baseConfig({ collaboration_mode: 'balanced' });
  const r = chooseDefaultTier(c, 'pro', { tier_policy: 'flash-only' });
  assert.equal(r.ok, false);
  assert.equal(r.error.policyCode, POLICY_ERROR_CODES.TIER_DISABLED);
  const r2 = chooseDefaultTier(c, undefined, { tier_policy: 'pro-only' });
  assert.equal(r2.tier, 'pro');
});

test('session enabled=false overrides subagents_enabled=true', () => {
  const c = baseConfig();
  const r = chooseDefaultTier(c, 'flash', { enabled: false });
  assert.equal(r.ok, false);
  assert.equal(r.error.policyCode, POLICY_ERROR_CODES.SUBAGENTS_DISABLED);
});

// ---------- escalation ----------

test('15. flash failed + pro auto + escalation on → yes', () => {
  const c = baseConfig({ escalate_on_failure: true });
  assert.equal(canEscalateFlashToPro(c), true);
});

test('16. flash failed + pro manual → no', () => {
  const c = baseConfig({ collaboration_mode: 'custom', flash_state: 'auto', pro_state: 'manual', escalate_on_failure: true });
  assert.equal(canEscalateFlashToPro(c), false);
});

test('17. flash failed + pro disabled → no', () => {
  const c = baseConfig({ collaboration_mode: 'custom', flash_state: 'auto', pro_state: 'disabled', escalate_on_failure: true });
  assert.equal(canEscalateFlashToPro(c), false);
});

test('18. flash-only mode → no pro escalation even with the flag on', () => {
  const c = baseConfig({ collaboration_mode: 'flash-only', escalate_on_failure: true });
  assert.equal(canEscalateFlashToPro(c), false);
});

// ---------- review ----------

test('19. review-pipeline + both auto → review yes', () => {
  const c = baseConfig({ collaboration_mode: 'review-pipeline' });
  assert.equal(shouldRunProReview(c), true);
});

test('20. review-pipeline forces both tiers auto (preset owns states)', () => {
  // In a preset mode the per-tier state fields are ignored by design; the
  // pipeline needs both tiers, so both are effectively auto.
  assert.equal(shouldRunProReview(baseConfig({ collaboration_mode: 'review-pipeline' })), true);
});

test('20b. pro manual/disabled with review opted in → review no (custom mode)', () => {
  const manual = baseConfig({ collaboration_mode: 'custom', flash_state: 'auto', pro_state: 'manual', pro_reviews_flash: true });
  const disabled = baseConfig({ collaboration_mode: 'custom', flash_state: 'auto', pro_state: 'disabled', pro_reviews_flash: true });
  assert.equal(shouldRunProReview(manual), false);
  assert.equal(shouldRunProReview(disabled), false);
});

test('21. balanced default → review false unless pro_reviews_flash explicitly true', () => {
  assert.equal(shouldRunProReview(baseConfig()), false);
  assert.equal(shouldRunProReview(baseConfig({ pro_reviews_flash: true })), true);
});

test('21b. pro_reviews_flash on but pro manual → no automatic review', () => {
  const c = baseConfig({ pro_reviews_flash: true, collaboration_mode: 'custom', pro_state: 'manual' });
  assert.equal(shouldRunProReview(c), false);
});

test('21c. session collaboration mode overrides the global automatic-review mode', () => {
  const pipeline = baseConfig({ collaboration_mode: 'review-pipeline' });
  const balanced = baseConfig({ collaboration_mode: 'balanced' });
  assert.equal(shouldRunProReview(pipeline, { collaboration_mode: 'balanced' }), false);
  assert.equal(shouldRunProReview(balanced, { collaboration_mode: 'review-pipeline' }), true);
});

test('21d. session pro_reviews_flash overrides the global automatic-review choice', () => {
  const optedIn = baseConfig({ pro_reviews_flash: true });
  const optedOut = baseConfig({ pro_reviews_flash: false });
  assert.equal(shouldRunProReview(optedIn, { pro_reviews_flash: false }), false);
  assert.equal(shouldRunProReview(optedOut, { pro_reviews_flash: true }), true);
});

// ---------- roles ----------

test('22. unknown role values are dropped', () => {
  const c = normalizeGlobalConfig({ flash_roles: ['implementation', 'bogus', 'tests'] });
  assert.deepEqual(c.flash_roles, ['implementation', 'tests']);
});

test('23. duplicate roles are deduplicated with stable order', () => {
  const c = normalizeGlobalConfig({ pro_roles: ['refactor', 'refactor', 'code_review', 'refactor'] });
  assert.deepEqual(c.pro_roles, ['refactor', 'code_review']);
});

test('23b. empty/garbage roles fall back to tier defaults', () => {
  const c = normalizeGlobalConfig({ flash_roles: ['nope'], pro_roles: [] });
  assert.deepEqual(c.flash_roles, DEFAULT_FLASH_ROLES);
  assert.deepEqual(c.pro_roles, DEFAULT_PRO_ROLES);
});

test('validateRoles reports dropped entries', () => {
  const v = validateRoles(['implementation', 'implementation', 'wat']);
  assert.deepEqual(v.roles, ['implementation']);
  assert.deepEqual(v.dropped, ['wat']);
});

// ---------- multimodal capability ----------

test('24. vision_enabled=false → describe_image excluded, vision route excluded', () => {
  const plan = getMultimodalRegistrationPlan(normalizeGlobalConfig({ vision_enabled: false }));
  assert.equal(plan.tools.describe_image, false);
  assert.equal(plan.tools.generate_image, true);
  assert.equal(plan.visionRoute, false);
});

test('25. imagegen_enabled=false → generate_image excluded', () => {
  const plan = getMultimodalRegistrationPlan(normalizeGlobalConfig({ imagegen_enabled: false }));
  assert.equal(plan.tools.generate_image, false);
  assert.equal(plan.tools.describe_image, true);
  assert.equal(plan.visionRoute, true);
});

test('26. provider=off excludes the capability even when enabled=true', () => {
  const plan = getMultimodalRegistrationPlan(normalizeGlobalConfig({ vision_enabled: true, vision_provider: 'off', imagegen_enabled: true, imagegen_provider: 'off' }));
  assert.equal(plan.tools.describe_image, false);
  assert.equal(plan.tools.generate_image, false);
  assert.equal(plan.visionRoute, false);
});

test('27. turning a capability off does not erase stored provider/model', () => {
  const c = normalizeGlobalConfig({ vision_enabled: false, vision_provider: 'grok', vision_model: 'default', imagegen_enabled: false, imagegen_provider: 'agy' });
  assert.equal(c.vision_provider, 'grok');
  assert.equal(c.vision_model, 'default');
  assert.equal(c.imagegen_provider, 'agy');
});

test('capabilities report provider=off separately from switch', () => {
  const cap = getCapabilities(normalizeGlobalConfig({ vision_enabled: true, vision_provider: 'off' }));
  assert.equal(cap.vision.enabled, true);
  assert.equal(cap.vision.providerOff, true);
  assert.equal(cap.vision.usable, false);
});

// ---------- guidance & validation ----------

test('routing guidance mentions disabled tiers and main agent mode limits', () => {
  const c = baseConfig({ collaboration_mode: 'flash-only', main_agent_mode: 'dispatcher-only' });
  const g = getRoutingGuidance(c);
  assert.match(g, /Flash: Auto/);
  assert.match(g, /Pro: Disabled/);
  assert.match(g, /host guidance/);
  assert.match(g, /does not mean the task succeeded/);
  assert.match(g, /tests_status=FAIL/);
  assert.match(g, /tests_status=NOT RUN/);
});

test('routing guidance reflects full disablement', () => {
  const g = getRoutingGuidance(baseConfig({ subagents_enabled: false }));
  assert.match(g, /DISABLED/);
});

test('routing guidance reflects session collaboration and main-agent overrides', () => {
  const g = getRoutingGuidance(baseConfig({ collaboration_mode: 'balanced', main_agent_mode: 'coordinator-first' }), {
    collaboration_mode: 'flash-only',
    main_agent_mode: 'direct-allowed',
  });
  assert.match(g, /Flash is the only Auto tier/);
  assert.match(g, /Pro: Disabled/);
  assert.match(g, /Main agent mode .* direct-allowed/);
});

test('validateConfig flags review-pipeline with a disabled tier', () => {
  const v = validateConfig({ collaboration_mode: 'review-pipeline', pro_state: 'disabled' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.length >= 1);
});

test('preset resolution is deterministic', () => {
  assert.deepEqual(resolveCollaborationPreset(baseConfig({ collaboration_mode: 'flash-only' })), { flash: 'auto', pro: 'disabled' });
  assert.deepEqual(resolveCollaborationPreset(baseConfig({ collaboration_mode: 'pro-only' })), { flash: 'disabled', pro: 'auto' });
  assert.deepEqual(resolveCollaborationPreset(baseConfig({ collaboration_mode: 'review-pipeline' })), { flash: 'auto', pro: 'auto' });
  assert.deepEqual(resolveCollaborationPreset(baseConfig()), { flash: 'auto', pro: 'auto' });
});

test('isTierEnabled / isTierAutoEligible agree with effective state', () => {
  const c = baseConfig({ collaboration_mode: 'flash-only' });
  assert.equal(isTierEnabled(c, 'flash'), true);
  assert.equal(isTierEnabled(c, 'pro'), false);
  assert.equal(isTierAutoEligible(c, 'flash'), true);
  assert.equal(isTierAutoEligible(c, 'pro'), false);
});
