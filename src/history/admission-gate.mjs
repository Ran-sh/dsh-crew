/**
 * Crew-profile-only runtime adapter. Fence the public agent creation entry,
 * including creations still awaiting publication in the official agent list.
 * Callers must persist their maintenance marker BEFORE asking idle().
 * No original agent is cancelled or disposed by this adapter.
 */
export function installHistoryAdmissionGate(agents, isMaintenancePending) {
  if (typeof agents?.create !== 'function' || typeof agents?.list !== 'function'
    || typeof isMaintenancePending !== 'function') throw new Error('HISTORY_ADMISSION_UNAVAILABLE');
  const original = agents.create;
  let creating = 0;
  async function guardedCreate(...args) {
    if (isMaintenancePending()) throw new Error('HISTORY_MAINTENANCE_PENDING');
    creating += 1;
    try { return await original.apply(this, args); }
    finally { creating -= 1; }
  }
  agents.create = guardedCreate;
  return {
    idle() {
      const live = agents.list();
      if (!Array.isArray(live)) return false;
      return creating === 0 && live.length === 0;
    },
    dispose() {
      if (agents.create === guardedCreate) agents.create = original;
    },
  };
}
