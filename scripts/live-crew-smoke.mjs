// Live Crew worker smoke against the running DSH hub (Stage 4 provider routing).
// Creates a temp fixture as cwd, spawns flash, polls, prints job metadata.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const BASE = 'http://127.0.0.1:3080/_dsh/dsh-crew';

(async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh4-fixture-'));
  fs.writeFileSync(path.join(fixture, 'note.txt'), 'hello');
  const cwd = fixture.replace(/\\/g, '/');
  console.log('fixture:', cwd);
  console.log('provider route:', JSON.stringify(await (await fetch(`${BASE}/provider`)).json()));

  const tier = process.argv[2] ?? 'flash';
  const res = await fetch(`${BASE}/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Reply with exactly: CREW_OPENCODE_GO_OK', tier, effort: 'off', cwd }),
  });
  const spawned = await res.json();
  console.log('spawn:', JSON.stringify(spawned).slice(0, 260));
  if (!spawned.ok && !spawned.job) { process.exit(1); }
  const id = (spawned.job ?? spawned).id;

  // Poll for up to 120s.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const r = await (await fetch(`${BASE}/jobs/${id}?wait=0`)).json();
    const j = r.job ?? r;
    if (!['running', 'pending'].includes(j.status)) {
      console.log('final:', JSON.stringify({ id: j.id, tier: j.tier, model: j.model, status: j.status, result: (j.result || '').slice(0, 120), error: (j.error || '').slice(0, 200), tokens: j.tokens }, null, 2));
      process.exit(j.status === 'done' ? 0 : 2);
    }
  }
  console.log('TIMEOUT waiting for job', id);
  process.exit(3);
})();
