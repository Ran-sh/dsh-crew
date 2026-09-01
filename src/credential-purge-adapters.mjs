// Crew-owned credential purge adapter.
//
// The Harness credential store is intentionally narrow: only scalar env refs
// in the Crew-owned `.credentials.yaml` are supported. The adapter never
// returns or logs values and refuses paths outside the isolated Crew home.

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, join } from 'node:path';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function failure(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function inside(root, file) {
  const rel = relative(resolve(root), resolve(file));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertOwnedRegularStore(root, file) {
  const rootPath = resolve(root);
  const filePath = resolve(file);
  if (!existsSync(rootPath)) throw failure('CREDENTIAL_STORE_PATH_UNSAFE');
  const rootStat = lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('CREDENTIAL_STORE_PATH_UNSAFE');
  const relativePath = relative(rootPath, filePath);
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) throw failure('CREDENTIAL_STORE_PATH_UNSAFE');
  const segments = relativePath.split(/[\\/]/u).filter(Boolean);
  let current = rootPath;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (!existsSync(current)) throw failure('CREDENTIAL_STORE_PATH_UNSAFE');
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('CREDENTIAL_STORE_PATH_UNSAFE');
  }
  if (!existsSync(filePath)) throw failure('CREDENTIAL_STORE_MISSING');
  const fileStat = lstatSync(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw failure('CREDENTIAL_STORE_PATH_UNSAFE');
  const realRoot = realpathSync(rootPath);
  const realFile = realpathSync(filePath);
  if (!inside(realRoot, realFile)) throw failure('CREDENTIAL_STORE_PATH_UNSAFE');
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

function readStore(file, crewHome) {
  assertOwnedRegularStore(crewHome, file);
  let source;
  try { source = readFileSync(file, 'utf8'); } catch { throw failure('CREDENTIAL_STORE_UNREADABLE'); }
  return { source, ...parseRefs(source) };
}

function writeAtomic(file, content, crewHome) {
  const dir = dirname(file);
  assertOwnedRegularStore(crewHome, file);
  const temp = join(dir, `.${basename(file)}.${process.pid}.${Date.now()}.${randomUUID()}.dsh-crew.tmp`);
  try {
    writeFileSync(temp, content, 'utf8');
    assertOwnedRegularStore(crewHome, file);
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
  const root = resolve(crewHome);
  return {
    ok: true,
    async purge(plan) {
      const name = planEnvName(plan);
      const current = readStore(file, root);
      const entry = current.entries.find((candidate) => candidate.key === name);
      if (!entry) throw failure('CREDENTIAL_REFERENCE_NOT_FOUND');
      const newline = current.source.includes('\r\n') ? '\r\n' : '\n';
      const lines = [...current.lines];
      lines.splice(entry.index, 1);
      writeAtomic(file, lines.join(newline), root);
      return { ok: true, reference_id: plan.reference_id };
    },
    async verify(plan) {
      const name = planEnvName(plan);
      const current = readStore(file, root);
      if (current.entries.some((candidate) => candidate.key === name)) {
        return { ok: false, absent: false, reference_id: plan.reference_id };
      }
      return { ok: true, absent: true, reference_id: plan.reference_id };
    },
  };
}
