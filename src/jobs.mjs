// Job manager: each job runs one dsh-jsonrpc-agent runtime via the DSH SDK.
// Progress derived from session.event notifications; status mirrored to a
// JSON file so the Claude Code statusline (and anything else) can render it.
//
// alpha.5 SDK surface: DeepSeekHarness takes HarnessClientOptions at the top
// level (no `launch` wrapper). The runtime is the installed same-version dsh
// CLI booted on the `sdk-minimal` profile, with the worker overlay applied as
// a --patch. `@deepseek-ai/dsh` and `@deepseek-ai/dsh-sdk-client` must be the
// same version (enforced inside the SDK client; dsh-crew also asserts it via
// the Crew runtime module so a custom dshBin cannot bypass the check).

import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createShardWriter } from './status-shard.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { appendDeliveryInstructions, parseDeliveryReport, formatDeliveryMetadata } from './delivery.mjs';
import { captureWorkspaceBaseline, captureWorkspaceDiff, NOT_A_GIT_REPOSITORY } from './workspace-audit.mjs';
import { buildOutcome, JOB_PHASES } from './workflow.mjs';
import { raceWaiters } from './removable-waiter.mjs';
import { buildDirectSelectionTrace } from './model-routing.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = join(homedir(), '.config', 'dsh-crew');
const CREW_DSH_HOME = join(homedir(), '.config', 'dsh-crew', 'harness');
const STATUS_FILE = join(CONFIG_DIR, 'status.json');
const CORDIS = join(ROOT, 'worker.cordis.yml');

// The worker composition rides the installed same-version dsh CLI on the
// `sdk` profile as a --patch overlay (alpha.5 SDK surface). The CLI entry is
// resolved from the installed @deepseek-ai/dsh package; the legacy
// dsh-sdk-jsonrpc-demo bin no longer exists.
const requireAgents = createRequire(import.meta.url);
let DSH_BIN = null;
for (const spec of ['@deepseek-ai/dsh/lib/bin.js']) {
  try { DSH_BIN = requireAgents.resolve(spec); break; } catch {}
}
if (!DSH_BIN) DSH_BIN = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

export const TIERS = {
  flash: { model: 'deepseek-v4-flash', label: 'V4 Flash' },
  pro: { model: 'deepseek-v4-pro', label: 'V4 Pro' },
};

// v0.2: a job carries a dispatch role (worker | reviewer) plus its legacy
// tier slot. The role describes who did the work; the tier is the model-class
// slot that standalone mode falls back to (role = execution intent).
export const ROLES = {
  worker: { canReview: false },
  reviewer: { canReview: true },
};

