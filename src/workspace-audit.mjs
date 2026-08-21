// Read-only workspace auditing for the auditable-delivery flow. Captures a
// before/after snapshot of a git working tree (status / stat / name-status)
// plus a bounded, redacted patch, so an orchestrator can review exactly what a
// worker changed before accepting the result.
//
// Discipline: strictly read-only. Only git porcelain reads are issued — never
// reset / stash / clean / checkout, and nothing here writes to disk. A
// non-git directory degrades to { kind: 'no-git' } instead of failing, and a
// pre-dirty workspace is flagged (dirtyBaseline) rather than hidden.
//
// The default `git` runner is replaceable with an injected runner in tests:
// it receives (argsArray, { cwd }) and resolves { code, stdout, stderr }.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DIFF_LIMIT = 64 * 1024;
export const NOT_A_GIT_REPOSITORY = 'NOT_A_GIT_REPOSITORY';
export const GIT_NOT_FOUND = 'GIT_NOT_FOUND';
export const GIT_TIMEOUT = 'GIT_TIMEOUT';
export const GIT_TIMEOUT_MS = 8000;

const SENSITIVE_SUFFIXES = ['.pem', '.key'];
const SENSITIVE_PREFIXES = ['credentials', 'secret'];
const ENV_BASENAME = '.env';

/**
 * True when a path looks like a credential/secret file whose patch content
 * must be redacted: .env / .env.*, credentials*, secrets*, *.pem, *.key.
 * The file's name-status entry stays visible — only the patch is hidden.
 */
export function isSensitivePath(relPath) {
  const segments = String(relPath ?? '').replace(/\\/g, '/').split('/');
  return segments.some((raw) => {
    const seg = raw.toLowerCase();
    if (seg === ENV_BASENAME || seg.startsWith(`${ENV_BASENAME}.`)) return true;
    if (SENSITIVE_PREFIXES.some((p) => seg.startsWith(p))) return true;
    return SENSITIVE_SUFFIXES.some((s) => seg.endsWith(s));
  });
}

let resolvedGitExecutable = 'git';

