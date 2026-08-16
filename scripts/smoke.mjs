// Smoke test: dispatch one cheap flash job to verify the DeepSeek key and
// runtime wiring. Prints the worker's reply and exits 0 on success.

import { startJob, waitJob, jobView } from '../src/jobs.mjs';

const job = startJob({
  task: 'Reply with exactly the word: ok',
  tier: 'flash',
  effort: 'off',
  cwd: process.cwd(),
});
console.log(`spawned ${job.id} (deepseek-v4-flash) ...`);
await waitJob(job.id, 120_000);
const v = jobView(job, { withResult: true });
if (v.status === 'done') {
  console.log(`worker replied: ${v.result}`);
  console.log('smoke test passed — configuration OK');
} else {
  console.error(`smoke test failed: status=${v.status} error=${v.error}`);
  process.exit(1);
}
