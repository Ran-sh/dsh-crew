import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { acquireUpdateLock, releaseUpdateLock, createCrewSupervisor } from '../install/npx-lifecycle.mjs';
import { readMaintenanceSession } from '../supervisor/restart-request.mjs';
import { runHistoryOperation } from './operation.mjs';
import { readHistoryState } from './state.mjs';
import { TARGET_DSH_VERSION } from '../dsh-cohort.mjs';

async function portFree(port = 3210) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
  });
}

/**
 * The stopped window, proven from outside the launcher that reported it.
 *
 * `storages/workspace.json` is rewritten by this operation and is held in memory
 * by every DSH server on the home, so the window has to cover more than the hub:
 * the Crew-managed frontend on 3080 shares that home and is stopped for the same
 * window (`refresh_frontend`). Both ports are re-probed here rather than taken
 * on the launcher's word, and the session must be the one this transaction
 * stopped — a lease alone never means the servers are gone.
 */
export async function stoppedWindowIsClean({ session, lease, runtimeId, probe = portFree }) {
  if (!session?.ok || session.state !== 'present') return false;
  if (session.session?.lease !== lease || session.session?.runtime_id !== runtimeId) return false;
  if (!await probe(3210)) return false;
  return session.session?.frontend_stopped === true ? await probe(3080) : true;
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
    assertStopped: async s => stoppedWindowIsClean({
      session: readMaintenanceSession(crewRoot), lease: s.lease, runtimeId: s.runtimeId,
    }),
    verifyRunning: async s => {
      try {
        const response = await fetch('http://127.0.0.1:3210/_dsh/dsh-crew/runtime', { signal: AbortSignal.timeout(3000) });
        const runtime = await response.json();
        return response.ok && runtime.ok === true && runtime.service === 'dsh-crew-hub' && runtime.profile === 'dsh-crew'
          && runtime.execution_plane === 'hub-3210' && runtime.listen_port === 3210 && runtime.protocol_version === 1
          && runtime.dsh_version === TARGET_DSH_VERSION && typeof runtime.runtime_id === 'string' && runtime.runtime_id !== s.runtimeId;
      } catch { return false; }
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runProductionHistory({ id: process.argv[2], recover: process.argv.includes('--recover') }).catch(() => { process.exitCode = 1; });
}