export async function resolveWindowsGit({ exec = execFileAsync, env = process.env, exists = existsSync } = {}) {
  try {
    const located = await exec('where.exe', ['git'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    const first = String(located.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) return first;
  } catch {}
  // Always compose candidate paths with Windows semantics. This helper is
  // unit-tested on non-Windows hosts too, and host-native path.join() would
  // otherwise turn C:\\... inputs into mixed/invalid paths on POSIX.
  const candidates = [
    env.ProgramFiles && win32.join(env.ProgramFiles, 'Git', 'cmd', 'git.exe'),
    env.ProgramFiles && win32.join(env.ProgramFiles, 'Git', 'bin', 'git.exe'),
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => exists(candidate));
}

async function defaultRunner(args, { cwd }) {
  let out;
  try {
    out = await execFileAsync(resolvedGitExecutable, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
  } catch (error) {
    const missing = error?.code === 'ENOENT' || /spawn git ENOENT/i.test(error?.message ?? '');
    if (!missing || process.platform !== 'win32' || resolvedGitExecutable !== 'git') throw error;
    const fallback = await resolveWindowsGit();
    if (!fallback) throw error;
    resolvedGitExecutable = fallback;
    out = await execFileAsync(resolvedGitExecutable, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_TIMEOUT_MS });
  }
  return { code: 0, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
}

/** Run one git read; normalize failure into a no-git reason, never throws. */
async function runGit(runner, args, opts) {
  try {
    const r = await runner(args, opts);
    const stderr = r.stderr ?? '';
    if (/not a git repository/i.test(stderr)) {
      return { ok: false, reason: NOT_A_GIT_REPOSITORY, error: stderr.trim() };
    }
    return { ok: true, code: r.code ?? 0, stdout: r.stdout ?? '', stderr };
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (err?.code === 'ETIMEDOUT' || err?.killed === true || /timed out|timeout/i.test(msg)) return { ok: false, reason: GIT_TIMEOUT, error: 'git audit timed out' };
    if (/ENOENT|spawn git/i.test(msg)) return { ok: false, reason: GIT_NOT_FOUND, error: msg };
    return { ok: false, reason: NOT_A_GIT_REPOSITORY, error: msg };
  }
}

function splitFirstTab(line) {
  const i = line.indexOf('\t');
  return i === -1 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)];
}

/**
 * Parse `git diff --name-status` + `git status --porcelain` into structured
 * change lists used by the patch builder. Renames/copies fold onto their
 * destination path (the diff shows them there); untracked `??` rows are listed
 * separately because git does not diff them read-only.
 */
export function parseChanges(nameStatus, statusPorcelain) {
  const modified = [];
  const deleted = [];
  const renamed = [];
  for (const line of String(nameStatus ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [code, rest] = splitFirstTab(trimmed);
    const paths = rest.split('\t').filter(Boolean);
    if (paths.length === 0) continue;
    const x = code[0] ?? '';
    const y = code[1] ?? '';
    if (y === 'D' || x === 'D') { deleted.push(paths[paths.length - 1]); continue; }
    if (x === 'R' || x === 'C') { renamed.push(paths[0]); modified.push(paths[paths.length - 1]); continue; }
    modified.push(paths[paths.length - 1]);
  }
  const untracked = String(statusPorcelain ?? '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
  return {
    modified: [...new Set(modified)],
    deleted: [...new Set(deleted)],
    renamed: [...new Set(renamed)],
    untracked: [...new Set(untracked)],
  };
}

/**
 * Read-only pre-run snapshot of a workspace. Returns a git snapshot
 * { kind:'git', status, nameStatus, stat, dirty, changes } or a degraded
 * { kind:'no-git', reason, error } for non-repos / missing git. Never throws.
 */
export async function captureWorkspaceBaseline({ cwd, git } = {}) {
  const runner = git ?? defaultRunner;
  if (!cwd) return { kind: 'no-git', reason: NOT_A_GIT_REPOSITORY, error: 'workspace cwd is required' };
  const [status, nameStatus, stat] = await Promise.all([
    runGit(runner, ['status', '--porcelain'], { cwd }),
    runGit(runner, ['diff', '--name-status'], { cwd }),
    runGit(runner, ['diff', '--stat'], { cwd }),
  ]);
  for (const r of [status, nameStatus, stat]) {
    if (!r.ok) return { kind: 'no-git', reason: r.reason, error: r.error };
  }
  const changes = parseChanges(nameStatus.stdout, status.stdout);
  return {
    kind: 'git',
    status: status.stdout,
    nameStatus: nameStatus.stdout,
    stat: stat.stdout,
    dirty: changes.modified.length + changes.deleted.length + changes.renamed.length + changes.untracked.length > 0,
    changes,
  };
}

/** Build the bounded, redacted patch for the changed (tracked) paths. */
async function buildPatch(runner, { cwd, changes, limit }) {
  const { modified, deleted, untracked } = changes;
  const nonSensitive = [...new Set([...modified, ...deleted])].filter((p) => !isSensitivePath(p));
  const sensitive = [...new Set([...modified, ...deleted])].filter((p) => isSensitivePath(p));
  const redacted = [];
  let patch = '';
  if (nonSensitive.length > 0) {
    const r = await runGit(runner, ['diff', '--binary', '--', ...nonSensitive], { cwd });
    if (!r.ok) return { failed: true, reason: r.reason, error: r.error };
    patch += r.stdout;
  }
  for (const p of sensitive) {
    redacted.push(p);
    patch += `diff --git a/${p} b/${p}\n[REDACTED SENSITIVE FILE]\n`;
  }
  for (const p of untracked) {
    if (isSensitivePath(p)) {
      redacted.push(p);
      patch += `[REDACTED SENSITIVE FILE: ${p} (untracked)]\n`;
    } else {
      patch += `[UNTRACKED FILE: ${p} (content not diffed read-only)]\n`;
    }
  }
  let truncated = false;
  if (Buffer.byteLength(patch, 'utf8') > limit) {
    patch = Buffer.from(patch, 'utf8').subarray(0, limit).toString('utf8');
    truncated = true;
  }
  return { failed: false, patch, truncated, redacted };
}

/**
 * Read-only post-run snapshot: the after-state (status / stat / name-status)
 * plus the bounded, redacted patch of everything the worker changed.
 * `dirtyBaseline` records whether the workspace was already dirty before the
 * worker started (the diff may then include pre-existing changes). Never
 * throws; degrades to { kind:'no-git' } like captureWorkspaceBaseline.
 */
export async function captureWorkspaceDiff({ cwd, baseline, git, limit = DIFF_LIMIT } = {}) {
  const runner = git ?? defaultRunner;
  if (!cwd) return { kind: 'no-git', reason: NOT_A_GIT_REPOSITORY, error: 'workspace cwd is required' };
  if (!baseline || baseline.kind !== 'git') {
    return { kind: 'no-git', reason: baseline?.reason ?? NOT_A_GIT_REPOSITORY, error: baseline?.error };
  }
  const [status, nameStatus, stat] = await Promise.all([
    runGit(runner, ['status', '--porcelain'], { cwd }),
    runGit(runner, ['diff', '--name-status'], { cwd }),
    runGit(runner, ['diff', '--stat'], { cwd }),
  ]);
  for (const r of [status, nameStatus, stat]) {
    if (!r.ok) return { kind: 'no-git', reason: r.reason, error: r.error };
  }
  const changes = parseChanges(nameStatus.stdout, status.stdout);
  const patch = await buildPatch(runner, { cwd, changes, limit });
  if (patch.failed) return { kind: 'no-git', reason: patch.reason, error: patch.error };
  return {
    kind: 'git',
    status: status.stdout,
    nameStatus: nameStatus.stdout,
    stat: stat.stdout,
    patch: patch.patch,
    truncated: patch.truncated,
    redacted: patch.redacted,
    dirtyBaseline: baseline.dirty === true,
    changes,
  };
}
