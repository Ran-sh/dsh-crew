/**
 * Crew-profile-only runtime adapter. Fence the public agent creation entry,
 * including creations still awaiting publication in the official agent list.
 * Callers must persist their maintenance marker BEFORE asking idle().
 * No original agent is cancelled or disposed by this adapter.
 */
const installed = new WeakSet();
const guarded = Symbol.for('dsh-crew.history.admission');
function method(object, name) {
  for (let current = object; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) return descriptor.value;
  }
}

export function installHistoryAdmissionGate(agents, isMaintenancePending) {
  if (typeof agents?.create !== 'function' || typeof agents?.list !== 'function'
    || typeof isMaintenancePending !== 'function') throw new Error('HISTORY_ADMISSION_UNAVAILABLE');
  if (installed.has(agents)) throw new Error('HISTORY_ADMISSION_ALREADY_INSTALLED');
  const entries = ['create', 'resume'].filter(name => typeof method(agents, name) === 'function')
    .map(name => ({ name, original: method(agents, name), wrapper: null }));
  if (!entries.some(entry => entry.name === 'create')) throw new Error('HISTORY_ADMISSION_UNAVAILABLE');
  if (entries.some(entry => entry.original[guarded])) throw new Error('HISTORY_ADMISSION_ALREADY_INSTALLED');
  let creating = 0;
  for (const entry of entries) {
    entry.wrapper = async function(...args) {
      if (isMaintenancePending()) throw new Error('HISTORY_MAINTENANCE_PENDING');
      creating += 1;
      try { return await entry.original.apply(this, args); }
      finally { creating -= 1; }
    };
    entry.wrapper[guarded] = true;
    agents[entry.name] = entry.wrapper;
  }
  installed.add(agents);
  return {
    idle() {
      // Cordis returns fresh traceable callable proxies; compare descriptors,
      // not the per-access wrapper returned by agents.create/resume.
      if (entries.some(entry => method(agents, entry.name) !== entry.wrapper)) return false;
      try {
        const live = agents.list();
        return Array.isArray(live) && creating === 0 && live.length === 0;
      } catch { return false; }
    },
    dispose() {
      for (const entry of entries) if (method(agents, entry.name) === entry.wrapper) agents[entry.name] = entry.original;
      installed.delete(agents);
    },
  };
}
