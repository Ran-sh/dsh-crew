// DSH host plugin: workers-hub.
// Runs DeepSeek workers as first-class in-host agent sessions (visible in the
// Web UI session list), exposes a loopback jobs API for the CC/Codex MCP shim,
// and serves the one-click installer endpoints for the settings page.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { createShardWriter, readMergedStatus } from '../status-shard.mjs';
import {
  normalizeGlobalConfig,
  chooseDefaultTier,
  normalizeWorkerProviderMode,
  getMultimodalRegistrationPlan,
  canDispatchRole,
  resolveModelPolicy,
  resolveRoleTierHint,
} from '../policy.mjs';
import { buildDirectSelectionTrace, resolveWorkerModel, resolveModel } from '../model-routing.mjs';
import { readHarnessModelCatalog } from '../model-catalog.mjs';
import { appendDeliveryInstructions, parseDeliveryReport, formatDeliveryMetadata } from '../delivery.mjs';
import { captureWorkspaceBaseline, captureWorkspaceDiff, NOT_A_GIT_REPOSITORY } from '../workspace-audit.mjs';
import { applyWorkspaceEvidence, buildOutcome, JOB_PHASES } from '../workflow.mjs';
import { boundedMachineCodeFromError } from '../structured-error-code.mjs';
import { createCanonicalJobEvent, projectWorkflowView } from '../job-contracts.mjs';
import { getHubRuntimeIdentity } from '../runtime-identity.mjs';
import { loadRoleProfiles, resolveRoleProfile, saveRoleProfiles } from '../role-profiles.mjs';
import { addContextReferences, buildWorkspaceTask, isSafeBranchName, loadWorkspaceContexts, resolveWorkspaceContext, saveWorkspaceContexts } from '../workspace-context.mjs';
import { buildExtensionContract } from '../extension-contract.mjs';
import { cleanupIsolatedWorkspace, createIsolatedWorkspace } from '../workspace-isolation.mjs';
import { assessWorkspaceReadiness } from '../workspace-readiness.mjs';
import { buildHubExecutionRows } from '../config-readiness.mjs';
import { localRequestCore, originLoopback } from '../local-request-guard.mjs';
import { raceWaiters } from '../removable-waiter.mjs';
import { buildProviderInventory } from '../provider-inventory.mjs';
import { buildProviderLayerMigrationPlan, executeProviderLayerMigration } from '../provider-layer-migration.mjs';
import { inspectProviderProfile, readProviderDeclarations, readProviderMaterialization } from '../provider-profile-store.mjs';
import { inspectProviderSettings, readHarnessDefault, readProviderSettingsDeclarations, readProviderSettingsMaterialization } from '../provider-settings-store.mjs';
import { normalizeProviderLifecycleState } from '../provider-lifecycle-state.mjs';
import { createProviderHealthStore } from '../provider-health.mjs';
import { planProviderDelete } from '../provider-lifecycle.mjs';
import { createProviderDeleteFileHooks, isRecoverableProviderDeleteBackup, readProviderDeleteManifestFile } from '../provider-delete-adapters.mjs';
import { buildCredentialReferenceInventory } from '../credential-reference-inventory.mjs';
import { executeCredentialPurge, planCredentialPurge } from '../credential-lifecycle.mjs';
import { createCredentialPurgeFileHooks } from '../credential-purge-adapters.mjs';
import { normalizeCredentialPurgeState, recordCredentialPurgeOutcome } from '../credential-purge-state.mjs';
import { buildRuntimeReadinessSnapshot } from '../runtime-readiness-snapshot.mjs';
import { createProviderLayerMigrationFileHooks, readProviderLayerMigrationTransactions } from '../provider-layer-migration-adapters.mjs';

// policy.mjs is pure (no @deepseek-ai imports, no ctx access), so importing it
// here is safe for the profile-realm discipline: it never pulls in package
// copies that would duplicate module realms.

// No @deepseek-ai imports here on purpose: this plugin is loaded into the
// profile realm, and importing our own package copies would create duplicate
// module realms (symbol identity mismatches in the tool runtime). Everything
// below is either plain data or inlined logic that only touches ctx APIs.

/** Inlined from @deepseek-ai/dsh-agent model-selection.ts (same semantics). */
function installModelSelection(agentCtx, selection) {
  agentCtx.on('system-prompt/assemble', async (_assembly, _cause, next) => {
    const selected = selection.current;
    const assembled = await next();
    selection.assembled = selected;
    if (selected === undefined) return assembled;
    return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } };
  });
  agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    const selected = selection.assembled;
    if (selected === undefined) return resolved;
    const { reasoningEffort: _inherited, ...rest } = resolved;
    return {
      ...rest, provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    };
  });
}

/** Inlined shape of createUserMessage (role + fresh id, frozen). */
function userMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
}

export const name = 'dsh-crew';
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'tools', 'llm', 'attachments'];

// Optional: the host's durable locale preference seeds server-side strings
// before the panel is ever opened. Absent preference means "browser decides".
function seedLangFromHost(ctx) {
  try {
    const pref = ctx.settings?.get?.('locale')?.preference;
    if (pref) setLang(pref);
  } catch { /* settings service absent or shaped differently — keep the default */ }
}

import { setLang } from '../i18n.mjs';

const ROUTE_BASE = '/_dsh/dsh-crew';
const LEGACY_TIER_MODELS = { flash: 'deepseek-v4-flash', pro: 'deepseek-v4-pro' };
// Local copy (the hub must not import jobs.mjs, which pulls the DSH SDK into
// the profile realm): a valid dispatch role set.
const ROLES = { worker: true, reviewer: true };
const CONFIG_DIR = join(homedir(), '.config', 'dsh-crew');
const CREDENTIAL_PURGE_STATE_FILE = join(CONFIG_DIR, 'credential-purge-lifecycle.json');
const RECOVERY_ACTION_PATTERN = /^[a-f0-9]{32}$/u;

function recoveryActionId(name) {
  return createHash('sha256').update(String(name)).digest('hex').slice(0, 32);
}

function isRecoveryControlEntry(name) {
  return name === '.quarantine'
    || name === '.delete.lock'
    || name === '.delete.reclaim.lock'
    || name === '.delete.recovery.lock'
    || name === '.delete.recovery.lock.claim'
    || /^\.delete\.lock\.[0-9a-f-]+\.(?:active|staging|retired)$/iu.test(name)
    || /^\.delete\.recovery\.lock\.[0-9a-f-]+\.stale$/iu.test(name);
}

function readProviderLifecycleStateStatus() {
  const file = join(CONFIG_DIR, 'provider-lifecycle.json');
  if (!existsSync(file)) return { ok: true, state: normalizeProviderLifecycleState() };
  try {
    return { ok: true, state: normalizeProviderLifecycleState(JSON.parse(readFileSync(file, 'utf8'))) };
  } catch {
    return { ok: false, code: 'PROVIDER_LIFECYCLE_UNAVAILABLE', state: normalizeProviderLifecycleState() };
  }
}

function readProviderLifecycleState() {
  return readProviderLifecycleStateStatus().state;
}

function readCredentialPurgeState() {
  try { return normalizeCredentialPurgeState(JSON.parse(readFileSync(CREDENTIAL_PURGE_STATE_FILE, 'utf8'))); } catch { return normalizeCredentialPurgeState(); }
}

export function readProviderRecoveryTransactions(root = join(CONFIG_DIR, 'provider-backups')) {
  if (!existsSync(root)) return [];
  try {
    const managedRoot = dirname(resolvePath(root));
    const paths = {
      profile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
      settings: join(CONFIG_DIR, 'harness', 'settings.yaml'),
      config: join(CONFIG_DIR, 'config.json'),
      lifecycle: join(CONFIG_DIR, 'provider-lifecycle.json'),
    };
    const transactions = readdirSync(root, { withFileTypes: true }).filter((entry) => !isRecoveryControlEntry(entry.name)).flatMap((entry) => {
      const transactionRoot = join(root, entry.name);
      const manifestFile = join(root, entry.name, 'manifest.json');
      const actionId = recoveryActionId(entry.name);
      if (!entry.isDirectory()) {
        let updatedAt;
        try { updatedAt = statSync(transactionRoot).mtime.toISOString(); } catch { updatedAt = new Date(0).toISOString(); }
        return [{ storage_id: entry.name, action_id: actionId, transaction_id: null, provider_id: null, phase: 'RECOVERY_UNRESOLVED', updated_at: updatedAt, recoverable: false, unresolved: true }];
      }
      try {
        const manifest = readProviderDeleteManifestFile(manifestFile, managedRoot);
        const transactionId = typeof manifest?.plan?.plan_id === 'string' ? manifest.plan.plan_id : null;
        const providerId = typeof manifest?.provider_id === 'string' ? manifest.provider_id : null;
        const phase = typeof manifest?.phase_journal?.phase === 'string' && manifest.phase_journal.phase.trim()
          ? manifest.phase_journal.phase.trim() : 'RECOVERY_INCOMPLETE';
        const updatedAt = typeof manifest?.phase_journal?.updated_at === 'string' && manifest.phase_journal.updated_at.trim()
          ? manifest.phase_journal.updated_at : statSync(manifestFile).mtime.toISOString();
        const hasPendingMutation = manifest?.mutation_journal && typeof manifest.mutation_journal === 'object'
          && Object.keys(manifest.mutation_journal).length > 0;
        const recoverable = transactionId != null && providerId != null && isRecoverableProviderDeleteBackup(manifest, {
          root: transactionRoot,
          managedRoot,
          paths,
          expectedProviderId: providerId,
        }) === true;
        if (['ROLLED_BACK', 'VERIFIED'].includes(phase) && !hasPendingMutation && recoverable) return [];
        return [{ storage_id: entry.name, action_id: actionId, transaction_id: transactionId ?? entry.name, provider_id: providerId, phase, updated_at: updatedAt, recoverable, unresolved: recoverable !== true }];
      } catch {
        let updatedAt;
        try { updatedAt = statSync(transactionRoot).mtime.toISOString(); } catch { updatedAt = new Date(0).toISOString(); }
        return [{
          storage_id: entry.name,
          action_id: actionId,
          transaction_id: null,
          provider_id: null,
          phase: 'RECOVERY_UNRESOLVED',
          updated_at: updatedAt,
          recoverable: false,
          unresolved: true,
        }];
      }
    });
    // Recovery is a safety gate, not a bounded history view. Never discard an
    // older unresolved transaction merely because newer entries exist.
    return transactions.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  } catch {
    let updatedAt;
    try { updatedAt = statSync(root).mtime.toISOString(); } catch { updatedAt = new Date(0).toISOString(); }
    return [{ storage_id: null, action_id: null, transaction_id: null, provider_id: null, phase: 'RECOVERY_UNRESOLVED', updated_at: updatedAt, recoverable: false, unresolved: true }];
  }
}

