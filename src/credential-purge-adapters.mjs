// Crew-owned credential purge adapter.
//
// The Harness credential store is intentionally narrow: only scalar env refs
// in the Crew-owned `.credentials.yaml` are supported. The adapter never
// returns or logs values and refuses paths outside the isolated Crew home.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, join } from 'node:path';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function failure(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function inside(root, file) {
  const rel = relative(resolve(root), resolve(file));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function parseRefs(source) {
  const lines = String(source ?? '').split(/\r?\n/);
  const entries = [];
  let refs = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (!refs) {
      if (indent === 0 && /^refs:\s*(?:#.*)?$/u.test(line)) refs = true;
      continue;
    }
    if (indent === 0) break;
    if (indent !== 2) throw failure('CREDENTIAL_STORE_MALFORMED', 'credential refs shape is unsupported');
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):(?:\s|$)/u.exec(line);
    if (!match) throw failure('CREDENTIAL_STORE_MALFORMED', 'credential refs shape is unsupported');
    entries.push({ key: match[1], index });
  }
  return { lines, entries };
}

function planEnvName(plan) {
  if (plan?.kind !== 'env' || typeof plan?.name_or_handle !== 'string' || !ENV_NAME.test(plan.name_or_handle)) {
    throw failure('CREDENTIAL_PURGE_KIND_UNSUPPORTED');
  }
  if (plan.reference_id !== `env:${plan.name_or_handle}`) throw failure('CREDENTIAL_REFERENCE_CHANGED');
  return plan.name_or_handle;
}

function readStore(file) {
  if (!existsSync(file)) throw failure('CREDENTIAL_STORE_MISSING');
  let source;
  try { source = readFileSync(file, 'utf8'); } catch { throw failure('CREDENTIAL_STORE_UNREADABLE'); }
  return { source, ...parseRefs(source) };
}

function writeAtomic(file, content) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(file)}.${process.pid}.${Date.now()}.${randomUUID()}.dsh-crew.tmp`);
  try {
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, file);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch {}
    throw failure('CREDENTIAL_STORE_WRITE_FAILED', error?.code ?? 'CREDENTIAL_STORE_WRITE_FAILED');
  }
}

export function createCredentialPurgeFileHooks({ credentialsFile, crewHome } = {}) {
  if (typeof credentialsFile !== 'string' || typeof crewHome !== 'string'
    || !isAbsolute(credentialsFile) || !isAbsolute(crewHome)
    || !inside(crewHome, credentialsFile)) {
    return { ok: false, code: 'CREDENTIAL_STORE_PATH_UNSAFE' };
  }
  const file = resolve(credentialsFile);
  return {
    ok: true,
    async purge(plan) {
      const name = planEnvName(plan);
      const current = readStore(file);
      const entry = current.entries.find((candidate) => candidate.key === name);
      if (!entry) throw failure('CREDENTIAL_REFERENCE_NOT_FOUND');
      const newline = current.source.includes('\r\n') ? '\r\n' : '\n';
      const lines = [...current.lines];
      lines.splice(entry.index, 1);
      writeAtomic(file, lines.join(newline));
      return { ok: true, reference_id: plan.reference_id };
    },
    async verify(plan) {
      const name = planEnvName(plan);
      const current = readStore(file);
      if (current.entries.some((candidate) => candidate.key === name)) {
        return { ok: false, absent: false, reference_id: plan.reference_id };
      }
      return { ok: true, absent: true, reference_id: plan.reference_id };
    },
  };
}
