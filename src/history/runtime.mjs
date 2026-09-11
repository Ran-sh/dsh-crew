import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getHubRuntimeIdentity } from '../runtime-identity.mjs';
import { TARGET_DSH_VERSION } from '../dsh-cohort.mjs';
import { createHistoryService } from './service.mjs';
import { registerHistoryHttp } from './http.mjs';

export function registerRuntimeHistory(ctx) {
  const crewRoot = join(homedir(), '.config', 'dsh-crew');
  const runtime = getHubRuntimeIdentity();
  const owned = process.platform === 'win32' && runtime.dsh_version === TARGET_DSH_VERSION
    && resolve(process.env.DSH_HOME ?? '').toLowerCase() === resolve(join(crewRoot, 'harness')).toLowerCase();
  if (!owned) return () => {};
  return ctx.inject(['webServer', 'sessionPersistence', 'agents'], host => {
    const service = createHistoryService({ crewRoot, agents: host.agents, persistence: host.sessionPersistence,
      runtimeId: runtime.runtime_id, launch(id, recover = false) {
        return new Promise((accept, reject) => {
          // Spawn through a launcher that exits immediately: a runner parented by
          // this hub would sit inside the hub's tracked process tree and be killed
          // by the stop it requested. See runner-detach.mjs.
          const child = spawn(process.execPath, [
            fileURLToPath(new URL('./runner-detach.mjs', import.meta.url)),
            fileURLToPath(new URL('./runner.mjs', import.meta.url)),
            id, ...(recover ? ['--recover'] : []),
          ], {
            windowsHide: true, stdio: 'ignore', env: { ...process.env },
          });
          child.once('error', reject); child.once('spawn', () => { child.unref(); accept(); });
        });
      } });
    const disposeHttp = registerHistoryHttp(host.webServer, service);
    return () => { disposeHttp?.(); service.dispose(); };
  });
}
