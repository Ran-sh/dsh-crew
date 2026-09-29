import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// windows/start-dsh-crew.ps1 computes its log path and its supervisor state root
// from USERPROFILE/TEMP, so a test that dot-sources it and overrides only the
// PowerShell variables still writes the operator's REAL launcher log and, if it
// forgets a variable, the real supervisor state. Every launcher test therefore
// runs inside a disposable environment; pass `extra` to pin a specific home for a
// test that needs one.
const sandboxes = [];
process.once('exit', () => {
  for (const dir of sandboxes) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

export function launcherSandboxEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crew-launcher-env-'));
  sandboxes.push(dir);
  return {
    ...process.env,
    USERPROFILE: dir,
    TEMP: dir,
    TMP: dir,
    DSH_CREW_LAUNCHER_TEST_IMPORT: '1',
    ...extra,
  };
}
