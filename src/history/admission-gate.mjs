/**
 * Crew-profile-only runtime adapter. Fence the public agent creation entry,
 * including creations still awaiting publication in the official agent list.
 * Callers must persist their maintenance marker BEFORE asking idle().
 * No original agent is cancelled or disposed by this adapter.
 */
const installed = new WeakSet();

export function installHistoryAdmissionGate(agents, isMaintenancePending) {
  if (typeof agents?.create !== 'function' || typeof agents?.list !== 'function'
    || typeof isMaintenancePending !== 'function') throw new Error('HISTORY_ADMISSION_UNAVAILABLE');
  if (installed.has(agents)) throw new Error('HISTORY_ADMISSION_ALREADY_INSTALLED');
  const original = agents.create;
  let creating = 0;
  async function guardedCreate(...args) {
    if (isMaintenancePending()) throw new Error('HISTORY_MAINTENANCE_PENDING');
    creating += 1;
    try { return await original.apply(this, args); }
    finally { creating -= 1; }
  }
  agents.create = guardedCreate;
  installed.add(agents);
  return {
    idle() {
      if (agents.create !== guardedCreate) return false;
      try {
        const live = agents.list();
        return Array.isArray(live) && creating === 0 && live.length === 0;
      } catch { return false; }
    },
    dispose() {
      if (agents.create === guardedCreate) agents.create = original;
      installed.delete(agents);
    },
  };
}