function writeCredentialPurgeState(state) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const temp = `${CREDENTIAL_PURGE_STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(normalizeCredentialPurgeState(state), null, 2) + '\n', 'utf8');
    renameSync(temp, CREDENTIAL_PURGE_STATE_FILE);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

function providerInventoryPolicy(config) {
  return {
    worker: config?.worker?.model_policy ?? {
      priority: config?.flash_model_priority,
      escalation_priority: config?.pro_model_priority,
    },
    reviewer: config?.review?.model_policy ?? {
      priority: config?.pro_model_priority,
      escalation_priority: [],
    },
  };
}

export function hasCompleteProviderCatalogEvidence(evidence) {
  return evidence?.ok === true && evidence.partial !== true;
}

export function hasCompleteProviderDeclarationEvidence(evidence) {
  return evidence?.ok === true
    && Object.values(evidence.sources ?? {}).every((source) => source?.present !== true || !source.code);
}

export function hasAvailableProviderLifecycleEvidence(evidence) {
  return evidence?.ok === true;
}

export function hasPendingProviderRecoveryTransactions(inventory) {
  return Array.isArray(inventory?.recovery_transactions) && inventory.recovery_transactions.length > 0;
}

export function hasProviderRuntimeRestartEvidence(beforeRuntimeId, currentRuntimeId) {
  return typeof beforeRuntimeId === 'string' && beforeRuntimeId.trim() !== ''
    && typeof currentRuntimeId === 'string' && currentRuntimeId.trim() !== ''
    && beforeRuntimeId !== currentRuntimeId;
}

/** Preserve profile/settings provenance when preparing the migration planner. */
export function buildProviderMigrationDeclarations(profileDeclarations = [], settingsDeclarations = []) {
  return [
    ...(Array.isArray(profileDeclarations) ? profileDeclarations : []),
    ...(Array.isArray(settingsDeclarations) ? settingsDeclarations : []),
  ];
}

async function readProviderInventorySnapshot(hub, ctx, config) {
  let catalog = { providers: [], harness_default: null };
  let catalogEvidence = { ok: false, code: 'MODEL_CATALOG_UNAVAILABLE' };
  try {
    catalog = await readHarnessModelCatalog({
      llm: ctx.llm ?? ctx.get('llm'),
      getCurrentSelection: () => ctx.get('agentDefaultModel')?.currentSelection?.(),
    });
    catalogEvidence = {
      ok: catalog.partial !== true,
      ...(catalog.partial === true ? { code: 'PROVIDER_CATALOG_INCOMPLETE' } : {}),
      provider_count: Number.isInteger(catalog.provider_count) ? catalog.provider_count : catalog.providers.length,
      refreshed_at: typeof catalog.refreshed_at === 'string' ? catalog.refreshed_at : null,
      partial: catalog.partial === true,
    };
  } catch {}
  const profileFile = join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml');
  let declarations = [];
  let profileDeclarations = [];
  let settingsDeclarations = [];
  const declarationEvidence = { ok: true, sources: {} };
  try {
    declarationEvidence.sources.profile = { present: existsSync(profileFile) };
    if (existsSync(profileFile)) {
      const source = readFileSync(profileFile, 'utf8');
      const parsed = readProviderDeclarations(source, { file: 'harness/profiles/dsh-crew/cordis.patch.yml' });
      if (parsed.ok) {
        profileDeclarations = parsed.declarations;
        declarations = profileDeclarations;
      }
      else { declarationEvidence.ok = false; declarationEvidence.sources.profile.code = parsed.code; }
    }
  } catch { declarationEvidence.ok = false; declarationEvidence.sources.profile = { present: true, code: 'PROVIDER_SOURCE_UNAVAILABLE' }; }
  const settingsFile = join(CONFIG_DIR, 'harness', 'settings.yaml');
  let settingsDefault = null;
  let defaultEvidence = { ok: true, source: 'none' };
  try {
    declarationEvidence.sources.settings = { present: existsSync(settingsFile) };
    if (existsSync(settingsFile)) {
      const source = readFileSync(settingsFile, 'utf8');
      const parsed = readProviderSettingsDeclarations(source, { file: 'harness/settings.yaml' });
      if (parsed.ok) {
        settingsDeclarations = parsed.declarations;
        declarations = [...declarations, ...settingsDeclarations];
      }
      else { declarationEvidence.ok = false; declarationEvidence.sources.settings.code = parsed.code; }
      const parsedDefault = readHarnessDefault(source);
      if (parsedDefault.ok) settingsDefault = parsedDefault;
      else defaultEvidence = { ok: false, code: 'PROVIDER_DEFAULT_AUTHORITY_UNAVAILABLE' };
    }
  } catch {
    declarationEvidence.ok = false;
    declarationEvidence.sources.settings = { present: true, code: 'PROVIDER_SOURCE_UNAVAILABLE' };
    defaultEvidence = { ok: false, code: 'PROVIDER_DEFAULT_AUTHORITY_UNAVAILABLE' };
  }
  const liveDefault = catalog.harness_default && typeof catalog.harness_default.provider === 'string' && typeof catalog.harness_default.model === 'string'
    ? { provider: catalog.harness_default.provider, model: catalog.harness_default.model } : null;
  const persistedDefault = settingsDefault ? { provider: settingsDefault.provider, model: settingsDefault.model } : null;
  if (liveDefault || persistedDefault) {
    if (!liveDefault || !persistedDefault) defaultEvidence = { ok: false, code: 'PROVIDER_DEFAULT_AUTHORITY_MISMATCH' };
    else if (liveDefault.provider !== persistedDefault.provider || liveDefault.model !== persistedDefault.model) defaultEvidence = { ok: false, code: 'PROVIDER_DEFAULT_AUTHORITY_MISMATCH' };
  }
  // The persisted agent-default-model is the mutation authority. Keep it in
  // the inventory even when the live selection is stale; the evidence gate
  // above prevents destructive operations until both sources agree.
  if (persistedDefault) {
    catalog = {
      ...catalog,
      harness_default: persistedDefault,
      harness_default_authority: { kind: 'harness-settings', locator: settingsDefault.locator },
    };
  }
  const lifecycleEvidence = readProviderLifecycleStateStatus();
  const lifecycle = lifecycleEvidence.state;
  const recoveryTransactions = [
    ...readProviderRecoveryTransactions(),
    ...readProviderLayerMigrationTransactions(join(CONFIG_DIR, 'provider-migration-backups')),
  ];
  const credentialPurge = readCredentialPurgeState();
  const inventory = buildProviderInventory({
    catalog,
    declarations,
    policy: providerInventoryPolicy(config),
    tombstones: lifecycle.tombstones,
    additionalProviderIds: [
      ...Object.keys(lifecycle.tombstones ?? {}),
      ...recoveryTransactions.map((entry) => entry.provider_id).filter((id) => typeof id === 'string' && id.trim()),
    ],
    activeJobs: hub.list(),
  });
  // Keep each authoritative source's credential reference with its own
  // declaration. Reconstructing from the merged inventory would silently
  // attach the first key to every layer when profile/settings differ.
  const migrationDeclarations = buildProviderMigrationDeclarations(profileDeclarations, settingsDeclarations);
  const routingReferences = [
    ...(config.flash_model_priority ?? []), ...(config.pro_model_priority ?? []),
    ...(config.worker?.model_policy?.priority ?? []), ...(config.worker?.model_policy?.escalation_priority ?? []),
    ...(config.review?.model_policy?.priority ?? []), ...(config.review?.model_policy?.escalation_priority ?? []),
  ];
  const migration = buildProviderLayerMigrationPlan({
    declarations: migrationDeclarations,
    catalogProviders: catalog.providers,
    harnessDefault: catalog.harness_default,
    routingReferences,
    tombstones: lifecycle.tombstones,
    recoveryTransactions,
    catalogEvidence,
    declarationEvidence,
    lifecycleEvidence,
    defaultEvidence,
  });
  return {
    ...inventory,
    migration,
    catalog_evidence: catalogEvidence,
    declaration_evidence: declarationEvidence,
    default_evidence: defaultEvidence,
    lifecycle_evidence: lifecycleEvidence.ok ? { ok: true } : { ok: false, code: lifecycleEvidence.code },
    credential_history_refs: Object.values(lifecycle.transactions ?? {})
      .flatMap((transaction) => Array.isArray(transaction?.credential_refs) ? transaction.credential_refs : []),
    credential_purged_refs: Object.keys(credentialPurge.purged),
    credential_purge_unverified: Object.entries(credentialPurge.unverified).map(([referenceId, record]) => ({
      reference_id: referenceId,
      transaction_id: record.transaction_id,
      state: record.state,
    })),
    lifecycle_transactions: Object.entries(lifecycle.transactions ?? {}).slice(-64).map(([transactionId, transaction]) => ({
      transaction_id: transactionId,
      provider_id: transaction.provider_id,
      state: transaction.state,
      ...(transaction.updated_at ? { updated_at: transaction.updated_at } : {}),
      ...(transaction.expected_revision ? { expected_revision: transaction.expected_revision } : {}),
    })),
    recovery_transactions: recoveryTransactions,
  };
}

function readProviderSourceRevisions() {
  const profileFile = join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml');
  const settingsFile = join(CONFIG_DIR, 'harness', 'settings.yaml');
  const read = (file, inspect) => {
    try {
      if (!existsSync(file)) return { ok: false, code: 'PROVIDER_SOURCE_MISSING', revision: null };
      const parsed = inspect(readFileSync(file, 'utf8'));
      return parsed.ok ? { ok: true, revision: parsed.revision } : { ok: false, code: parsed.code, revision: parsed.revision ?? null };
    } catch { return { ok: false, code: 'PROVIDER_SOURCE_UNAVAILABLE', revision: null }; }
  };
  return { profile: read(profileFile, inspectProviderProfile), settings: read(settingsFile, inspectProviderSettings) };
}

export function hubCanonicalEvents(job = {}) {
  if (!job.id) return [];
  const role = job.role === 'reviewer' ? 'reviewer' : 'worker';
  const atStart = job.startedAt ?? null;
  const atEnd = job.endedAt ?? atStart;
  const definitions = [
    ['job.created', atStart, { client_job_id: job.client_job_id ?? null }],
    ['job.started', atStart, {}],
    ['runtime.bound', atStart, {
      execution_plane: job.execution_context?.execution_plane ?? null,
      profile: job.execution_context?.profile ?? null,
      listen_port: Number.isInteger(job.execution_context?.listen_port) ? job.execution_context.listen_port : null,
      runtime_id: job.execution_context?.runtime_id ?? null,
    }],
    ['model.selected', atStart, { provider: job.provider ?? null, model: job.model ?? null, source: job.selection_source ?? null }],
    ['model.admitted', atStart, {
      provider: job.provider ?? null,
      model: job.model ?? null,
      health_state: job.health_state ?? 'unprobed',
      reason_code: job.health_reason_code ?? null,
      observed_at: Number.isFinite(job.health_observed_at) ? job.health_observed_at : null,
    }],
    [role === 'reviewer' ? 'review.started' : 'worker.started', atStart, { run_id: job.id }],
    ['agent.created', atStart, { run_id: job.id }],
  ];
  if (job.status !== 'running') {
    definitions.push([
      role === 'reviewer' ? 'review.completed' : 'worker.completed',
      atEnd,
      role === 'reviewer'
        ? { status: job.status ?? null, verdict: job.review?.verdict ?? null }
        : { status: job.status ?? null, summary: job.outcome?.task_status ?? null },
    ]);
    if (job.status === 'done') definitions.push(['job.completed', atEnd, { result_ref: job.id }]);
    else if (job.status === 'cancelled') definitions.push(['job.cancelled', atEnd, { reason: 'cancelled' }]);
    else definitions.push(['job.failed', atEnd, { error_code: job.error_code ?? null }]);
  }
  return definitions.map(([type, at, data], index) => createCanonicalJobEvent({
    jobId: job.id, type, sequence: index + 1, at, role, attempt: job.attempt ?? 0, data,
  }));
}

// ---------- job registry ----------

export function applyHubWorkspaceEvidence({ outcome, workspaceDiff, allowNoChanges = false, isolation = 'shared', role = 'worker' } = {}) {
  const changes = workspaceDiff?.changes ?? {};
  const hasChanges = ['modified', 'deleted', 'renamed', 'untracked']
    .some((key) => Array.isArray(changes[key]) && changes[key].length > 0);
  const evidenceAvailable = workspaceDiff?.kind === 'git' && workspaceDiff.dirtyBaseline !== true;
  return applyWorkspaceEvidence(outcome, {
    evidenceAvailable,
    hasChanges,
    allowNoChanges: allowNoChanges === true && isolation === 'worktree',
    requireNoChangeAuthorization: role === 'worker',
  });
}

/**
 * Build the explicit provider callability probe used by the 3210 lifecycle
 * route. It performs one token-bounded Harness stream through the same llm
 * runtime used by WorkerRegistry; no credential values are read or returned.
 */
export function createProviderProbe(ctx) {
  const llm = ctx?.llm ?? ctx?.get?.('llm');
  if (!llm || typeof llm.stream !== 'function') return null;
  return async ({ provider, model, signal }) => {
    try {
      const stream = llm.stream({
        provider,
        model,
        messages: [userMessage('dsh-crew provider probe')],
        maxTokens: 1,
        temperature: 0,
        signal,
      });
      for await (const chunk of stream) {
        if (chunk?.type !== 'finish') continue;
        const reason = chunk.reason;
        if (reason?.kind === 'error' || reason?.kind === 'aborted') {
          return { ok: false, error: reason.failure ?? { code: `PROVIDER_PROBE_${String(reason.kind).toUpperCase()}` } };
        }
        return { ok: true };
      }
      return { ok: false, error: { code: 'PROVIDER_PROBE_NO_FINISH' } };
    } catch (error) {
      return { ok: false, error };
    }
  };
}

/** Pick the first configured model for a provider, falling back to its live catalog. */
export function selectProviderProbeModel({ providerId, record, config } = {}) {
  const advertised = new Set(Array.isArray(record?.models) ? record.models.filter((model) => typeof model === 'string') : []);
  if (advertised.size === 0) return null;
  const priorities = [
    ...(Array.isArray(config?.worker?.model_policy?.priority) ? config.worker.model_policy.priority : []),
    ...(Array.isArray(config?.flash_model_priority) ? config.flash_model_priority : []),
    ...(Array.isArray(config?.review?.model_policy?.priority) ? config.review.model_policy.priority : []),
    ...(Array.isArray(config?.pro_model_priority) ? config.pro_model_priority : []),
  ];
  for (const ref of priorities) {
    if (ref?.provider === providerId && advertised.has(ref.model)) return ref.model;
  }
  return [...advertised][0];
}

// Exported for the unit tests (test/hub-windows.test.mjs); instantiation
// needs only a duck-typed ctx, so spawn()'s path guard is testable without a
// live DSH host.
export class WorkerRegistry {  constructor(ctx) {
    this.ctx = ctx;
    this.jobs = new Map();
    this.providerMutations = new Set();
    this.providerMutationEpochs = new Map();
    this.providerLeases = new Map();
    this.nextId = 1;
    this.shard = createShardWriter('hub');
    this.healthStore = createProviderHealthStore();
  }

  view(job, withResult = false) {
    const v = {
      id: job.id, client_job_id: job.client_job_id ?? null, sessionId: job.sessionId, role: job.role ?? 'worker', attempt: job.attempt ?? 0,
      tier: job.tier, provider: job.provider, model: job.model,
      selection_source: job.selection_source,
      selection_trace: job.selection_trace ?? null,
      effort: job.effort, requested_effort: job.effort, reasoning_effort: job.reasoning_effort ?? null,
      status: job.status, source: job.source, task: job.task.slice(0, 300),
      cwd: job.cwd, turn: job.turn, step: job.step, currentTool: job.currentTool,
      phase: job.phase ?? null,
      toolCalls: job.toolCalls, tokens: job.tokens, mode: 'hub',
      startedAt: job.startedAt, endedAt: job.endedAt,
      isolation: job.isolation ?? 'shared', workspace_branch: job.workspace_branch ?? null,
      delivery_complete: !!job.delivery_complete,
      allow_no_changes: job.allow_no_changes === true,
      task_status: job.outcome?.task_status ?? null,
      workspace_evidence_ok: job.outcome?.workspace_evidence_ok ?? null,
      review_verdict: job.review?.verdict ?? null,
      workspace_diff_available: !!job.workspaceDiff && job.workspaceDiff.kind === 'git',
      workspace_retained: job.workspace_retained === true,
      cleanup_warning: job.cleanup_warning ?? null,
      profile_id: job.profile_id ?? null,
      workspace_context: job.workspace_context ?? null,
      execution_context: job.execution_context ?? null,
      event_cursor: hubCanonicalEvents(job).at(-1)?.sequence ?? 0,
    };
    if (withResult) {
      v.result = job.result; v.error = job.error; v.stopReason = job.stopReason;
      v.reasonDetail = job.reasonDetail;
      v.delivery = job.delivery_metadata ?? null;
      v.delivery_missing = job.delivery_missing ?? [];
      v.outcome = job.outcome ?? null;
      v.review = job.review ?? null;
      v.workspace_diff = job.workspaceDiff ?? null;
      v.workspace_baseline_dirty = !!job.workspaceDiff?.dirtyBaseline;
      v.canonical_events = hubCanonicalEvents(job);
    }
    return v;
  }

  list() {
    return [...this.jobs.values()].map((job) => this.view(job));
  }

  beginProviderMutation(providerId) {
    if (typeof providerId !== 'string' || !providerId.trim() || this.providerMutations.has(providerId)) return false;
    this.providerMutationEpochs.set(providerId, (this.providerMutationEpochs.get(providerId) ?? 0) + 1);
    this.providerMutations.add(providerId);
    return true;
  }

  endProviderMutation(providerId) {
    this.providerMutations.delete(providerId);
  }

  getProviderMutationEpoch(providerId) {
    return this.providerMutationEpochs.get(providerId) ?? 0;
  }

  assertProviderNotMutating(providerId, expectedEpoch = undefined) {
    if (this.providerMutations.has(providerId)
      || (expectedEpoch !== undefined && this.getProviderMutationEpoch(providerId) !== expectedEpoch)) {
      throw Object.assign(new Error('provider mutation is active'), { code: 'PROVIDER_DELETE_BUSY' });
    }
  }

  acquireProviderLease(providerId) {
    this.providerLeases.set(providerId, (this.providerLeases.get(providerId) ?? 0) + 1);
  }

  releaseProviderLease(providerId) {
    const count = this.providerLeases.get(providerId) ?? 0;
    if (count <= 1) this.providerLeases.delete(providerId);
    else this.providerLeases.set(providerId, count - 1);
  }

  hasProviderLease(providerId) {
    return (this.providerLeases.get(providerId) ?? 0) > 0;
  }

  // Profile/settings are shared stores. A migration or delete of provider A
  // must fence a concurrent lifecycle write for provider B in this Hub.
  beginProviderStoreMutation() { return this.beginProviderMutation('__dsh-provider-store__'); }
  endProviderStoreMutation() { this.endProviderMutation('__dsh-provider-store__'); }
  hasProviderStoreMutation() { return this.providerMutations.has('__dsh-provider-store__'); }

  publish() {
    this.shard.publish([...this.jobs.values()].map((j) => this.view(j)));
  }

  /**
   * Spawn a Hub worker. DeepSeek Official preserves the standalone-compatible
   * tier slots; follow-dsh resolves an ordered provider/model selection from
   * the live Harness catalog. Callers cannot route around either policy.
   *
   * `role` (worker | reviewer) records who does the work; `tier` remains the
   * legacy model-class slot. Reviewer-role jobs always use the pro slot.
   */
  async spawn({ task, tier = 'flash', role, attempt = 0, effort = 'max', cwd, source = 'api', preset, delivery = 'coding', client_job_id, requested_isolation, workspace_branch, timeout_seconds, profile_id, workspace_context, allow_no_changes, ingress = 'direct-3210' }) {
    // role is only honored when the caller explicitly names it; a legacy
    // tier-only spawn (role === undefined) keeps the exact v0.1 resolution.
    const hasRole = role === 'worker' || role === 'reviewer';
    if (role !== undefined && !hasRole) throw new Error(`unknown role "${role}"`);
    const effRole = hasRole ? role : 'worker';
    // A reviewer is a role, not a model class: its tier slot is always pro.
    const effTier = role === 'reviewer' ? 'pro' : tier;
    const legacyModel = LEGACY_TIER_MODELS[effTier];
    if (!legacyModel) throw new Error(`unknown tier "${effTier}"`);
    if (!['off', 'high', 'max'].includes(effort)) throw new Error(`unknown effort "${effort}"`);
    // isAbsolute covers POSIX (/...) and Windows drive paths (D:\... / D:/...):
    // on Windows the MCP shim always passes process.cwd() in drive form.
    if (!cwd || !isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
    await this.ctx.get('loader')?.await();

    // Provider routing: follow-dsh reads the DSH Models selection live; the
    // default deepseek-official keeps legacy setups unchanged. Re-resolved on
    // every spawn so a Models change takes effect on the next worker.
    const cfg = normalizeGlobalConfig(this.getConfig?.() ?? {});
    const lifecycleState = readProviderLifecycleState();
    const healthGate = cfg.health_gate ?? cfg.worker?.model_policy?.health_gate;
    const workerProviderMode = normalizeWorkerProviderMode(cfg.worker_provider_mode);
    const getCurrentSelection = () => this.ctx.get('agentDefaultModel')?.currentSelection?.();
    let selection;
    if (workerProviderMode === 'deepseek-official') {
      selection = {
        ok: true,
        provider: 'deepseek-official',
        model: legacyModel,
        source: 'legacy-strict',
        reasoningEffort: effort,
        selection_trace: buildDirectSelectionTrace({
          role: effRole,
          logicalAttempt: attempt,
          modelClassHint: effTier,
          strategy: 'legacy-strict',
          candidateSet: attempt > 0 ? 'escalation' : 'primary',
          provider: 'deepseek-official',
          model: legacyModel,
          source: 'legacy-strict',
        }),
      };
    } else {
      let catalog;
      try {
        catalog = await readHarnessModelCatalog({
          llm: this.ctx.llm ?? this.ctx.get('llm'),
          getCurrentSelection,
        });
      } catch {
        // Older/mocked hosts without the catalog surface can still route the
        // current Harness default without exposing any credential fields.
        const current = getCurrentSelection();
        catalog = current?.provider
          ? { providers: [{ id: current.provider, name: current.provider, models: [] }], harness_default: current }
          : { providers: [], harness_default: null };
      }
      // v0.2 role-based selection only when the caller named a role; legacy
      // tier-only spawns resolve through the tier resolver exactly as before.
      if (hasRole) {
        const policy = resolveModelPolicy(cfg, effRole, { attempt });
        selection = resolveModel({
          role: effRole,
          attempt,
          policy,
          catalog,
          harnessDefault: catalog.harness_default ?? getCurrentSelection(),
          healthStore: this.healthStore,
          healthGate: policy.health_gate ?? healthGate,
          allowFallback: cfg.allow_fallback !== false,
          tombstones: lifecycleState.tombstones,
        });
      } else {
        selection = resolveWorkerModel({
          tier: effTier,
          priority: cfg[`${effTier}_model_priority`],
          priorityConfigured: cfg[`${effTier}_model_priority_configured`],
          fallback: cfg[`${effTier}_model_fallback`],
          catalog,
          harnessDefault: catalog.harness_default ?? getCurrentSelection(),
          healthStore: this.healthStore,
          healthGate,
          allowFallback: cfg.allow_fallback !== false,
          tombstones: lifecycleState.tombstones,
          traceContext: {
            role: effRole,
            logicalAttempt: attempt,
            modelClassHint: effTier,
            strategy: 'legacy-tier',
            candidateSet: attempt > 0 ? 'escalation' : 'primary',
          },
        });
    }
    if (!selection.ok) throw Object.assign(new Error(selection.message), { policyCode: selection.code });
    }
    const pendingLayerMigration = readProviderLayerMigrationTransactions(join(CONFIG_DIR, 'provider-migration-backups'))
      .find((entry) => entry.unresolved === true || entry.provider_id === selection.provider);
    if (pendingLayerMigration) throw Object.assign(new Error('provider layer migration is pending verification'), { code: 'PROVIDER_MIGRATION_PENDING' });
    // A process restart clears the in-memory mutation fence, so persisted
    // provider-delete transactions must also gate admission. Unknown-owner
    // recovery entries fence globally; known entries fence their provider.
    const pendingProviderDelete = readProviderRecoveryTransactions()
      .find((entry) => entry.unresolved === true || entry.provider_id === selection.provider);
    if (pendingProviderDelete) throw Object.assign(new Error('provider delete recovery is pending'), { code: 'PROVIDER_DELETE_RECOVERY_PENDING' });
    const providerMutationEpoch = this.getProviderMutationEpoch(selection.provider);
    this.assertProviderNotMutating(selection.provider, providerMutationEpoch);

    // The worker always gets the auditable Delivery Contract appended (unless
    // it already carries one), so its final message follows ## Diff / ## Tests
    // / ## Risks — or the review contract for reviewer-role jobs.
    const jobRole = hasRole ? role : (delivery === 'review' || role === 'reviewer' ? 'reviewer' : 'worker');
    const workerPrompt = appendDeliveryInstructions(task, { tier: effTier, role: jobRole, isReview: delivery === 'review' || jobRole === 'reviewer' });

    const id = `hub-${this.nextId++}-${Date.now().toString(36)}`;

    // Resolve presets before any side effect (registry entry, worktree): a
    // rejected preset must fail spawn() cleanly instead of leaving a ghost
    // "running" job and a leaked worktree behind.
    const presets = this.ctx.get('agentPresets');
    const wanted = preset ?? (tier === 'flash' ? cfg.preset_flash : cfg.preset_pro);
    const presetId = presets === undefined
      ? undefined
      : (await presets.resolve(!wanted || wanted === 'default' ? undefined : wanted)).id;

    let executionCwd = cwd;
    let isolatedWorkspace = null;
    if ((requested_isolation === 'worktree' && jobRole === 'worker') || requested_isolation === 'readonly') {
      const created = await createIsolatedWorkspace({ cwd, jobId: id, baseRevision: workspace_branch });
      if (!created.ok) throw Object.assign(new Error(created.error ?? created.reason), { code: created.reason });
      executionCwd = created.worktreePath;
      isolatedWorkspace = { worktreePath: created.worktreePath, repoRoot: created.repoRoot };
    }
    const sessionId = `session-${randomUUID()}`;
    const job = {
      id, client_job_id: client_job_id ?? null, sessionId, role: jobRole, attempt, tier: effTier, provider: selection.provider, model: selection.model,
      selection_source: selection.source, selection_trace: selection.selection_trace ?? null,
      effort, reasoning_effort: selection.reasoningEffort,
      task, source, cwd: executionCwd, requested_cwd: cwd,
      isolation: isolatedWorkspace ? 'worktree' : 'shared',
      execution_context: (() => {
        const runtime = getHubRuntimeIdentity();
        return {
          execution_plane: runtime.execution_plane,
          profile: runtime.profile,
          listen_port: runtime.listen_port,
          runtime_id: runtime.runtime_id,
          ingress: ingress === 'official-3080' ? 'official-3080' : 'direct-3210',
        };
      })(),
      allow_no_changes: allow_no_changes === true,
      workspace_branch: workspace_branch ?? null, isolatedWorkspace,
      profile_id: profile_id ?? null, workspace_context: workspace_context ?? null,
      prompt: workerPrompt, delivery: delivery === 'review' ? 'review' : 'coding',
      phase: JOB_PHASES.RUNNING,
      status: 'running', turn: 0, step: 0, currentTool: null, toolCalls: 0,
      tokens: { input: 0, output: 0, reasoning: 0 },
      startedAt: new Date().toISOString(), endedAt: null,
      result: null, error: null, stopReason: null, handle: null, waiters: [],
      delivery_complete: false, delivery_missing: [], delivery_metadata: null,
      outcome: null,
      lastAssistantText: null, handle_dispose_promise: null, disposeHandle: null,
      // Abort latch: cancel()/timeout set this the moment the job becomes
      // terminal, even while agents.create() is still pending, so a handle
      // acquired after that point is disposed instead of being driven.
      abortRequested: false,
      abortPromise: null,
      resolveAbort: null,
      providerLease: false,
      providerLeaseReleaseBlocked: false,
      lateHandleCreated: false,
      lateCreateCleanupPromise: null,
    };
    job.abortPromise = new Promise((resolve) => { job.resolveAbort = resolve; });
    const disposeJobHandle = async () => {
      if (!job.handle) return;
      if (!job.handle_dispose_promise) {
        try {
          job.handle_dispose_promise = Promise.resolve(job.handle.dispose());
        } catch (error) {
          job.handle_dispose_promise = Promise.reject(error);
        }
      }
      try {
        await job.handle_dispose_promise;
      } catch (error) {
        // A failed disposer is not proof that the provider is idle. Keep the
        // lease fenced even when the job is already terminal; the operator
        // must restart/reclaim the owned runtime before deletion can proceed.
        job.providerLeaseReleaseBlocked = true;
        throw error;
      }
    };
    job.disposeHandle = disposeJobHandle;
    // Read-only pre-run snapshot (async, never blocks dispatch): the audit
    // only needs the before-state by the time the worker finishes. Non-repos
    // degrade to { kind:'no-git' } instead of failing the job.
    job.baseline = await captureWorkspaceBaseline({ cwd: executionCwd }).catch(() => ({ kind: 'no-git', reason: NOT_A_GIT_REPOSITORY, error: 'workspace audit failed' }));
    try {
      this.assertProviderNotMutating(selection.provider, providerMutationEpoch);
      this.acquireProviderLease(selection.provider);
      job.providerLease = true;
    } catch (error) {
      if (isolatedWorkspace) await cleanupIsolatedWorkspace({ repoRoot: isolatedWorkspace.repoRoot, worktreePath: isolatedWorkspace.worktreePath }).catch(() => {});
      throw error;
    }
    this.jobs.set(id, job);

    const onEvent = (session, event) => {
      switch (event.type) {
        case 'step/start':
          job.turn = event.data?.turn ?? job.turn;
          job.step = event.data?.step ?? job.step;
          break;
        case 'tool/call': job.currentTool = event.data?.name ?? null; job.toolCalls += 1; break;
        case 'tool/result': job.currentTool = null; break;
        case 'assistant/message': {
          const u = event.data?.usage;
          if (u) {
            job.tokens.input += u.inputTokens ?? 0;
            job.tokens.output += u.outputTokens ?? 0;
            job.tokens.reasoning += u.reasoningTokens ?? 0;
          }
          const text = (event.data?.message?.content ?? [])
            .filter((c) => c?.type === 'text').map((c) => c.text).join('');
          if (text) job.lastAssistantText = text;
          break;
        }
        case 'turn/end':
          job.stopReason = event.data?.reason?.kind ?? null;
          job.reasonDetail = event.data?.reason;
          break;
      }
      this.publish();
    };

    const run = async () => {
      const createPromise = this.ctx.agents.create({
        sessionId,
        meta: { cwd: executionCwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined });
          if (presets !== undefined) await presets.mount(agentCtx, presetId);
          agentCtx.on('session/event', onEvent);
          agentCtx.on('agent/error', (payload) => {
            const err = payload?.error;
            job.error = err?.message ?? String(err);
          });
        },
      });
      const created = await Promise.race([
        createPromise.then((handle) => ({ handle })),
        job.abortPromise.then(() => ({ aborted: true })),
      ]);
      if (created.aborted) {
        job.lateCreateCleanupPromise = createPromise.then(async (handle) => {
          if (!handle) return;
          job.lateHandleCreated = true;
          job.handle = handle;
          if (job.status !== 'running' || job.abortRequested) await job.disposeHandle();
        }).catch((error) => {
          job.cleanup_warning = `late agent creation failed: ${error?.message ?? String(error)}`;
          throw error;
        });
        return;
      }
      const handle = created.handle;
      job.handle = handle;
      // The job may have become terminal (cancel/timeout) while create() was
      // pending; the old disposer was a no-op in that window. Dispose the
      // freshly acquired handle and never deliver the prompt.
      if (job.status !== 'running' || job.abortRequested) {
        try { await job.disposeHandle(); } catch (error) {
          job.cleanup_warning = `agent cleanup failed: ${error?.message ?? String(error)}`;
        }
        return;
      }
      try {
        // Group the worker session under the workspace of its cwd; create the
        // workspace when none exists yet (resolveByPath is exact-match, so a
        // job cwd never inherits a parent directory's workspace).
        const registry = this.ctx.get('workspaceRegistry');
        if (registry !== undefined) {
          const ws = (await registry.resolveByPath(executionCwd)) ?? (await registry.create(executionCwd));
          await ws.attachSession(sessionId);
        }
      } catch (err) {
        this.ctx.logger?.warn?.(`dsh-crew: workspace attach failed for ${executionCwd}: ${err?.message ?? err}`);
      }
      await handle.agent.whenIdle();
      // Cancel/timeout may have become terminal while waiting for the initial
      // idle boundary; do not deliver the prompt to a job that is no longer
      // running. The shared finally block still disposes the handle exactly once.
      if (job.status !== 'running' || job.abortRequested) return;
      handle.agent.followup(userMessage(job.prompt));
      await handle.agent.whenIdle();
      job.result = job.lastAssistantText ?? '';
      if (job.status === 'running') job.status = job.stopReason === 'completed' ? 'done' : 'failed';
      if (job.status === 'failed' && !job.error) job.error = `turn ended: ${job.stopReason ?? 'unknown'}`;
      await this.ctx.sessions.flush(handle.agent.session);
    };

    const timeoutMs = Number.isInteger(timeout_seconds) && timeout_seconds > 0 ? timeout_seconds * 1000 : null;
    if (timeoutMs) {
      job.timeoutHandle = setTimeout(async () => {
        if (job.status !== 'running') return;
        job.abortRequested = true;
        job.status = 'failed';
        job.phase = JOB_PHASES.FAILED;
        job.error = `job timed out after ${timeout_seconds}s`;
        job.error_code = 'JOB_TIMEOUT';
        job.endedAt = new Date().toISOString();
        job.resolveAbort?.();
        this.publish();
        for (const waiter of job.waiters.splice(0)) waiter();
        try { await disposeJobHandle(); } catch (error) {
          job.cleanup_warning = `agent cleanup failed: ${error?.message ?? String(error)}`;
          this.publish();
        }
      }, timeoutMs);
      job.timeoutHandle.unref?.();
    }
    job.promise = run()
      .catch((err) => {
        if (job.status === 'running') job.status = 'failed';
        job.error = job.error ?? (err?.message ?? String(err));
      })
      .finally(async () => {
        if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
        job.endedAt = new Date().toISOString();
        job.currentTool = null;
        let handleCleanupWarning = job.cleanup_warning ?? null;
        try { await disposeJobHandle(); } catch (error) {
          handleCleanupWarning = `agent cleanup failed: ${error?.message ?? String(error)}`;
        }
        if (job.providerLease) {
          const releaseLease = () => {
            if (!job.providerLease) return;
            this.releaseProviderLease(job.provider);
            job.providerLease = false;
          };
          if (job.lateCreateCleanupPromise) {
            job.lateCreateCleanupPromise.then(releaseLease).catch(() => {
              if (!job.lateHandleCreated && !job.providerLeaseReleaseBlocked) releaseLease();
              // A late-created handle that failed disposal remains fenced by
              // the provider lease until an operator restarts/reclaims it.
            });
          } else if (!job.providerLeaseReleaseBlocked) releaseLease();
        }
        // Delivery completeness is separate from execution status: a job can
        // be done yet fail to report Diff/Tests/Risks (or Review sections for
        // an automatic review). Parse whatever final message the worker
        // produced so the orchestrator can decide whether to accept.
        const parsed = parseDeliveryReport(job.result ?? '');
        job.delivery_complete = parsed.complete;
        job.delivery_missing = parsed.missing;
        job.delivery_metadata = formatDeliveryMetadata(parsed);
        if (job.role === 'reviewer') {
          const verdictText = String(parsed.sections?.Verdict ?? '').trim().toLowerCase();
          const verdict = /^(approve|approved|pass)\b/.test(verdictText)
            ? 'approve'
            : /request.*chang|chang.*request|reject|needs changes/i.test(verdictText)
              ? 'request_changes'
              : 'inconclusive';
          const lines = (value) => String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 40);
          job.review = {
            verdict, status: job.status, delivery_complete: parsed.complete === true,
            findings: lines(parsed.sections?.['Review Findings']),
            evidence: lines(parsed.sections?.Evidence), risks: lines(parsed.sections?.Risks),
          };
        }
        // Canonical structured outcome (shared workflow layer) + terminal phase.
        job.outcome = buildOutcome({
          result: job.result ?? '',
          deliveryMeta: job.delivery_metadata,
          executionStatus: job.status === 'done' ? 'completed' : 'failed',
          stopReason: job.stopReason,
          deliveryMissing: job.delivery_missing,
        });
        job.phase = job.status === 'done' ? JOB_PHASES.COMPLETED : job.status === 'cancelled' ? JOB_PHASES.CANCELLED : JOB_PHASES.FAILED;
        // Read-only after-snapshot of the workspace: bounded, redacted patch.
        job.workspaceDiff = job.baseline.kind === 'git'
          ? await captureWorkspaceDiff({ cwd: executionCwd, baseline: job.baseline }).catch(() => ({ kind: 'no-git', reason: NOT_A_GIT_REPOSITORY, error: 'workspace diff failed' }))
          : job.baseline;
        job.outcome = applyHubWorkspaceEvidence({
          outcome: job.outcome,
          workspaceDiff: job.workspaceDiff,
          allowNoChanges: job.allow_no_changes,
          isolation: job.isolation,
          role: job.role,
        });
        // Record only sanitized callability evidence. Cancelled jobs are
        // operator actions, not provider health signals.
        if (job.status !== 'cancelled') {
          this.healthStore.record(job.provider, job.model, {
            ok: job.status === 'done',
            observed_at: Date.parse(job.endedAt ?? '') || Date.now(),
            error: { code: job.error_code, message: job.error },
          });
        }
        if (job.role === 'reviewer' && job.review && job.workspaceDiff?.kind === 'git') {
          const changes = job.workspaceDiff.changes ?? {};
          const mutated = ['modified', 'deleted', 'renamed', 'untracked'].some((key) => Array.isArray(changes[key]) && changes[key].length > 0);
          if (mutated) {
            job.review.mutated_candidate = true;
            job.review.invalidated = true;
            job.review.verdict = 'request_changes';
          }
        }
        if (job.isolatedWorkspace) {
          const cleanup = await cleanupIsolatedWorkspace(job.isolatedWorkspace).catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
          job.workspace_retained = cleanup.ok !== true;
          const workspaceCleanupWarning = cleanup.ok === true ? null : cleanup.error ?? 'worktree cleanup failed';
          job.cleanup_warning = [handleCleanupWarning, workspaceCleanupWarning].filter(Boolean).join('; ') || null;
        } else {
          job.cleanup_warning = handleCleanupWarning;
        }
        this.publish();
        for (const w of job.waiters.splice(0)) w();
      });

    this.publish();
    return job;
  }

  async wait(id, timeoutMs) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status !== 'running') return job;
    await raceWaiters(job.waiters, { timeoutMs, immediateWithoutTimeout: true });
    return job;
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === 'running') {
      job.abortRequested = true;
      job.status = 'cancelled';
      job.phase = JOB_PHASES.CANCELLED;
      job.error = 'cancelled by request';
      job.resolveAbort?.();
      for (const waiter of job.waiters.splice(0)) waiter();
      try { await job.disposeHandle?.(); } catch (error) {
        job.cleanup_warning = `agent cleanup failed: ${error?.message ?? String(error)}`;
      }
      this.publish();
    }
    return job;
  }

  async dispose() {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') {
        try { await job.disposeHandle?.(); } catch (error) {
          job.cleanup_warning = `agent cleanup failed: ${error?.message ?? String(error)}`;
        }
      }
    }
  }
}

// ---------- loopback route helpers (pattern from dsh-noema) ----------

// The common trust core and its Origin policies live in one shared module so
// the hub and the 3080 bridge cannot drift apart (see local-request-guard.mjs).
export function isLoopbackRequest(req) {
  if (!localRequestCore(req)) return false;
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  return originLoopback(origin);
}
function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}
/**
 * The panel is the authority on the active locale (DSH's setting may be unset,
 * leaving it to the browser), so it tags requests with ?lang= / body.lang and
 * the hub adopts it. Conversation-side paths with no request behind them —
 * pasted-image transcription — then follow the same language.
 */
function adoptLang(value) {
  if (value === 'zh' || value === 'en') setLang(value);
}

async function readBody(req, limit = 64 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('payload too large');
  }
  return body.trim() === '' ? {} : JSON.parse(body);
}

/**
 * Resolve a direct-hub spawn payload against the global policy.
 * Pure helper (no ctx / no I/O) so the jobs route and the unit tests share
 * the exact same normalization: the tier that finally reaches the worker
 * runtime is always the policy resolver's effective tier, never a raw or
 * missing request field.
 *
 * Returns { ok: true, payload } (payload.tier = effective tier) or
 * { ok: false, code, error }.
 */
export function resolveHubSpawnPayload(payload, getConfig = () => ({}), dependencies = {}) {
  const config = normalizeGlobalConfig(getConfig());
  const raw = payload ?? {};
  const advanced = raw.profile !== undefined || raw.workspace_id !== undefined || raw.workspace !== undefined
    || raw.constraints !== undefined || raw.context_refs !== undefined || raw.job_id !== undefined || raw.objective !== undefined;
  let normalized = { ...raw };
  if (advanced) {
    if (raw.workspace !== undefined && (!raw.workspace || typeof raw.workspace !== 'object' || Array.isArray(raw.workspace))) {
      return { ok: false, code: 'WORKSPACE_REQUEST_INVALID', error: 'workspace must be an object' };
    }
    if (raw.constraints !== undefined && (!raw.constraints || typeof raw.constraints !== 'object' || Array.isArray(raw.constraints))) {
      return { ok: false, code: 'JOB_CONSTRAINTS_INVALID', error: 'constraints must be an object' };
    }
    if (raw.workspace?.repo_root !== undefined && typeof raw.workspace.repo_root !== 'string') {
      return { ok: false, code: 'WORKSPACE_REQUEST_INVALID', error: 'workspace repo_root must be a string' };
    }
    if (raw.workspace?.worktree !== undefined && !['auto', 'existing', 'none'].includes(raw.workspace.worktree)) {
      return { ok: false, code: 'WORKSPACE_REQUEST_INVALID', error: 'invalid worktree policy' };
    }
    if (raw.workspace?.branch !== undefined && !isSafeBranchName(raw.workspace.branch)) {
      return { ok: false, code: 'WORKSPACE_REQUEST_INVALID', error: 'invalid workspace branch' };
    }
    if (raw.constraints?.timeout_seconds !== undefined && (!Number.isInteger(raw.constraints.timeout_seconds) || raw.constraints.timeout_seconds < 1 || raw.constraints.timeout_seconds > 7200)) {
      return { ok: false, code: 'JOB_CONSTRAINTS_INVALID', error: 'invalid timeout_seconds' };
    }
    if (raw.constraints?.allow_fallback !== undefined && typeof raw.constraints.allow_fallback !== 'boolean') {
      return { ok: false, code: 'JOB_CONSTRAINTS_INVALID', error: 'allow_fallback must be boolean' };
    }
    if (raw.constraints?.allow_no_changes !== undefined && typeof raw.constraints.allow_no_changes !== 'boolean') {
      return { ok: false, code: 'JOB_CONSTRAINTS_INVALID', error: 'allow_no_changes must be boolean' };
    }
    const profileRegistry = dependencies.profileRegistry ?? loadRoleProfiles();
    const workspaceRegistry = dependencies.workspaceRegistry ?? loadWorkspaceContexts();
    if (!profileRegistry.ok) return { ok: false, code: 'PROFILE_FILE_INVALID', error: 'role profile registry is invalid' };
    if (!workspaceRegistry.ok) return { ok: false, code: 'WORKSPACE_CONTEXT_FILE_INVALID', error: 'workspace registry is invalid' };
    const profileRole = raw.profile ? profileRegistry.profiles?.[raw.profile]?.role : undefined;
    const requestedRole = raw.role ?? profileRole ?? 'worker';
    const resolvedProfile = resolveRoleProfile(profileRegistry, raw.profile, requestedRole);
    if (!resolvedProfile.ok) return { ok: false, code: resolvedProfile.code, error: resolvedProfile.code };
    const knownContext = raw.workspace_id ? workspaceRegistry.contexts?.[raw.workspace_id] : null;
    const cwd = raw.workspace?.repo_root ?? raw.cwd ?? knownContext?.repo_root;
    if (!cwd) return { ok: false, code: 'WORKSPACE_CONTEXT_NOT_FOUND', error: 'workspace repo_root or cwd is required' };
    const workspace = resolveWorkspaceContext(workspaceRegistry, { workspace_id: raw.workspace_id, cwd });
    if (!workspace.ok) return { ok: false, code: workspace.code, error: workspace.code };
    const withRefs = addContextReferences(workspace.context, raw.context_refs, { cwd });
    if (!withRefs.ok) return { ok: false, code: withRefs.code, error: withRefs.code };
    const profile = resolvedProfile.profile;
    const worktree = raw.workspace?.worktree;
    const requestedIsolation = worktree === 'auto' ? 'worktree'
      : worktree === 'existing' || worktree === 'none' ? 'shared'
        : profile.isolation;
    const objective = raw.objective ?? raw.task;
    if (typeof objective !== 'string' || objective.trim() === '') return { ok: false, code: 'JOB_OBJECTIVE_REQUIRED', error: 'task or objective is required' };
    if (raw.job_id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw.job_id)) {
      return { ok: false, code: 'JOB_ID_INVALID', error: 'invalid client job id' };
    }
    const contextTask = buildWorkspaceTask(objective, withRefs.context);
    normalized = {
      ...raw,
      task: profile.review_strictness === 'strict' && requestedRole === 'reviewer'
        ? `${contextTask}\n\nSTRICT REVIEW: fail closed on missing direct code or test evidence.`
        : contextTask,
      cwd,
      role: requestedRole,
      client_job_id: raw.job_id ?? null,
      requested_isolation: requestedIsolation,
      workspace_branch: raw.workspace?.branch ?? withRefs.context?.default_branch ?? null,
      timeout_seconds: raw.constraints?.timeout_seconds ?? profile.timeout_seconds,
      allow_fallback: raw.constraints?.allow_fallback ?? profile.fallback,
      allow_no_changes: raw.constraints?.allow_no_changes === true,
      routing: profile.routing,
      review_strictness: profile.review_strictness,
      profile_id: resolvedProfile.profile_id,
      workspace_context: withRefs.context,
    };
    for (const key of ['objective', 'job_id', 'profile', 'workspace_id', 'workspace', 'constraints', 'context_refs']) delete normalized[key];
  }
  // v0.2 role-based dispatch: reviewer / worker are gated by their role state,
  // and the tier slot is derived from the role (reviewer always → pro).
  if (normalized.role === 'worker' || normalized.role === 'reviewer') {
    const hint = resolveRoleTierHint(normalized.role, normalized.tier);
    if (!hint.ok) return { ok: false, code: hint.code, error: hint.error };
    const decision = canDispatchRole(config, normalized.role, true, {});
    if (!decision.ok) return { ok: false, code: decision.error.policyCode, error: decision.error.message };
    return { ok: true, payload: { ...normalized, role: normalized.role, tier: hint.tier } };
  }
  const decision = chooseDefaultTier(config, normalized.tier, {});
  if (!decision.ok) return { ok: false, code: decision.error.policyCode, error: decision.error.message };
  return { ok: true, payload: { ...normalized, tier: decision.tier } };
}

// ---------- plugin entry ----------

export async function apply(ctx) {
  seedLangFromHost(ctx);
  const hub = new WorkerRegistry(ctx);
  const builtInProviderProbe = createProviderProbe(ctx);
  try {
    const { readGlobalConfig } = await import('../install/install.mjs');
    hub.getConfig = () => readGlobalConfig();
  } catch {}
  // Backend policy enforcement for the hub jobs route: mirrors the MCP
  // server's resolver. No session scope exists here (the MCP layer already
  // enforced its own), so the check uses the global config only. The route
  // calls resolveHubSpawnPayload (above) to stamp the effective tier onto
  // the spawn payload.
  const disposers = [];
  const PROVIDER_DELETE_PLAN_TTL_MS = 10 * 60 * 1000;
  const providerDeletePlans = new Map();
  const providerMigrationPlans = new Map();
  const providerMigrationOwners = new Map();
  const providerStoreMutationOwners = new Map();
  const credentialPurgePlans = new Map();
  const rememberProviderDeletePlan = (plan) => {
    providerDeletePlans.set(plan.plan_id, { plan, created_at: Date.now() });
    while (providerDeletePlans.size > 32) providerDeletePlans.delete(providerDeletePlans.keys().next().value);
  };
  const rememberProviderMigrationPlan = (plan) => {
    providerMigrationPlans.set(plan.plan_id, { plan, created_at: Date.now() });
    while (providerMigrationPlans.size > 32) providerMigrationPlans.delete(providerMigrationPlans.keys().next().value);
  };
  const rememberCredentialPurgePlan = (plan) => {
    credentialPurgePlans.set(plan.plan_id, { plan, created_at: Date.now() });
    while (credentialPurgePlans.size > 32) credentialPurgePlans.delete(credentialPurgePlans.keys().next().value);
  };

  // Multimodal bridge: register describe_image / generate_image for the DS
  // model. Config is read per call so settings-page edits apply live; the
  // capability switches (vision_enabled / imagegen_enabled) decide which tools
  // are registered at plugin boot, so toggling them takes effect on restart.
  try {
    const { createMultimodalTools } = await import('../multimodal.mjs');
    const { readGlobalConfig } = await import('../install/install.mjs');
    const plan = getMultimodalRegistrationPlan(normalizeGlobalConfig(readGlobalConfig()));
    for (const tool of createMultimodalTools(() => readGlobalConfig())) {
      if (!plan.tools[tool.name]) {
        ctx.logger?.info?.(`dsh-crew: ${tool.name} not registered (disabled by capability switch)`);
        continue;
      }
      disposers.push(ctx.effect(() => ctx.tools.register(tool), `dsh-crew: ${tool.name} tool`));
    }
  } catch (err) {
    ctx.logger?.warn?.(`dsh-crew: multimodal tools unavailable: ${err?.message ?? err}`);
  }

  // Vision route: image paste on the text-only DS models (admission adapter +
  // pre-step transcription). Installed only while Crew Vision is enabled.
  try {
    const { installVisionRoute } = await import('../vision-route.mjs');
    const { readGlobalConfig } = await import('../install/install.mjs');
    if (getMultimodalRegistrationPlan(normalizeGlobalConfig(readGlobalConfig())).visionRoute) {
      disposers.push(installVisionRoute(ctx, () => readGlobalConfig()));
    } else {
      ctx.logger?.info?.('dsh-crew: vision route not installed (Crew Vision disabled by capability switch)');
    }
  } catch (err) {
    ctx.logger?.warn?.(`dsh-crew: vision route unavailable: ${err?.message ?? err}`);
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer;
    const disposers = [];

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/ping`,
      handler: (req, res) => sendJson(res, 200, { ok: true, service: 'dsh-crew-hub' }),
    }));

    disposers.push(webServer.register({
      kind: 'prefix', path: `${ROUTE_BASE}/jobs`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const url = new URL(req.url, 'http://localhost');
          const parts = url.pathname.slice(`${ROUTE_BASE}/jobs`.length).split('/').filter(Boolean);
          if (req.method === 'GET' && parts.length === 0) {
            // Machine-wide view: this hub's live jobs plus fresh shards from
            // other writers (standalone MCP sessions, other hub instances).
            const own = [...hub.jobs.values()].map((j) => ({ ...hub.view(j), origin: hub.shard.writer }));
            const foreign = readMergedStatus({ excludeWriter: hub.shard.writer });
            return sendJson(res, 200, { ok: true, jobs: [...own, ...foreign] });
          }
          if (req.method === 'GET' && parts.length === 1) {
            const wait = Number(url.searchParams.get('wait') ?? 0);
            const job = await hub.wait(parts[0], Math.min(wait, 600) * 1000);
            if (!job) return sendJson(res, 404, { ok: false, error: 'no such job' });
            return sendJson(res, 200, { ok: true, job: hub.view(job, true) });
          }
          if (req.method === 'GET' && parts.length === 2 && parts[1] === 'events') {
            const job = hub.jobs.get(parts[0]);
            if (!job) return sendJson(res, 404, { ok: false, error: 'no such job' });
            const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
            const events = hubCanonicalEvents(job).filter((event) => event.sequence > after);
            return sendJson(res, 200, {
              ok: true, job_id: job.id, events,
              event_cursor: hubCanonicalEvents(job).at(-1)?.sequence ?? 0,
            });
          }
          if (req.method === 'GET' && parts.length === 2 && parts[1] === 'contract') {
            const job = hub.jobs.get(parts[0]);
            if (!job) return sendJson(res, 404, { ok: false, error: 'no such job' });
            const detail = url.searchParams.get('detail') === 'full' ? 'full' : 'compact';
            const afterSequence = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
            return sendJson(res, 200, { ok: true, job: projectWorkflowView(hub.view(job, true), { detail, afterSequence }) });
          }
          if (req.method === 'POST' && parts.length === 0) {
            const payload = await readBody(req);
            // Same policy resolver as the MCP server (src/server.mjs), with the
            // resolved effective tier stamped back onto the spawn payload: a
            // missing or policy-clamped tier must never reach WorkerRegistry
            // as its raw default (pro-only + no tier used to spawn flash).
            const resolved = resolveHubSpawnPayload(payload, () => hub.getConfig?.() ?? {});
            if (!resolved.ok) return sendJson(res, 400, { ok: false, error: resolved.error, code: resolved.code });
            const ingress = req.headers?.['x-dsh-crew-ingress'] === 'official-3080' ? 'official-3080' : 'direct-3210';
            const job = await hub.spawn({ ...resolved.payload, ingress });
            return sendJson(res, 200, { ok: true, job: hub.view(job) });
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'cancel') {
            const job = await hub.cancel(parts[0]);
            if (!job) return sendJson(res, 404, { ok: false, error: 'no such job' });
            return sendJson(res, 200, { ok: true, job: hub.view(job, true) });
          }
          return sendJson(res, 404, { ok: false, error: 'unknown jobs endpoint' });
        } catch (err) {
          const code = boundedMachineCodeFromError(err);
          const body = { ok: false, error: err?.message ?? String(err) };
          if (code) body.code = code;
          return sendJson(res, 400, body);
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/profiles`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...loadRoleProfiles() });
        if (req.method === 'POST') {
          try {
            const saved = saveRoleProfiles(await readBody(req));
            return sendJson(res, saved.ok ? 200 : 400, { ...saved });
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid JSON', code: 'PROFILE_FILE_INVALID' });
          }
        }
        return sendJson(res, 405, { ok: false, error: 'GET or POST' }, { allow: 'GET, POST' });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/workspaces`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...loadWorkspaceContexts() });
        if (req.method === 'POST') {
          try {
            const saved = saveWorkspaceContexts(await readBody(req));
            return sendJson(res, saved.ok ? 200 : 400, { ...saved });
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid JSON', code: 'WORKSPACE_CONTEXT_FILE_INVALID' });
          }
        }
        return sendJson(res, 405, { ok: false, error: 'GET or POST' }, { allow: 'GET, POST' });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/extension`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' });
        const config = normalizeGlobalConfig(hub.getConfig?.() ?? {});
        let catalogStatus = { id: 'provider_catalog', status: 'NOT_RUN', reason_code: 'PROVIDER_MODE_UNKNOWN' };
        if (normalizeWorkerProviderMode(config.worker_provider_mode) === 'deepseek-official') {
          catalogStatus = { id: 'provider_catalog', status: 'SKIP', reason_code: 'PROVIDER_CATALOG_NOT_REQUIRED' };
        } else {
          try {
            await readHarnessModelCatalog({
              llm: ctx.llm ?? ctx.get('llm'),
              getCurrentSelection: () => ctx.get('agentDefaultModel')?.currentSelection?.(),
            });
            catalogStatus = { id: 'provider_catalog', status: 'PASS', reason_code: 'PROVIDER_CATALOG_RESOLVED' };
          } catch {
            catalogStatus = { id: 'provider_catalog', status: 'FAIL', reason_code: 'PROVIDER_CATALOG_UNAVAILABLE' };
          }
        }
        const profiles = loadRoleProfiles();
        const requestUrl = new URL(req.url, 'http://localhost');
        const requestedWorkspaceId = requestUrl.searchParams.get('workspace_id');
        const workspaceRegistry = loadWorkspaceContexts();
        const requestedContext = requestedWorkspaceId ? workspaceRegistry.contexts?.[requestedWorkspaceId] : null;
        const workspaceReadiness = requestedWorkspaceId && !requestedContext
          ? { status: 'UNAVAILABLE', reason_code: 'WORKSPACE_CONTEXT_NOT_FOUND' }
          : await assessWorkspaceReadiness({ cwd: requestedContext?.repo_root ?? null });
        const liveJobs = typeof hub.list === 'function' ? hub.list() : [];
        const executionRows = buildHubExecutionRows(liveJobs);
        const readinessMatrix = { rows: [
          { id: 'hub_compatibility', status: 'PASS', reason_code: 'LIVE_CHECK_PASSED' },
          catalogStatus,
          ...executionRows,
        ] };
        const readinessSnapshot = buildRuntimeReadinessSnapshot({
          runtime: getHubRuntimeIdentity(),
          readinessMatrix,
          selections: { worker: liveJobs.find((job) => job?.role === 'worker') ?? null, reviewer: liveJobs.find((job) => job?.role === 'reviewer') ?? null },
          health: hub.healthStore.list(),
          jobs: liveJobs,
          workspace: workspaceReadiness,
        });
        const contract = buildExtensionContract({
          config,
          readinessMatrix,
          readinessSnapshot,
          workspace: workspaceReadiness,
          profiles,
          runtime: getHubRuntimeIdentity(),
        });
        return sendJson(res, 200, { ok: true, extension: contract });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/config`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const { readGlobalConfig, writeGlobalConfig } = await import(`../install/install.mjs?t=${Date.now()}`);
          if (req.method === 'GET') {
            adoptLang(new URL(req.url, 'http://localhost').searchParams.get('lang'));
            return sendJson(res, 200, { ok: true, config: readGlobalConfig() });
          }
          if (req.method === 'POST') return sendJson(res, 200, { ok: true, config: writeGlobalConfig(await readBody(req)) });
          return sendJson(res, 405, { ok: false, error: 'GET or POST' }, { allow: 'GET, POST' });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    // Durable restart-request protocol: the hub writes a request the Windows
    // supervisor executes. The hub NEVER spawns itself. A fresh supervisor
    // heartbeat is required so a request is never left to be discovered days
    // later by a watcher that is not actually running.
    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/runtime/restart-request`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });
        try {
          const { createRestartRequest, readSupervisorHeartbeat, supervisorStateRoot } = await import(`../supervisor/restart-request.mjs?t=${Date.now()}`);
          const appRoot = CONFIG_DIR;
          const heartbeat = readSupervisorHeartbeat(supervisorStateRoot(appRoot));
          if (!heartbeat) {
            return sendJson(res, 503, { ok: false, code: 'CREW_SUPERVISOR_UNAVAILABLE', error: 'no fresh supervisor heartbeat; restart cannot be executed' });
          }
          let reason = null;
          try {
            const body = await readBody(req);
            reason = typeof body?.reason === 'string' && body.reason.length > 0 ? body.reason.slice(0, 200) : null;
          } catch { /* body optional */ }
          const created = createRestartRequest({ appRoot, runtimeIdentity: getHubRuntimeIdentity(), reason });
          if (!created.ok) return sendJson(res, 400, { ok: false, code: created.code, error: created.error });
          return sendJson(res, 202, { ok: true, state: 'RESTART_REQUESTED', request_id: created.request.request_id, expires_at: created.request.expires_at });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/runtime/restart-status`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' });
        try {
          const { readRestartResult, readRestartRequest, supervisorStateRoot } = await import(`../supervisor/restart-request.mjs?t=${Date.now()}`);
          const appRoot = CONFIG_DIR;
          const requestId = new URL(req.url, 'http://localhost').searchParams.get('id');
          if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) return sendJson(res, 400, { ok: false, error: 'request id required' });
          const result = readRestartResult(supervisorStateRoot(appRoot), requestId);
          if (result) return sendJson(res, 200, { ok: true, state: result.state, request_id: result.request_id, detail: result.detail ?? null });
          const pending = readRestartRequest(supervisorStateRoot(appRoot), requestId);
          if (pending) return sendJson(res, 200, { ok: true, state: 'RESTART_REQUESTED', request_id: pending.request_id });
          return sendJson(res, 404, { ok: false, error: 'unknown restart request' });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/presets`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const presets = ctx.get('agentPresets');
          if (presets === undefined) return sendJson(res, 200, { ok: true, presets: [] });
          const list = await presets.list();
          return sendJson(res, 200, {
            ok: true,
            defaultId: presets.defaultId,
            presets: list.map((p) => ({ id: p.id, name: p.name ?? p.id })),
          });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/provider`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const config = normalizeGlobalConfig(hub.getConfig?.() ?? {});
          const lifecycleState = readProviderLifecycleState();
          const healthGate = config.health_gate ?? config.worker?.model_policy?.health_gate;
          const mode = normalizeWorkerProviderMode(config.worker_provider_mode);
          let selections;
          if (mode === 'deepseek-official') {
            selections = {
              flash: { provider: 'deepseek-official', model: 'deepseek-v4-flash', source: 'legacy-strict' },
              pro: { provider: 'deepseek-official', model: 'deepseek-v4-pro', source: 'legacy-strict' },
            };
          } else {
            const catalog = await readHarnessModelCatalog({
              llm: ctx.llm ?? ctx.get('llm'),
              getCurrentSelection: () => ctx.get('agentDefaultModel')?.currentSelection?.(),
            });
            selections = {};
            for (const tier of ['flash', 'pro']) {
              const selected = resolveWorkerModel({
                tier,
                priority: config[`${tier}_model_priority`],
                priorityConfigured: config[`${tier}_model_priority_configured`],
                fallback: config[`${tier}_model_fallback`],
                catalog,
                harnessDefault: catalog.harness_default,
                healthStore: hub.healthStore,
                healthGate,
                allowFallback: config.allow_fallback !== false,
                tombstones: lifecycleState.tombstones,
              });
              selections[tier] = selected.ok
                ? { provider: selected.provider, model: selected.model, source: selected.source }
                : { code: selected.code, error: selected.message };
            }
          }
          return sendJson(res, 200, {
            ok: true,
            worker_provider_mode: mode,
            effective_worker_provider: selections.flash?.provider ?? null,
            effective_worker_selection: selections,
          });
        } catch (err) {
          return sendJson(res, 503, { ok: false, code: 'MODEL_CATALOG_UNAVAILABLE', error: 'Unable to resolve Harness worker models.' });
        }
      },
    }));

    // Secret-free Harness provider inventory. This is deliberately separate
    // from /models (catalog) and /provider (effective routing): it reports
    // declaration provenance, ownership, lifecycle state and policy refs.
    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/providers`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' });
        try {
          const config = normalizeGlobalConfig(hub.getConfig?.() ?? {});
          const inventory = await readProviderInventorySnapshot(hub, ctx, config);
          return sendJson(res, 200, {
            ok: true,
            ...inventory,
            runtime: getHubRuntimeIdentity(),
          });
        } catch {
          return sendJson(res, 503, { ok: false, code: 'PROVIDER_INVENTORY_UNAVAILABLE', error: 'Unable to read Harness provider inventory.' });
        }
      },
    }));

    // Credential references are a separate, secret-free inventory. Provider
    // deletion can report these references, but never implies their purge.
    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/credential-references`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' });
        try {
          const config = normalizeGlobalConfig(hub.getConfig?.() ?? {});
          const snapshot = await readProviderInventorySnapshot(hub, ctx, config);
          const credentials = buildCredentialReferenceInventory({ providers: snapshot.records, additional_refs: snapshot.credential_history_refs, purged_refs: snapshot.credential_purged_refs });
          return sendJson(res, 200, { ok: true, ...credentials, unverified_purges: snapshot.credential_purge_unverified, runtime: getHubRuntimeIdentity() });
        } catch {
          return sendJson(res, 503, { ok: false, code: 'CREDENTIAL_REFERENCE_INVENTORY_UNAVAILABLE' });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'prefix', path: `${ROUTE_BASE}/credential-references`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        let url;
        try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { ok: false, code: 'CREDENTIAL_PURGE_PLAN_INVALID' }); }
        const parts = url.pathname.slice(`${ROUTE_BASE}/credential-references`.length).split('/').filter(Boolean);
        try {
          const referenceId = decodeURIComponent(parts[0] ?? '');
          const body = await readBody(req);
          const config = normalizeGlobalConfig(hub.getConfig?.() ?? {});
          const snapshot = await readProviderInventorySnapshot(hub, ctx, config);
          const credentials = buildCredentialReferenceInventory({ providers: snapshot.records, additional_refs: snapshot.credential_history_refs, purged_refs: snapshot.credential_purged_refs });
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'purge-plan') {
            const planned = planCredentialPurge({ inventory: credentials, referenceId, expectedRevision: body?.expected_revision });
            if (!planned.ok) return sendJson(res, 409, { ok: false, code: planned.code });
            rememberCredentialPurgePlan(planned.plan);
            return sendJson(res, 200, { ok: true, plan: planned.plan });
          }
          if (req.method === 'DELETE' && parts.length === 1) {
            if (body?.confirm !== true) return sendJson(res, 400, { ok: false, code: 'CREDENTIAL_PURGE_CONFIRM_REQUIRED' });
            const stored = credentialPurgePlans.get(body?.plan_id);
            if (!stored || Date.now() - stored.created_at > PROVIDER_DELETE_PLAN_TTL_MS || stored.plan.reference_id !== referenceId) {
              credentialPurgePlans.delete(body?.plan_id);
              return sendJson(res, 409, { ok: false, code: 'CREDENTIAL_PURGE_PLAN_EXPIRED' });
            }
            const current = planCredentialPurge({ inventory: credentials, referenceId, expectedRevision: stored.plan.expected_revision });
            if (!current.ok) return sendJson(res, 409, { ok: false, code: current.code });
            if (current.plan.expected_revision !== stored.plan.expected_revision) return sendJson(res, 409, { ok: false, code: 'CREDENTIAL_REFERENCE_CHANGED' });
            credentialPurgePlans.delete(body.plan_id);
            const adapter = createCredentialPurgeFileHooks({
              credentialsFile: join(CONFIG_DIR, 'harness', '.credentials.yaml'),
              crewHome: join(CONFIG_DIR, 'harness'),
            });
            const result = await executeCredentialPurge(current.plan, {
              recheck: async (id) => {
                const freshSnapshot = await readProviderInventorySnapshot(hub, ctx, config);
                const freshCredentials = buildCredentialReferenceInventory({ providers: freshSnapshot.records, additional_refs: freshSnapshot.credential_history_refs, purged_refs: freshSnapshot.credential_purged_refs });
                const freshPlan = planCredentialPurge({ inventory: freshCredentials, referenceId: id });
                if (!freshPlan.ok) return { ok: false };
                const freshRecord = freshCredentials.records.find((entry) => entry.reference_id === id);
                return {
                  ok: true,
                  revision: freshPlan.plan.expected_revision,
                  orphan: freshRecord?.orphan === true,
                  ownership: freshRecord?.ownership,
                  purge_capability: freshRecord?.purge_capability,
                };
              },
              ...(adapter.ok ? { purge: adapter.purge, verify: adapter.verify } : {}),
            });
            if (result.state === 'PURGED' || result.state === 'VERIFIED') {
              try {
                writeCredentialPurgeState(recordCredentialPurgeOutcome(readCredentialPurgeState(), current.plan, result));
              } catch {
                return sendJson(res, 503, { ok: false, code: 'CREDENTIAL_PURGE_AUDIT_FAILED', state: result.state, reference_id: referenceId });
              }
            }
            return sendJson(res, result.ok ? 200 : 503, result);
          }
          return sendJson(res, 404, { ok: false, code: 'CREDENTIAL_REFERENCE_ENDPOINT_NOT_FOUND' });
        } catch (error) {
          return sendJson(res, 400, { ok: false, code: boundedMachineCodeFromError(error) ?? 'CREDENTIAL_PURGE_PLAN_INVALID' });
        }
      },
    }));

    // Deletion is two-phase: this endpoint only computes a revision-bound,
    // secret-free impact plan. A later mutation endpoint must present that
    // plan and perform restart/verification through an owned supervisor.
    disposers.push(webServer.register({
      kind: 'prefix', path: `${ROUTE_BASE}/providers`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        let url;
        try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { ok: false, code: 'PROVIDER_PLAN_INVALID' }); }
        const parts = url.pathname.slice(`${ROUTE_BASE}/providers`.length).split('/').filter(Boolean);
        try {
          if (req.method === 'GET' && parts.length === 1 && parts[0] === 'migration-status') {
            const config = normalizeGlobalConfig(hub.getConfig?.() ?? {});
            const inventory = await readProviderInventorySnapshot(hub, ctx, config);
            return sendJson(res, 200, { ok: true, ...inventory.migration, runtime: getHubRuntimeIdentity() });
          }
          const providerId = decodeURIComponent(parts[0]);
          const body = await readBody(req);
          if (req.method === 'POST' && parts[0] === '_recovery' && parts[1] === 'lock' && parts.length === 2) {
            if (body?.confirm !== true) return sendJson(res, 400, { ok: false, code: 'PROVIDER_DELETE_RECOVERY_CONFIRM_REQUIRED' });
            const hooks = createProviderDeleteFileHooks({
              profileFile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
              settingsFile: join(CONFIG_DIR, 'harness', 'settings.yaml'),
              configFile: join(CONFIG_DIR, 'config.json'),
              lifecycleFile: join(CONFIG_DIR, 'provider-lifecycle.json'),
              backupDir: join(CONFIG_DIR, 'provider-backups'),
              sharedLockFile: join(CONFIG_DIR, 'provider-store.lock'),
            });
            const recovered = await hooks.recoverLock({ force: body?.force === true });
            const migrationHooks = createProviderLayerMigrationFileHooks({
              profileFile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
              settingsFile: join(CONFIG_DIR, 'harness', 'settings.yaml'),
              backupDir: join(CONFIG_DIR, 'provider-migration-backups'),
            });
            const migrationRecovered = await migrationHooks.recoverLock({ confirm: true });
            const ok = recovered.ok === true && migrationRecovered.ok === true;
            return sendJson(res, ok ? 200 : 409, { ok, delete_lock: recovered, migration_lock: migrationRecovered });
          }
          if (req.method === 'POST' && parts[0] === '_recovery' && parts[1] === 'quarantine' && parts.length === 2) {
            if (body?.confirm !== true) return sendJson(res, 400, { ok: false, code: 'PROVIDER_DELETE_RECOVERY_QUARANTINE_CONFIRM_REQUIRED' });
            const actionId = typeof body?.action_id === 'string' && RECOVERY_ACTION_PATTERN.test(body.action_id)
              ? body.action_id : null;
            if (!actionId) return sendJson(res, 400, { ok: false, code: 'PROVIDER_DELETE_PLAN_INVALID' });
            const recovery = [
              ...readProviderRecoveryTransactions(),
              ...readProviderLayerMigrationTransactions(join(CONFIG_DIR, 'provider-migration-backups')),
            ].find((entry) => entry.action_id === actionId);
            if (!recovery) return sendJson(res, 404, { ok: false, code: 'PROVIDER_DELETE_RECOVERY_NOT_FOUND' });
            if (recovery.recoverable === true) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_RECOVERY_RECOVERABLE' });
            if (typeof recovery.storage_id !== 'string') return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_RECOVERY_QUARANTINE_FAILED' });
            if (recovery.source === 'provider-layer-migration') {
              try {
                const migrationHooks = createProviderLayerMigrationFileHooks({
                  profileFile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
                  settingsFile: join(CONFIG_DIR, 'harness', 'settings.yaml'),
                  backupDir: join(CONFIG_DIR, 'provider-migration-backups'),
                });
                const quarantined = await migrationHooks.quarantine(actionId);
                return sendJson(res, 200, { ...quarantined, transaction_id: recovery.transaction_id ?? null });
              } catch (error) {
                const code = boundedMachineCodeFromError(error) ?? 'PROVIDER_MIGRATION_RECOVERY_QUARANTINE_FAILED';
                return sendJson(res, 409, { ok: false, code });
              }
            }
            try {
              const hooks = createProviderDeleteFileHooks({
                profileFile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
                settingsFile: join(CONFIG_DIR, 'harness', 'settings.yaml'),
                configFile: join(CONFIG_DIR, 'config.json'),
                lifecycleFile: join(CONFIG_DIR, 'provider-lifecycle.json'),
                backupDir: join(CONFIG_DIR, 'provider-backups'),
                sharedLockFile: join(CONFIG_DIR, 'provider-store.lock'),
                afterLockAcquired: () => {
                  const current = readProviderRecoveryTransactions().find((entry) => entry.action_id === actionId);
                  if (!current || current.recoverable === true || current.storage_id !== recovery.storage_id) {
                    throw Object.assign(new Error('provider recovery entry changed before quarantine'), { code: 'PROVIDER_DELETE_STATE_CHANGED' });
                  }
                },
              });
              const quarantined = await hooks.quarantine(recovery.storage_id);
              return sendJson(res, 200, { ...quarantined, action_id: actionId, transaction_id: recovery.transaction_id ?? null });
            } catch (error) {
              const code = boundedMachineCodeFromError(error) ?? 'PROVIDER_DELETE_RECOVERY_QUARANTINE_FAILED';
              return sendJson(res, 409, { ok: false, code });
            }
          }
          const config = normalizeGlobalConfig(hub.getConfig?.() ?? {});
          const inventory = await readProviderInventorySnapshot(hub, ctx, config);
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'migrate-plan') {
            if (!hasCompleteProviderCatalogEvidence(inventory.catalog_evidence)) return sendJson(res, 503, { ok: false, code: 'MODEL_CATALOG_UNAVAILABLE' });
            if (!hasCompleteProviderDeclarationEvidence(inventory.declaration_evidence)) return sendJson(res, 409, { ok: false, code: 'PROVIDER_SOURCE_UNRESOLVED' });
            if (!hasAvailableProviderLifecycleEvidence(inventory.lifecycle_evidence)) return sendJson(res, 503, { ok: false, code: 'PROVIDER_LIFECYCLE_UNAVAILABLE' });
            if (inventory.default_evidence?.ok !== true) return sendJson(res, 409, { ok: false, code: inventory.default_evidence?.code ?? 'PROVIDER_DEFAULT_AUTHORITY_UNAVAILABLE' });
            if (hasPendingProviderRecoveryTransactions(inventory)) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_RECOVERY_PENDING' });
            const entry = inventory.migration.providers.find((candidate) => candidate.provider_id === providerId);
            if (!entry) return sendJson(res, 404, { ok: false, code: 'PROVIDER_MIGRATION_NOT_REQUIRED' });
            if (entry.action === 'blocked' || entry.action === 'collision-review') return sendJson(res, 409, { ok: false, code: entry.blocked_reason ?? 'PROVIDER_MIGRATION_BLOCKED' });
            const revisions = readProviderSourceRevisions();
            if (!revisions.profile.ok) return sendJson(res, 409, { ok: false, code: revisions.profile.code ?? 'PROVIDER_PROFILE_CHANGED' });
            if ((entry.action === 'promote-existing-user' || entry.harness_default) && !revisions.settings.ok) return sendJson(res, 409, { ok: false, code: revisions.settings.code ?? 'PROVIDER_SETTINGS_CHANGED' });
            const profileFile = join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml');
            const parsedMaterialization = readProviderMaterialization(readFileSync(profileFile, 'utf8'), { providerId, file: 'harness/profiles/dsh-crew/cordis.patch.yml' });
            if (!parsedMaterialization.ok) return sendJson(res, 409, { ok: false, code: parsedMaterialization.code });
            const materialization = parsedMaterialization.provider;
            let userMaterializationBefore;
            if (entry.action === 'promote-existing-user') {
              const settingsFile = join(CONFIG_DIR, 'harness', 'settings.yaml');
              if (!existsSync(settingsFile)) return sendJson(res, 409, { ok: false, code: 'PROVIDER_SETTINGS_CHANGED' });
              const parsedUserMaterialization = readProviderSettingsMaterialization(readFileSync(settingsFile, 'utf8'), { providerId, file: 'harness/settings.yaml' });
              if (!parsedUserMaterialization.ok) return sendJson(res, 409, { ok: false, code: parsedUserMaterialization.code });
              userMaterializationBefore = parsedUserMaterialization.provider;
            }
            const plan = {
              schema_version: 1,
              kind: 'provider-layer-migration',
              plan_id: randomUUID(),
              provider_id: providerId,
              action: entry.action,
              source: entry.source,
              routing_references: entry.referenced_by,
              materialization: { provider: materialization },
              ...(userMaterializationBefore ? { user_materialization_before: userMaterializationBefore } : {}),
              expected_revisions: {
                profile: revisions.profile.revision,
                settings: revisions.settings.ok ? revisions.settings.revision : null,
              },
              harness_default_before: inventory.harness_default ?? null,
              runtime_id_before: getHubRuntimeIdentity().runtime_id,
              restart_required: true,
            };
            rememberProviderMigrationPlan(plan);
            return sendJson(res, 200, { ok: true, plan });
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'migrate') {
            if (body?.confirm !== true) return sendJson(res, 400, { ok: false, code: 'PROVIDER_MIGRATION_CONFIRM_REQUIRED' });
            const stored = providerMigrationPlans.get(body?.plan_id);
            if (!stored || Date.now() - stored.created_at > PROVIDER_DELETE_PLAN_TTL_MS || stored.plan.provider_id !== providerId) {
              providerMigrationPlans.delete(body?.plan_id);
              return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_PLAN_EXPIRED' });
            }
            const entry = inventory.migration.providers.find((candidate) => candidate.provider_id === providerId);
            if (!entry || entry.action !== stored.plan.action || entry.action === 'blocked' || entry.action === 'collision-review') return sendJson(res, 409, { ok: false, code: entry?.blocked_reason ?? 'PROVIDER_MIGRATION_PLAN_CHANGED' });
            if (inventory.default_evidence?.ok !== true) return sendJson(res, 409, { ok: false, code: inventory.default_evidence?.code ?? 'PROVIDER_DEFAULT_AUTHORITY_UNAVAILABLE' });
            const revisions = readProviderSourceRevisions();
            const expected = stored.plan.expected_revisions ?? {};
            if (revisions.profile.revision !== expected.profile || (revisions.settings.ok ? revisions.settings.revision : null) !== expected.settings) {
              return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_SOURCE_CHANGED' });
            }
            const hooks = createProviderLayerMigrationFileHooks({
              profileFile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
              settingsFile: join(CONFIG_DIR, 'harness', 'settings.yaml'),
              backupDir: join(CONFIG_DIR, 'provider-migration-backups'),
            });
            let result;
            if (hub.hasProviderLease(providerId)) return sendJson(res, 409, { ok: false, code: 'PROVIDER_IN_USE' });
            if (!hub.beginProviderStoreMutation()) return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_BUSY' });
            if (!hub.beginProviderMutation(providerId)) {
              hub.endProviderStoreMutation();
              return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_BUSY' });
            }
            let retainProviderMutation = false;
            let retainProviderStoreMutation = false;
            try {
              await hooks.acquireLock();
              // The plan was created from a pre-lock snapshot. Re-read every
              // authoritative source after taking the shared store lock so a
              // concurrent catalog/default/recovery change cannot be hidden
              // behind unchanged profile/settings revisions.
              const lockedConfig = normalizeGlobalConfig(hub.getConfig?.() ?? {});
              const lockedInventory = await readProviderInventorySnapshot(hub, ctx, lockedConfig);
              const lockedEntry = lockedInventory.migration.providers.find((candidate) => candidate.provider_id === providerId);
              const expectedRouting = Array.isArray(stored.plan.routing_references) ? stored.plan.routing_references : [];
              const sameRouting = JSON.stringify(lockedEntry?.referenced_by ?? []) === JSON.stringify(expectedRouting);
              const sameDefault = JSON.stringify(lockedInventory.harness_default ?? null) === JSON.stringify(stored.plan.harness_default_before ?? null);
              const profileFile = join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml');
              const lockedMaterialization = existsSync(profileFile)
                ? readProviderMaterialization(readFileSync(profileFile, 'utf8'), { providerId, file: 'harness/profiles/dsh-crew/cordis.patch.yml' })
                : { ok: false };
              const sameMaterialization = lockedMaterialization.ok === true
                && JSON.stringify(lockedMaterialization.provider) === JSON.stringify(stored.plan.materialization?.provider ?? null);
              const settingsFile = join(CONFIG_DIR, 'harness', 'settings.yaml');
              const lockedUserMaterialization = stored.plan.action === 'promote-existing-user' && existsSync(settingsFile)
                ? readProviderSettingsMaterialization(readFileSync(settingsFile, 'utf8'), { providerId, file: 'harness/settings.yaml' })
                : { ok: stored.plan.action !== 'promote-existing-user' };
              const sameUserMaterialization = stored.plan.action !== 'promote-existing-user'
                || (lockedUserMaterialization.ok === true && JSON.stringify(lockedUserMaterialization.provider) === JSON.stringify(stored.plan.user_materialization_before ?? null));
              const lockedRevisions = readProviderSourceRevisions();
              const expectedLocked = stored.plan.expected_revisions ?? {};
              const sameRevisions = lockedRevisions.profile.revision === expectedLocked.profile
                && (lockedRevisions.settings.ok ? lockedRevisions.settings.revision : null) === expectedLocked.settings;
              if (hasPendingProviderRecoveryTransactions(lockedInventory)) {
                return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_RECOVERY_PENDING' });
              }
              if (!lockedEntry || lockedEntry.action !== stored.plan.action || lockedEntry.collision !== null
                || !sameRouting || !sameDefault || !sameMaterialization || !sameUserMaterialization || !sameRevisions
                || lockedInventory.default_evidence?.ok !== true
                || !hasCompleteProviderCatalogEvidence(lockedInventory.catalog_evidence)
                || !hasCompleteProviderDeclarationEvidence(lockedInventory.declaration_evidence)
                || !hasAvailableProviderLifecycleEvidence(lockedInventory.lifecycle_evidence)) {
                return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_PLAN_CHANGED' });
              }
              if (hub.hasProviderLease(providerId)) return sendJson(res, 409, { ok: false, code: 'PROVIDER_IN_USE' });
              result = await executeProviderLayerMigration(stored.plan, hooks, { confirm: true, deferRestart: true });
              if (result.ok && result.state === 'RESTART_PENDING') await hooks.setRestartRuntimeBaseline(getHubRuntimeIdentity().runtime_id);
              providerMigrationPlans.delete(body.plan_id);
              retainProviderMutation = result.state === 'RESTART_PENDING';
              if (retainProviderMutation) {
                providerMigrationOwners.set(providerId, stored.plan.plan_id);
                providerStoreMutationOwners.set(stored.plan.plan_id, providerId);
                retainProviderStoreMutation = true;
              }
              return sendJson(res, result.ok ? 202 : 409, { ok: result.ok, restart_required: result.restart_required === true, result });
            } finally {
              await hooks.release();
              if (!retainProviderMutation) hub.endProviderMutation(providerId);
              if (!retainProviderStoreMutation) hub.endProviderStoreMutation();
            }
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'verify-migration') {
            if (body?.confirm !== true) return sendJson(res, 400, { ok: false, code: 'PROVIDER_MIGRATION_VERIFY_CONFIRM_REQUIRED' });
            const transactionId = body?.transaction_id;
            const hooks = createProviderLayerMigrationFileHooks({
              profileFile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
              settingsFile: join(CONFIG_DIR, 'harness', 'settings.yaml'),
              backupDir: join(CONFIG_DIR, 'provider-migration-backups'),
              existingMigrationId: transactionId,
            });
            let acquiredStoreFence = false;
            try {
              await hooks.acquireLock();
              await hooks.backup({});
              const plan = hooks.backupPlan();
              if (!plan || plan.provider_id !== providerId) return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_PLAN_PROVIDER_MISMATCH' });
              const owner = providerMigrationOwners.get(providerId);
              if (providerStoreMutationOwners.get(plan.plan_id) !== providerId || !hub.hasProviderStoreMutation()) {
                if (hub.hasProviderStoreMutation() || !hub.beginProviderStoreMutation()) return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_BUSY' });
                providerStoreMutationOwners.set(plan.plan_id, providerId);
                acquiredStoreFence = true;
              }
              if (owner !== plan.plan_id) {
                if (hub.hasProviderLease(providerId) || !hub.beginProviderMutation(providerId)) {
                  if (acquiredStoreFence && providerStoreMutationOwners.get(plan.plan_id) === providerId) { providerStoreMutationOwners.delete(plan.plan_id); hub.endProviderStoreMutation(); }
                  return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_BUSY' });
                }
                providerMigrationOwners.set(providerId, plan.plan_id);
              }
              const verification = await hooks.verify(plan);
              const live = await readProviderInventorySnapshot(hub, ctx, config);
              verification.catalogEvidence = live.catalog_evidence;
              verification.defaultEvidence = live.default_evidence;
              verification.defaultPreserved = live.default_evidence?.ok === true
                && JSON.stringify(live.harness_default ?? null) === JSON.stringify(plan.harness_default_before ?? null);
              verification.liveNativeRemovable = hasCompleteProviderCatalogEvidence(live.catalog_evidence)
                && live.records.some((record) => record.id === providerId && record.lifecycle?.catalogued === true && record.native_removable === true);
              verification.runtimeRestarted = hasProviderRuntimeRestartEvidence(plan.runtime_id_before_restart ?? plan.runtime_id_before, getHubRuntimeIdentity().runtime_id);
              if (verification.nativeRemovable !== true || verification.liveNativeRemovable !== true || verification.defaultPreserved !== true || verification.runtimeRestarted !== true) return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_VERIFY_FAILED', verification });
              await hooks.finalizeVerified();
              if (providerMigrationOwners.get(providerId) === plan.plan_id) {
                providerMigrationOwners.delete(providerId);
                hub.endProviderMutation(providerId);
              }
              if (providerStoreMutationOwners.get(plan.plan_id) === providerId) {
                providerStoreMutationOwners.delete(plan.plan_id);
                hub.endProviderStoreMutation();
              }
              return sendJson(res, 200, { ok: true, state: 'VERIFIED', transaction_id: plan.plan_id, provider_id: providerId, verification });
            } finally {
              await hooks.release();
              // Keep the transaction-owned fence on verification failure so
              // an incomplete migration cannot race a new Worker; the caller
              // must explicitly retry verification or roll it back.
            }
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'rollback-migration') {
            if (body?.confirm !== true) return sendJson(res, 400, { ok: false, code: 'PROVIDER_MIGRATION_ROLLBACK_CONFIRM_REQUIRED' });
            const hooks = createProviderLayerMigrationFileHooks({
              profileFile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
              settingsFile: join(CONFIG_DIR, 'harness', 'settings.yaml'),
              backupDir: join(CONFIG_DIR, 'provider-migration-backups'),
              existingMigrationId: body?.transaction_id,
            });
            let acquiredMigrationFence = false;
            let retainProviderMutation = false;
            let acquiredStoreFence = false;
            try {
              await hooks.acquireLock();
              await hooks.backup({});
              const plan = hooks.backupPlan();
              if (!plan || plan.provider_id !== providerId) return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_PLAN_PROVIDER_MISMATCH' });
              const owner = providerMigrationOwners.get(providerId);
              if (providerStoreMutationOwners.get(plan.plan_id) !== providerId || !hub.hasProviderStoreMutation()) {
                if (hub.hasProviderStoreMutation() || !hub.beginProviderStoreMutation()) return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_BUSY' });
                providerStoreMutationOwners.set(plan.plan_id, providerId);
                acquiredStoreFence = true;
              }
              if (owner !== plan.plan_id) {
                if (hub.hasProviderLease(providerId) || !hub.beginProviderMutation(providerId)) {
                  if (acquiredStoreFence && providerStoreMutationOwners.get(plan.plan_id) === providerId) { providerStoreMutationOwners.delete(plan.plan_id); hub.endProviderStoreMutation(); }
                  return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_BUSY' });
                }
                providerMigrationOwners.set(providerId, plan.plan_id);
                acquiredMigrationFence = true;
                retainProviderMutation = true;
              }
              const rollback = await hooks.rollback();
              await hooks.setRollbackRuntimeBaseline(getHubRuntimeIdentity().runtime_id);
              providerMigrationOwners.set(providerId, plan.plan_id);
              retainProviderMutation = true;
              return sendJson(res, 202, { ok: true, restart_required: true, transaction_id: plan.plan_id, provider_id: providerId, state: 'ROLLBACK_RESTART_PENDING' });
            } finally {
              await hooks.release();
              if (acquiredMigrationFence && !retainProviderMutation && providerMigrationOwners.get(providerId) === body?.transaction_id) {
                providerMigrationOwners.delete(providerId);
                hub.endProviderMutation(providerId);
              }
            }
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'verify-rollback-migration') {
            if (body?.confirm !== true) return sendJson(res, 400, { ok: false, code: 'PROVIDER_MIGRATION_ROLLBACK_VERIFY_CONFIRM_REQUIRED' });
            const transactionId = body?.transaction_id;
            const hooks = createProviderLayerMigrationFileHooks({
              profileFile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
              settingsFile: join(CONFIG_DIR, 'harness', 'settings.yaml'),
              backupDir: join(CONFIG_DIR, 'provider-migration-backups'),
              existingMigrationId: transactionId,
            });
            let acquiredStoreFence = false;
            try {
              await hooks.acquireLock();
              await hooks.backup({});
              const plan = hooks.backupPlan();
              if (!plan || plan.provider_id !== providerId) return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_PLAN_PROVIDER_MISMATCH' });
              const owner = providerMigrationOwners.get(providerId);
              if (providerStoreMutationOwners.get(plan.plan_id) !== providerId || !hub.hasProviderStoreMutation()) {
                if (hub.hasProviderStoreMutation() || !hub.beginProviderStoreMutation()) return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_BUSY' });
                providerStoreMutationOwners.set(plan.plan_id, providerId);
                acquiredStoreFence = true;
              }
              if (owner !== plan.plan_id) {
                if (hub.hasProviderLease(providerId) || !hub.beginProviderMutation(providerId)) {
                  if (acquiredStoreFence && providerStoreMutationOwners.get(plan.plan_id) === providerId) { providerStoreMutationOwners.delete(plan.plan_id); hub.endProviderStoreMutation(); }
                  return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_BUSY' });
                }
                providerMigrationOwners.set(providerId, plan.plan_id);
              }
              const verification = await hooks.verifyRollback(plan);
              const live = await readProviderInventorySnapshot(hub, ctx, config);
              verification.catalogEvidence = live.catalog_evidence;
              verification.defaultEvidence = live.default_evidence;
              verification.defaultPreserved = live.default_evidence?.ok === true
                && JSON.stringify(live.harness_default ?? null) === JSON.stringify(plan.harness_default_before ?? null);
              verification.liveRestored = hasCompleteProviderCatalogEvidence(live.catalog_evidence)
                && live.records.some((record) => record.id === providerId && record.lifecycle?.catalogued === true && record.native_removable === false);
              verification.runtimeRestarted = hasProviderRuntimeRestartEvidence(plan.rollback_runtime_id_before, getHubRuntimeIdentity().runtime_id);
              if (verification.ok !== true || verification.liveRestored !== true || verification.defaultPreserved !== true || verification.runtimeRestarted !== true) return sendJson(res, 409, { ok: false, code: 'PROVIDER_MIGRATION_ROLLBACK_VERIFY_FAILED', verification });
              await hooks.finalizeRollback();
              if (providerMigrationOwners.get(providerId) === plan.plan_id) {
                providerMigrationOwners.delete(providerId);
                hub.endProviderMutation(providerId);
              }
              if (providerStoreMutationOwners.get(plan.plan_id) === providerId) {
                providerStoreMutationOwners.delete(plan.plan_id);
                hub.endProviderStoreMutation();
              }
              return sendJson(res, 200, { ok: true, state: 'ROLLED_BACK', transaction_id: plan.plan_id, provider_id: providerId, verification });
            } finally { await hooks.release(); }
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'delete-plan') {
            if (providerId !== 'deepseek-official' && hasPendingProviderRecoveryTransactions(inventory)) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_RECOVERY_PENDING' });
            if (providerId !== 'deepseek-official' && !hasCompleteProviderCatalogEvidence(inventory.catalog_evidence)) return sendJson(res, 503, { ok: false, code: 'MODEL_CATALOG_UNAVAILABLE' });
            if (providerId !== 'deepseek-official' && !hasCompleteProviderDeclarationEvidence(inventory.declaration_evidence)) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_SOURCE_UNRESOLVED' });
            if (providerId !== 'deepseek-official' && !hasAvailableProviderLifecycleEvidence(inventory.lifecycle_evidence)) return sendJson(res, 503, { ok: false, code: 'PROVIDER_LIFECYCLE_UNAVAILABLE' });
            if (providerId !== 'deepseek-official' && inventory.default_evidence?.ok !== true) return sendJson(res, 409, { ok: false, code: inventory.default_evidence?.code ?? 'PROVIDER_DEFAULT_AUTHORITY_UNAVAILABLE' });
            const revisions = readProviderSourceRevisions();
            if (!revisions.profile.ok && !revisions.settings.ok) return sendJson(res, 409, { ok: false, code: revisions.profile.code ?? revisions.settings.code });
            const expectedRevision = (revisions.profile.ok ? revisions.profile.revision : null) ?? revisions.settings.revision;
            const planned = planProviderDelete({
              providerId,
              inventory,
              activeJobs: hub.list(),
              replacementDefault: body?.replacement_default,
              expectedRevision,
              expectedRevisions: {
                profile: revisions.profile.ok ? revisions.profile.revision : null,
                settings: revisions.settings.ok ? revisions.settings.revision : null,
              },
            });
            if (!planned.ok) return sendJson(res, 409, { ok: false, code: planned.code });
            const plan = { ...planned.plan, runtime_id_before: getHubRuntimeIdentity().runtime_id };
            rememberProviderDeletePlan(plan);
            return sendJson(res, 200, { ok: true, profile_revision: expectedRevision, plan });
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'probe') {
            const record = inventory.records.find((entry) => entry.id === providerId);
            if (!record) return sendJson(res, 404, { ok: false, code: 'PROVIDER_NOT_FOUND' });
            if (record.desired_state === 'absent') return sendJson(res, 409, { ok: false, code: 'PROVIDER_TOMBSTONED' });
            const model = selectProviderProbeModel({ providerId, record, config });
            if (!model) return sendJson(res, 409, { ok: false, code: 'PROVIDER_PROBE_MODEL_UNAVAILABLE' });
            let explicitProviderProbe;
            try { explicitProviderProbe = ctx?.providerProbe; } catch { explicitProviderProbe = undefined; }
            const providerProbe = typeof explicitProviderProbe === 'function' ? explicitProviderProbe : builtInProviderProbe;
            if (typeof providerProbe !== 'function') return sendJson(res, 503, { ok: false, code: 'PROVIDER_PROBE_UNAVAILABLE' });
            let observed;
            let timer;
            try {
              const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ error: { name: 'TimeoutError' } }), 15_000); });
              observed = await Promise.race([
                Promise.resolve().then(() => providerProbe({ provider: providerId, model, signal: AbortSignal.timeout(15_000) })),
                timeout,
              ]);
            } catch (error) {
              // Keep probe transport failures as bounded health evidence so a
              // credential/quota/timeout result is visible to routing policy;
              // never copy the raw provider error into the response.
              observed = { error };
            } finally {
              clearTimeout(timer);
            }
            const health = hub.healthStore.record(providerId, model, observed?.ok === true ? { ok: true } : { error: observed?.error ?? observed });
            return sendJson(res, 200, { ok: true, provider_id: providerId, model, health });
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'verify-delete') {
            if (body?.confirm !== true) return sendJson(res, 400, { ok: false, code: 'PROVIDER_DELETE_VERIFY_CONFIRM_REQUIRED' });
            const { transaction_id: transactionId } = body ?? {};
            const hooks = createProviderDeleteFileHooks({
              profileFile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
              settingsFile: join(CONFIG_DIR, 'harness', 'settings.yaml'),
              configFile: join(CONFIG_DIR, 'config.json'),
              lifecycleFile: join(CONFIG_DIR, 'provider-lifecycle.json'),
              backupDir: join(CONFIG_DIR, 'provider-backups'),
              sharedLockFile: join(CONFIG_DIR, 'provider-store.lock'),
              existingBackupId: transactionId,
              expectedProviderId: providerId,
            });
            const plan = hooks.backupPlan();
            if (!plan || plan.provider_id !== providerId) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_PLAN_PROVIDER_MISMATCH' });
            await hooks.acquireLock();
            try {
              if (providerStoreMutationOwners.get(transactionId) !== providerId || !hub.hasProviderStoreMutation()) {
                if (hub.hasProviderStoreMutation() || !hub.beginProviderStoreMutation()) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_BUSY' });
                providerStoreMutationOwners.set(transactionId, providerId);
              }
              const verification = await hooks.verify(plan);
              const live = await readProviderInventorySnapshot(hub, ctx, config);
              verification.catalog_evidence = live.catalog_evidence;
              verification.default_evidence = live.default_evidence;
              verification.catalogAbsent = hasCompleteProviderCatalogEvidence(live.catalog_evidence)
                && !live.records.some((entry) => entry.id === providerId && entry.lifecycle?.catalogued === true);
              verification.harnessDefault = plan.was_harness_default !== true || (
                live.harness_default?.provider === plan.replacement_default
                && live.harness_default?.model === plan.replacement_default_model
              );
              verification.runtimeRestarted = hasProviderRuntimeRestartEvidence(plan.delete_runtime_id_before_restart, getHubRuntimeIdentity().runtime_id);
              if (verification?.providerAbsent !== true || !hasCompleteProviderCatalogEvidence(verification?.catalog_evidence) || verification?.default_evidence?.ok !== true || verification?.catalogAbsent !== true || verification?.harnessDefault !== true || verification?.runtimeRestarted !== true || verification?.routingClear !== true || verification?.tombstonePresent !== true) {
                return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_VERIFY_FAILED', verification });
              }
              await hooks.recordTransaction({ transaction_id: transactionId, provider_id: providerId, state: 'VERIFIED' }, plan);
              hub.endProviderMutation(providerId);
              if (providerStoreMutationOwners.get(transactionId) === providerId) {
                providerStoreMutationOwners.delete(transactionId);
                hub.endProviderStoreMutation();
              }
              return sendJson(res, 200, { ok: true, transaction_id: transactionId, provider_id: providerId, state: 'VERIFIED', verification });
            } finally {
              await hooks.release();
            }
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'rollback') {
            if (body?.confirm !== true) return sendJson(res, 400, { ok: false, code: 'PROVIDER_ROLLBACK_CONFIRM_REQUIRED' });
            const { transaction_id: transactionId } = body ?? {};
            const hooks = createProviderDeleteFileHooks({
              profileFile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
              settingsFile: join(CONFIG_DIR, 'harness', 'settings.yaml'),
              configFile: join(CONFIG_DIR, 'config.json'),
              lifecycleFile: join(CONFIG_DIR, 'provider-lifecycle.json'),
              backupDir: join(CONFIG_DIR, 'provider-backups'),
              sharedLockFile: join(CONFIG_DIR, 'provider-store.lock'),
              existingBackupId: transactionId,
              expectedProviderId: providerId,
            });
            await hooks.acquireLock();
            let acquiredStoreMutation = false;
            let retainStoreMutation = false;
            try {
              const plan = hooks.backupPlan();
              if (!plan || plan.provider_id !== providerId) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_PLAN_PROVIDER_MISMATCH' });
              if (providerStoreMutationOwners.get(transactionId) !== providerId || !hub.hasProviderStoreMutation()) {
                if (hub.hasProviderStoreMutation() || !hub.beginProviderStoreMutation()) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_BUSY' });
                providerStoreMutationOwners.set(transactionId, providerId);
                acquiredStoreMutation = true;
              }
              await hooks.rollback(plan);
              await hooks.setRuntimeBaseline(getHubRuntimeIdentity().runtime_id, 'rollback');
              const rollbackPlan = hooks.backupPlan() ?? plan;
              try {
                await hooks.recordTransaction({ transaction_id: transactionId, provider_id: providerId, state: 'ROLLBACK_PENDING' }, rollbackPlan);
              } catch (error) {
                return sendJson(res, 409, { ok: false, code: boundedMachineCodeFromError(error) ?? 'PROVIDER_LIFECYCLE_RECORD_FAILED' });
              }
              retainStoreMutation = true;
              return sendJson(res, 202, { ok: true, restart_required: true, transaction_id: transactionId, provider_id: providerId, state: 'ROLLBACK_PENDING' });
            } finally {
              await hooks.release();
              if (acquiredStoreMutation && !retainStoreMutation && providerStoreMutationOwners.get(transactionId) === providerId) {
                providerStoreMutationOwners.delete(transactionId);
                hub.endProviderStoreMutation();
              }
            }
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'verify-rollback') {
            if (body?.confirm !== true) return sendJson(res, 400, { ok: false, code: 'PROVIDER_ROLLBACK_VERIFY_CONFIRM_REQUIRED' });
            const { transaction_id: transactionId } = body ?? {};
            const hooks = createProviderDeleteFileHooks({
              profileFile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
              settingsFile: join(CONFIG_DIR, 'harness', 'settings.yaml'),
              configFile: join(CONFIG_DIR, 'config.json'),
              lifecycleFile: join(CONFIG_DIR, 'provider-lifecycle.json'),
              backupDir: join(CONFIG_DIR, 'provider-backups'),
              sharedLockFile: join(CONFIG_DIR, 'provider-store.lock'),
              existingBackupId: transactionId,
              expectedProviderId: providerId,
            });
            const plan = hooks.backupPlan();
            if (!plan || plan.provider_id !== providerId) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_PLAN_PROVIDER_MISMATCH' });
            await hooks.acquireLock();
            try {
              if (providerStoreMutationOwners.get(transactionId) !== providerId || !hub.hasProviderStoreMutation()) {
                if (hub.hasProviderStoreMutation() || !hub.beginProviderStoreMutation()) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_BUSY' });
                providerStoreMutationOwners.set(transactionId, providerId);
              }
              const verified = await hooks.verifyRollback(plan);
              const live = await readProviderInventorySnapshot(hub, ctx, config);
              verified.catalog_evidence = live.catalog_evidence;
              verified.default_evidence = live.default_evidence;
              verified.catalogPresent = hasCompleteProviderCatalogEvidence(live.catalog_evidence)
                && live.records.some((entry) => entry.id === providerId && entry.lifecycle?.catalogued === true);
              verified.harnessDefaultRestored = plan.was_harness_default !== true || (
                live.harness_default?.provider === plan.harness_default_before?.provider
                && live.harness_default?.model === plan.harness_default_before?.model
              );
              verified.runtimeRestarted = hasProviderRuntimeRestartEvidence(plan.rollback_runtime_id_before_restart, getHubRuntimeIdentity().runtime_id);
              if (verified?.ok !== true || !hasCompleteProviderCatalogEvidence(verified?.catalog_evidence) || verified?.default_evidence?.ok !== true || verified?.catalogPresent !== true || verified?.harnessDefaultRestored !== true || verified?.runtimeRestarted !== true) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_ROLLBACK_VERIFY_FAILED', verification: verified });
              await hooks.recordTransaction({ transaction_id: transactionId, provider_id: providerId, state: 'ROLLED_BACK' }, plan);
              hub.endProviderMutation(providerId);
              if (providerStoreMutationOwners.get(transactionId) === providerId) {
                providerStoreMutationOwners.delete(transactionId);
                hub.endProviderStoreMutation();
              }
              return sendJson(res, 200, { ok: true, transaction_id: transactionId, provider_id: providerId, state: 'ROLLED_BACK' });
            } finally {
              await hooks.release();
            }
          }
          if (req.method === 'DELETE' && parts.length === 1) {
            if (body?.confirm !== true) return sendJson(res, 400, { ok: false, code: 'PROVIDER_DELETE_CONFIRM_REQUIRED' });
            if (body?.purge_orphan_credentials === true) {
              return sendJson(res, 400, { ok: false, code: 'CREDENTIAL_PURGE_REQUIRES_EXPLICIT_CONFIRMATION' });
            }
            const stored = providerDeletePlans.get(body?.plan_id);
            if (!stored || Date.now() - stored.created_at > PROVIDER_DELETE_PLAN_TTL_MS || stored.plan.provider_id !== providerId) {
              providerDeletePlans.delete(body?.plan_id);
              return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_PLAN_EXPIRED' });
            }
            const revisions = readProviderSourceRevisions();
            if (!revisions.profile.ok && !revisions.settings.ok) return sendJson(res, 409, { ok: false, code: revisions.profile.code ?? revisions.settings.code });
            if (providerId !== 'deepseek-official' && !hasCompleteProviderCatalogEvidence(inventory.catalog_evidence)) return sendJson(res, 503, { ok: false, code: 'MODEL_CATALOG_UNAVAILABLE' });
            if (providerId !== 'deepseek-official' && !hasCompleteProviderDeclarationEvidence(inventory.declaration_evidence)) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_SOURCE_UNRESOLVED' });
            if (providerId !== 'deepseek-official' && !hasAvailableProviderLifecycleEvidence(inventory.lifecycle_evidence)) return sendJson(res, 503, { ok: false, code: 'PROVIDER_LIFECYCLE_UNAVAILABLE' });
            if (providerId !== 'deepseek-official' && inventory.default_evidence?.ok !== true) return sendJson(res, 409, { ok: false, code: inventory.default_evidence?.code ?? 'PROVIDER_DEFAULT_AUTHORITY_UNAVAILABLE' });
            const storedExpected = stored.plan.expected_revisions;
            const revisionsMatch = storedExpected
              ? (storedExpected.profile === (revisions.profile.ok ? revisions.profile.revision : null)
                && storedExpected.settings === (revisions.settings.ok ? revisions.settings.revision : null))
              : (body?.expected_revision === stored.plan.expected_revision && (revisions.profile.revision ?? revisions.settings.revision) === stored.plan.expected_revision);
            if (!revisionsMatch || body?.expected_revision !== stored.plan.expected_revision) {
              return sendJson(res, 409, { ok: false, code: 'PROVIDER_PROFILE_CHANGED' });
            }
            if (providerId !== 'deepseek-official' && hasPendingProviderRecoveryTransactions(inventory)) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_RECOVERY_PENDING' });
            const refreshed = planProviderDelete({
              providerId,
              inventory,
              activeJobs: hub.list(),
              replacementDefault: stored.plan.replacement_default,
              expectedRevision: stored.plan.expected_revision,
              expectedRevisions: stored.plan.expected_revisions,
            });
            if (!refreshed.ok) return sendJson(res, 409, { ok: false, code: refreshed.code });
            if (refreshed.plan.replacement_default_model !== stored.plan.replacement_default_model) {
              return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_PLAN_CHANGED' });
            }
            let executionPlan = {
              ...refreshed.plan,
              plan_id: stored.plan.plan_id,
              expected_revision: stored.plan.expected_revision,
              expected_revisions: stored.plan.expected_revisions,
              runtime_id_before: stored.plan.runtime_id_before,
            };
            if (!hub.beginProviderStoreMutation()) return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_BUSY' });
            if (!hub.beginProviderMutation(providerId)) {
              hub.endProviderStoreMutation();
              return sendJson(res, 409, { ok: false, code: 'PROVIDER_DELETE_BUSY' });
            }
            let hooks = null;
            let lockAcquired = false;
            let retainProviderMutation = false;
            let retainProviderStoreMutation = false;
            try {
              hooks = createProviderDeleteFileHooks({
                profileFile: join(CONFIG_DIR, 'harness', 'profiles', 'dsh-crew', 'cordis.patch.yml'),
                settingsFile: join(CONFIG_DIR, 'harness', 'settings.yaml'),
                configFile: join(CONFIG_DIR, 'config.json'),
                lifecycleFile: join(CONFIG_DIR, 'provider-lifecycle.json'),
                backupDir: join(CONFIG_DIR, 'provider-backups'),
                sharedLockFile: join(CONFIG_DIR, 'provider-store.lock'),
                runtimeIdProvider: () => getHubRuntimeIdentity().runtime_id,
                afterLockAcquired: () => {
                  const pendingRecovery = [
                    ...readProviderRecoveryTransactions(),
                    ...readProviderLayerMigrationTransactions(join(CONFIG_DIR, 'provider-migration-backups')),
                  ];
                  if (pendingRecovery.length > 0) {
                    throw Object.assign(new Error('provider recovery transaction is pending'), { code: 'PROVIDER_DELETE_RECOVERY_PENDING' });
                  }
                  if (hub.hasProviderLease(providerId)) {
                    throw Object.assign(new Error('provider is in use'), { code: 'PROVIDER_IN_USE' });
                  }
                },
              });
              // Hold the real shared store lock while rebuilding the live
              // inventory and delete plan. The pre-lock plan is only a
              // proposal; catalog/default/ownership/recovery facts must be
              // authoritative at the mutation boundary.
              await hooks.acquireLock();
              lockAcquired = true;
              const lockedConfig = normalizeGlobalConfig(hub.getConfig?.() ?? {});
              const lockedInventory = await readProviderInventorySnapshot(hub, ctx, lockedConfig);
              const lockedRevisions = readProviderSourceRevisions();
              const lockedExpected = stored.plan.expected_revisions;
              const lockedRevisionsMatch = lockedExpected
                ? lockedExpected.profile === (lockedRevisions.profile.ok ? lockedRevisions.profile.revision : null)
                  && lockedExpected.settings === (lockedRevisions.settings.ok ? lockedRevisions.settings.revision : null)
                : false;
              if (providerId !== 'deepseek-official' && !hasCompleteProviderCatalogEvidence(lockedInventory.catalog_evidence)) throw Object.assign(new Error('provider catalog unavailable after lock'), { code: 'MODEL_CATALOG_UNAVAILABLE' });
              if (providerId !== 'deepseek-official' && !hasCompleteProviderDeclarationEvidence(lockedInventory.declaration_evidence)) throw Object.assign(new Error('provider declarations unavailable after lock'), { code: 'PROVIDER_DELETE_SOURCE_UNRESOLVED' });
              if (providerId !== 'deepseek-official' && !hasAvailableProviderLifecycleEvidence(lockedInventory.lifecycle_evidence)) throw Object.assign(new Error('provider lifecycle unavailable after lock'), { code: 'PROVIDER_LIFECYCLE_UNAVAILABLE' });
              if (providerId !== 'deepseek-official' && lockedInventory.default_evidence?.ok !== true) throw Object.assign(new Error('provider default authority changed after lock'), { code: lockedInventory.default_evidence?.code ?? 'PROVIDER_DEFAULT_AUTHORITY_UNAVAILABLE' });
              if (providerId !== 'deepseek-official' && hasPendingProviderRecoveryTransactions(lockedInventory)) throw Object.assign(new Error('provider recovery transaction is pending'), { code: 'PROVIDER_DELETE_RECOVERY_PENDING' });
              if (!lockedRevisionsMatch) throw Object.assign(new Error('provider source changed after lock'), { code: 'PROVIDER_PROFILE_CHANGED' });
              if (hub.hasProviderLease(providerId)) throw Object.assign(new Error('provider is in use'), { code: 'PROVIDER_IN_USE' });
              const lockedPlan = planProviderDelete({
                providerId,
                inventory: lockedInventory,
                activeJobs: hub.list(),
                replacementDefault: stored.plan.replacement_default,
                expectedRevision: stored.plan.expected_revision,
                expectedRevisions: stored.plan.expected_revisions,
              });
              if (!lockedPlan.ok) throw Object.assign(new Error('provider delete plan changed after lock'), { code: lockedPlan.code });
              const sameLockedPlan = lockedPlan.plan.replacement_default_model === stored.plan.replacement_default_model
                && lockedPlan.plan.was_harness_default === stored.plan.was_harness_default
                && JSON.stringify(lockedPlan.plan.declaration_authorities) === JSON.stringify(stored.plan.declaration_authorities)
                && JSON.stringify(lockedPlan.plan.harness_default_before ?? null) === JSON.stringify(stored.plan.harness_default_before ?? null)
                && JSON.stringify(lockedPlan.plan.credential_refs) === JSON.stringify(stored.plan.credential_refs);
              if (!sameLockedPlan) throw Object.assign(new Error('provider delete plan semantics changed after lock'), { code: 'PROVIDER_DELETE_PLAN_CHANGED' });
              executionPlan = {
                ...lockedPlan.plan,
                plan_id: stored.plan.plan_id,
                expected_revision: stored.plan.expected_revision,
                expected_revisions: stored.plan.expected_revisions,
                runtime_id_before: stored.plan.runtime_id_before,
              };
              providerDeletePlans.delete(body.plan_id);
              const { executeProviderDelete } = await import('../provider-lifecycle.mjs');
              const result = await executeProviderDelete(executionPlan, hooks, { deferRestart: true });
              retainProviderMutation = result.state === 'RESTART_PENDING';
              if (retainProviderMutation) {
                providerStoreMutationOwners.set(executionPlan.plan_id, providerId);
                retainProviderStoreMutation = true;
              }
              return sendJson(res, result.state === 'RESTART_PENDING' ? 202 : 409, { ok: result.state === 'RESTART_PENDING', restart_required: true, result });
            } finally {
              if (lockAcquired && hooks) await hooks.release().catch(() => {});
              if (!retainProviderMutation) hub.endProviderMutation(providerId);
              if (!retainProviderStoreMutation) hub.endProviderStoreMutation();
            }
          }
          return sendJson(res, 404, { ok: false, error: 'unknown providers endpoint' });
        } catch (err) {
          const isProbe = req.method === 'POST' && parts.length === 2 && parts[1] === 'probe';
          const code = boundedMachineCodeFromError(err) ?? (isProbe ? 'PROVIDER_PROBE_FAILED' : 'PROVIDER_PLAN_INVALID');
          const status = code === 'PROVIDER_DELETE_RESTART_SUPERVISOR_UNAVAILABLE' || code.startsWith('PROVIDER_PROBE') ? 503
            : code.startsWith('PROVIDER_') || code.startsWith('CREDENTIAL_') ? 409 : 400;
          return sendJson(res, status, { ok: false, code });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/provider-health`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' });
        return sendJson(res, 200, {
          ok: true,
          schema_version: 1,
          health: hub.healthStore.list(),
          runtime: getHubRuntimeIdentity(),
        });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/models`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST' }, { allow: 'GET, POST' });
        try {
          const catalog = await readHarnessModelCatalog({
            llm: ctx.llm ?? ctx.get('llm'),
            getCurrentSelection: () => ctx.get('agentDefaultModel')?.currentSelection?.(),
          });
          return sendJson(res, 200, { ok: true, ...catalog });
        } catch (error) {
          return sendJson(res, 503, { ok: false, code: error?.code ?? 'MODEL_CATALOG_UNAVAILABLE', error: 'Unable to read Harness model catalog.' });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/vision-models`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const url = new URL(req.url, 'http://localhost');
          const provider = url.searchParams.get('provider');
          const force = url.searchParams.get('refresh') === '1';
          const lang = url.searchParams.get('lang');
          adoptLang(lang);
          const { listVisionModels } = await import('../multimodal.mjs');
          const { readGlobalConfig } = await import('../install/install.mjs');
          return sendJson(res, 200, { ok: true, models: await listVisionModels(provider, force, () => readGlobalConfig(), lang) });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/provider-test`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        try {
          // The entry comes from the panel form so unsaved edits can be probed.
          const entry = await readBody(req);
          adoptLang(entry?.lang);
          const { testProvider } = await import('../multimodal.mjs');
          const result = await testProvider(entry, entry?.lang);
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/install/status`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const { installStatus } = await import(`../install/install.mjs?t=${Date.now()}`);
          return sendJson(res, 200, { ok: true, status: installStatus() });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact', path: `${ROUTE_BASE}/install`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });
        try {
          const { target, statusline } = await readBody(req);
          // Cache-busted import: the installer must always run the code
          // currently on disk, not whatever this process first loaded —
          // a stale cached copy once re-broke user settings after a fix.
          const { installClaudeCode, installCodex, installHudSegment, uninstallClaudeCode, uninstallCodex, installZCode, uninstallZCode } =
            await import(`../install/install.mjs?t=${Date.now()}`);
          if (target === 'claude') {
            const base = await installClaudeCode({ statusline: !!statusline });
            const hud = installHudSegment({});
            return sendJson(res, 200, {
              ok: base.ok,
              actions: [...base.actions, ...hud.actions.map((a) => `hud: ${a}`)],
            });
          }
          if (target === 'codex') return sendJson(res, 200, installCodex({}));
          if (target === 'zcode') return sendJson(res, 200, installZCode({}));
          if (target === 'claude-uninstall') return sendJson(res, 200, uninstallClaudeCode({}));
          if (target === 'codex-uninstall') return sendJson(res, 200, uninstallCodex({}));
          if (target === 'zcode-uninstall') return sendJson(res, 200, uninstallZCode({}));
          return sendJson(res, 400, { ok: false, error: 'target must be claude | codex | zcode | claude-uninstall | codex-uninstall | zcode-uninstall' });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    return () => { for (const d of disposers.reverse()) d(); };
  });

  ctx.logger?.info?.('dsh-crew hub mounted (jobs API + installer endpoints + multimodal tools)');
  return async () => {
    for (const d of disposers.reverse()) { try { d(); } catch {} }
    await hub.dispose();
  };
}
