import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { acquireUpdateLock, releaseUpdateLock, createCrewSupervisor } from '../install/npx-lifecycle.mjs';
import { readMaintenanceSession } from '../supervisor/restart-request.mjs';
import { runHistoryOperation } from './operation.mjs';
import { readHistoryState } from './state.mjs';

async function portFree() {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port: 3210 });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
  });
}

export async function runProductionHistory({ id, recover = false } = {}) {
  if (process.platform !== 'win32') throw Error('HISTORY_PLATFORM_UNSUPPORTED');
  const home = homedir(); const crewRoot = join(home, '.config', 'dsh-crew');
  const state = readHistoryState(crewRoot);
  id ??= state?.id;
  if (!state || id !== state.id) throw Error('HISTORY_OPERATION_CHANGED');
  return runHistoryOperation({ crewRoot, id, recover,
    acquire: () => acquireUpdateLock({ home }), release: lock => releaseUpdateLock({ home, nonce: lock.nonce }),
    supervisor: createCrewSupervisor({ home }),
    checkFence: async () => {
      const response = await fetch('http://127.0.0.1:3210/_dsh/dsh-crew/history/fenced-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) });
      if (!response.ok || (await response.json()).ok !== true) throw Error('HISTORY_FENCE_NOT_IDLE');
    },
    assertStopped: async s => {
      const lease = readMaintenanceSession(crewRoot);
      return lease.ok && lease.state === 'present' && lease.session.lease === s.lease && lease.session.runtime_id === s.runtimeId && await portFree();
    },
    verifyRunning: async s => {
      try {
        const response = await fetch('http://127.0.0.1:3210/_dsh/dsh-crew/runtime', { signal: AbortSignal.timeout(3000) });
        const runtime = await response.json();
        return response.ok && runtime.ok === true && runtime.service === 'dsh-crew-hub' && runtime.profile === 'dsh-crew'
          && runtime.execution_plane === 'hub-3210' && runtime.listen_port === 3210 && runtime.protocol_version === 1
          && runtime.dsh_version === '0.1.2-rc.1' && typeof runtime.runtime_id === 'string' && runtime.runtime_id !== s.runtimeId;
      } catch { return false; }
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runProductionHistory({ id: process.argv[2], recover: process.argv.includes('--recover') }).catch(() => { process.exitCode = 1; });
}
