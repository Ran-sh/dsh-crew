import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getHubRuntimeIdentity } from '../runtime-identity.mjs';
import { createHistoryService } from './service.mjs';
import { registerHistoryHttp } from './http.mjs';

export function registerRuntimeHistory(ctx) {
  const crewRoot = join(homedir(), '.config', 'dsh-crew');
  const runtime = getHubRuntimeIdentity();
  const owned = process.platform === 'win32' && runtime.dsh_version === '0.1.2-rc.1'
    && resolve(process.env.DSH_HOME ?? '').toLowerCase() === resolve(join(crewRoot, 'harness')).toLowerCase();
  if (!owned) return () => {};
  return ctx.inject(['webServer', 'sessionPersistence', 'agents'], host => {
    const service = createHistoryService({ crewRoot, agents: host.agents, persistence: host.sessionPersistence,
      runtimeId: runtime.runtime_id, launch(id, recover = false) {
        return new Promise((accept, reject) => {
          const child = spawn(process.execPath, [fileURLToPath(new URL('./runner.mjs', import.meta.url)), id, ...(recover ? ['--recover'] : [])], {
            detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env },
          });
          child.once('error', reject); child.once('spawn', () => { child.unref(); accept(); });
        });
      } });
    const disposeHttp = registerHistoryHttp(host.webServer, service);
    return () => { disposeHttp?.(); service.dispose(); };
  });
}
