function clean(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export const MAX_MODEL_INVOCATION_JOBS = 500;
export const MAX_MODEL_ACTIVITY_ROWS = 50;

function hasInvocationEvidence(job) {
  const tokenCount = Number(job?.tokens?.input ?? 0) + Number(job?.tokens?.output ?? 0);
  return Number(job?.turn ?? 0) > 0 || Number(job?.toolCalls ?? 0) > 0 || tokenCount > 0;
}

/**
 * Build a bounded, presentation-only model activity summary from the jobs the
 * Hub already exposes. No prompts, results, credentials, or new persistence
 * are introduced here.
 */
export function aggregateModelInvocations(jobs = []) {
  const groups = new Map();
  const recentJobs = Array.isArray(jobs) ? jobs.slice(-MAX_MODEL_INVOCATION_JOBS) : [];
  for (const job of recentJobs) {
    const provider = clean(job?.provider, '');
    const model = clean(job?.model, '');
    if (!provider || !model || !hasInvocationEvidence(job)) continue;
    const key = `${provider}\0${model}`;
    const current = groups.get(key) ?? {
      provider,
      model,
      count: 0,
      taskSources: new Set(),
      selectionSources: new Set(),
      roles: new Set(),
      lastCalledAt: null,
    };
    current.count += 1;
    current.taskSources.add(clean(job?.source, 'api'));
    current.selectionSources.add(clean(job?.selection_source, 'unknown'));
    current.roles.add(job?.role === 'reviewer' ? 'reviewer' : 'worker');
    const calledAt = validTimestamp(job?.startedAt);
    if (calledAt && (!current.lastCalledAt || Date.parse(calledAt) > Date.parse(current.lastCalledAt))) {
      current.lastCalledAt = calledAt;
    }
    groups.set(key, current);
  }

  return [...groups.values()]
    .sort((left, right) => {
      const timeDelta = (right.lastCalledAt ? Date.parse(right.lastCalledAt) : -1)
        - (left.lastCalledAt ? Date.parse(left.lastCalledAt) : -1);
      return timeDelta || `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`);
    })
    .slice(0, MAX_MODEL_ACTIVITY_ROWS)
    .map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      count: entry.count,
      task_sources: sorted(entry.taskSources),
      selection_sources: sorted(entry.selectionSources),
      roles: sorted(entry.roles),
      last_called_at: entry.lastCalledAt,
    }));
}
