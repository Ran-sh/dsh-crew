// Durable provenance for sessions the Crew hub created.
//
// Cleanup needs to tell a session Crew dispatched apart from one the operator
// opened in the same UI, because they are otherwise identical: both are ordinary
// Harness sessions in one shared store, with the same header shape (no field
// records who asked for them). Provenance has to be recorded at the moment of
// creation, which only the hub knows.
//
// This is deliberately an append-only JSONL file rather than a rewrite of the
// status shards: a shard removes itself on clean process exit, so it is a
// best-effort view of live writers, not a record of what was ever created.
//
// Absence is not proof of user authorship — a session predating this ledger, or
// one whose line was lost, simply stays unclaimed. Unclaimed sessions are treated
// as the operator's and are never removed by a Crew-scoped cleanup.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function sessionOriginsFile({ home = homedir() } = {}) {
  return join(home, '.config', 'dsh-crew', 'session-origins.jsonl');
}

/**
 * Record that Crew created one session. Best effort: losing a line weakens a
 * later cleanup's scope, so it must never fail a dispatch that already started.
 */
export function appendSessionOrigin({ home = homedir(), sessionId, role = null, jobId = null, now = Date.now } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  try {
    const file = sessionOriginsFile({ home });
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ sessionId, role, jobId, createdAt: now() })}\n`);
    return true;
  } catch { return false; }
}

/**
 * Session ids Crew is known to have created.
 *
 * A malformed or truncated line is skipped rather than thrown: the ledger is an
 * optimization for scope, and a damaged tail must not make cleanup unusable. The
 * failure direction is safe — an unread session is treated as the operator's.
 */
export function readSessionOrigins({ home = homedir() } = {}) {
  const file = sessionOriginsFile({ home });
  if (!existsSync(file)) return new Set();
  try {
    const ids = new Set();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (typeof row?.sessionId === 'string' && row.sessionId) ids.add(row.sessionId);
      } catch { /* skip a torn line */ }
    }
    return ids;
  } catch { return new Set(); }
}