function loadDotEnv() {
  const out = {};
  try {
    for (const line of readFileSync(join(CONFIG_DIR, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[2]) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}

const jobs = new Map();
let nextId = 1;
const shard = createShardWriter('mcp');

function publishStatus() {
  shard.publish([...jobs.values()].map((j) => ({
    id: j.id, role: j.role ?? 'worker', attempt: j.attempt ?? 0, phase: j.phase ?? null, tier: j.tier, provider: j.provider, model: j.model, selection_source: j.selection_source,
    selection_trace: j.selection_trace ?? null,
    effort: j.effort, requested_effort: j.effort, reasoning_effort: j.reasoning_effort ?? j.effort,
    status: j.status, source: j.source,
    task: j.task.slice(0, 300), cwd: j.cwd, turn: j.turn, step: j.step, toolCalls: j.toolCalls,
    currentTool: j.currentTool, tokens: j.tokens,
    startedAt: j.startedAt, endedAt: j.endedAt,
    delivery_complete: !!j.delivery_complete,
    workspace_diff_available: !!j.workspaceDiff && j.workspaceDiff.kind === 'git',
  })));
}

export function jobView(j, { withResult = false } = {}) {
  const v = {
    id: j.id, role: j.role ?? 'worker', attempt: j.attempt ?? 0, phase: j.phase ?? null, tier: j.tier, provider: j.provider, model: j.model, selection_source: j.selection_source,
    selection_trace: j.selection_trace ?? null,
    effort: j.effort, requested_effort: j.effort, reasoning_effort: j.reasoning_effort ?? j.effort,
    status: j.status, source: j.source,
    task: j.task.slice(0, 300), turn: j.turn, step: j.step, currentTool: j.currentTool,
    tokens: j.tokens, toolCalls: j.toolCalls, startedAt: j.startedAt, endedAt: j.endedAt,
    delivery_complete: !!j.delivery_complete,
    workspace_diff_available: !!j.workspaceDiff && j.workspaceDiff.kind === 'git',
  };
  if (withResult) {
    v.result = j.result; v.error = j.error; v.stopReason = j.stopReason;
    v.delivery = j.delivery_metadata ?? null;
    v.delivery_missing = j.delivery_missing ?? [];
    v.outcome = j.outcome ?? null;
    v.workspace_diff = j.workspaceDiff ?? null;
    v.workspace_baseline_dirty = !!j.workspaceDiff?.dirtyBaseline;
  }
  return v;
}

export function listJobs() { return [...jobs.values()]; }
export function getJob(id) { return jobs.get(id); }

export function startJob({
  task,
  tier = 'flash',
  role = 'worker',
  attempt = 0,
  effort = 'max',
  cwd,
  maxTokens = 49_152,
  timeoutMs = 1_800_000,
  source = 'api',
  delivery = 'coding',
  modelClassHint = null,
  escalationReason = null,
}) {
  const tierInfo = TIERS[tier];
  if (!tierInfo) throw new Error(`unknown tier "${tier}" (expected: ${Object.keys(TIERS).join(', ')})`);
  if (!ROLES[role]) throw new Error(`unknown role "${role}" (expected: ${Object.keys(ROLES).join(', ')})`);
  if (!['off', 'high', 'max'].includes(effort)) throw new Error(`unknown effort "${effort}" (expected: off, high, max)`);
  if (!existsSync(DSH_BIN)) throw new Error(`dsh CLI not installed at ${DSH_BIN}; run pnpm install in ${ROOT}`);
  if (!existsSync(CORDIS)) throw new Error(`worker composition not found at ${CORDIS}`);
  const workspace = resolve(cwd ?? process.cwd());
  // The worker always gets the auditable Delivery Contract appended (unless it
  // already carries one), so its final message follows ## Diff / ## Tests /
  // ## Risks — or the review contract for reviewer-role jobs.
  const workerPrompt = appendDeliveryInstructions(task, { tier, role, isReview: delivery === 'review' });
  const id = `job-${nextId++}-${Date.now().toString(36)}`;
  const dotEnv = loadDotEnv();
  if (!process.env.DEEPSEEK_API_KEY && !dotEnv.DEEPSEEK_API_KEY) {
    throw new Error(`DEEPSEEK_API_KEY not found in env or ${join(CONFIG_DIR, '.env')}`);
  }

  const harness = new DeepSeekHarness({
    dshBin: DSH_BIN,
    profile: 'sdk-minimal',
    patches: [CORDIS],
    dshHome: CREW_DSH_HOME,
    processCwd: workspace,
    env: {
      ...process.env,
      ...dotEnv,
      DSH_CWD: workspace,
      DSH_SESSION_ROOT: join(CONFIG_DIR, 'sessions'),
      DSH_REASONING_EFFORT: effort,
    },
    requestTimeoutMs: timeoutMs,
    cwd: workspace,
    provider: 'deepseek-official',
    model: tierInfo.model,
    reasoningEffort: effort,
    maxTokens,
  });

  const selectionTrace = buildDirectSelectionTrace({
    role,
    logicalAttempt: attempt,
    modelClassHint: modelClassHint ?? tier,
    strategy: 'standalone-legacy',
    candidateSet: attempt > 0 ? 'escalation' : 'primary',
    provider: 'deepseek-official',
    model: tierInfo.model,
    source: 'standalone-legacy',
    escalationReason,
  });
  const job = {
    id, role, attempt, tier, provider: 'deepseek-official', model: tierInfo.model, selection_source: 'standalone-legacy',
    selection_trace: selectionTrace,
    effort, reasoning_effort: effort, task, source, cwd: workspace,
    prompt: workerPrompt, delivery: delivery === 'review' ? 'review' : 'coding',
    phase: JOB_PHASES.RUNNING,
    status: 'running', turn: 0, step: 0, currentTool: null, toolCalls: 0,
    tokens: { input: 0, output: 0, reasoning: 0 },
    startedAt: new Date().toISOString(), endedAt: null,
    result: null, error: null, stopReason: null, harness,
    delivery_complete: false, delivery_missing: [], delivery_metadata: null,
    outcome: null,
    workspaceDiff: null, baselinePromise: null,
    waiters: [],
  };
  jobs.set(id, job);

  // Read-only pre-run snapshot (async, never blocks dispatch): the audit only
  // needs the before-state by the time the worker finishes. Non-repos degrade
  // to { kind:'no-git' } instead of failing the job.
  job.baselinePromise = captureWorkspaceBaseline({ cwd: workspace })
    .catch(() => ({ kind: 'no-git', reason: NOT_A_GIT_REPOSITORY, error: 'workspace audit failed' }));

  const sessionId = id;
  const onNotification = (n) => {
    if (n.method === 'session.status') return;
    if (n.method !== 'session.event') return;
    if (n.params?.sessionId && n.params.sessionId !== sessionId) return;
    const e = n.params.event;
    if (!e?.type) return;
    switch (e.type) {
      case 'step/start': job.turn = e.data?.turn ?? job.turn; job.step = e.data?.step ?? job.step; break;
      case 'tool/call': job.currentTool = e.data?.name ?? null; job.toolCalls += 1; break;
      case 'tool/result': job.currentTool = null; break;
      case 'assistant/message': {
        const u = e.data?.usage;
        if (u) {
          job.tokens.input += u.inputTokens ?? 0;
          job.tokens.output += u.outputTokens ?? 0;
          job.tokens.reasoning += u.reasoningTokens ?? 0;
        }
        break;
      }
      case 'turn/end': job.stopReason = e.data?.reason?.kind ?? null; break;
    }
    publishStatus();
  };

  job.promise = harness
    .run(workerPrompt, { sessionId, onNotification })
    .then((result) => {
      job.result = result.finalResponse ?? '';
      const lastEnd = [...(result.events ?? [])].reverse().find((ev) => ev?.type === 'turn/end');
      job.stopReason = lastEnd?.data?.reason?.kind ?? job.stopReason;
      job.status = job.stopReason === 'completed' ? 'done' : 'failed';
      if (job.status === 'failed' && !job.error) job.error = `turn ended with reason: ${job.stopReason ?? 'unknown'}`;
    })
    .catch((err) => {
      job.status = job.status === 'cancelled' ? 'cancelled' : 'failed';
      job.error = err?.message ?? String(err);
    })
    .finally(async () => {
      job.endedAt = new Date().toISOString();
      job.currentTool = null;
      try { await harness.close(); } catch {}
      // Delivery completeness is separate from execution status: a job can be
      // done yet fail to report Diff/Tests/Risks. Parse whatever final message
      // the worker produced so the orchestrator can decide whether to accept.
      const parsed = parseDeliveryReport(job.result ?? '');
      job.delivery_complete = parsed.complete;
      job.delivery_missing = parsed.missing;
      job.delivery_metadata = formatDeliveryMetadata(parsed);
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
      const baseline = await job.baselinePromise;
      job.workspaceDiff = baseline.kind === 'git'
        ? await captureWorkspaceDiff({ cwd: workspace, baseline }).catch(() => ({ kind: 'no-git', reason: NOT_A_GIT_REPOSITORY, error: 'workspace diff failed' }))
        : baseline;
      publishStatus();
      for (const w of job.waiters.splice(0)) w();
    });

  publishStatus();
  return job;
}

export async function waitJob(id, timeoutMs) {
  const job = jobs.get(id);
  if (!job) throw new Error(`no such job: ${id}`);
  if (job.status !== 'running') return job;
  await raceWaiters(job.waiters, { timeoutMs });
  return job;
}

export async function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) throw new Error(`no such job: ${id}`);
  if (job.status !== 'running') return job;
  job.status = 'cancelled';
  job.phase = JOB_PHASES.CANCELLED;
  job.error = 'cancelled by request';
  try { await job.harness.close(); } catch {}
  publishStatus();
  return job;
}
