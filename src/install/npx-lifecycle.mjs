// Packaged global-launcher lifecycle: install / status / update / uninstall.
//
// Public UX:
//   npm install -g @ran-sh/dsh-crew@latest
//   dsh-crew install|status|update|uninstall
//
// A package-manager launcher may run from a replaceable global/cache path.
// This module therefore persists the already-built package payload into
// Crew-owned state BEFORE registering it with the Harness profile, so the
// registration never depends on the cache, tarball, or temp extraction dir:
//
//   <home>/.config/dsh-crew/app/current.json        active-release pointer
//   <home>/.config/dsh-crew/app/releases/<stamp>/   durable installed payloads
//
// Everything else (config.json, credentials, backups, the isolated Harness
// home) is never touched by install/update; uninstall removes only the
// Crew-managed payload above plus registrations/integrations, and keeps the
// normal Crew config unless --purge is explicitly requested.
//
// Source checkouts keep using scripts/setup.mjs; this module is for the
// packaged npm payload and never requires pnpm lockfiles, devDependencies,
// or a client rebuild.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  copyFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import * as realInstaller from './install.mjs';
import { crewDshHome, crewProfileDir } from './install.mjs';
import { ensureCrewDshRuntime, ensureCrewPluginRegistration, removeCrewPluginRegistration, migrateCrewDshRuntime, TARGET_DSH_VERSION } from '../dsh-cli-runtime.mjs';
import { createCrewSidecarSupervisor } from '../official-web-bridge.mjs';
import {
  ensureOfficialWebIntegration,
  officialWebIntegrationStatus,
  removeOfficialWebIntegration,
} from './official-web.mjs';

export const CREW_APP_DIRNAME = 'app';
export const RELEASES_DIRNAME = 'releases';
export const CURRENT_POINTER_FILENAME = 'current.json';
export const KEEP_RELEASES = 2;
export const INCOMPLETE_MARKER = '.dsh-crew-incomplete';
const CREW_ROUTE_BASE = '/_dsh/dsh-crew';

export function npmCliInvocation(args, {
  platform = process.platform,
  environment = process.env,
} = {}) {
  if (platform !== 'win32') return { command: 'npm', args: [...args] };
  const unsafe = args.find((arg) => /[\0\r\n"%!^&|<>]/.test(String(arg)));
  if (unsafe !== undefined) throw new Error(`unsafe npm argument: ${unsafe}`);
  const commandLine = ['npm.cmd', ...args.map((arg) => `"${String(arg)}"`)].join(' ');
  return {
    command: environment.ComSpec || environment.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
    windowsVerbatimArguments: true,
  };
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function crewAppRoot({ home = homedir() } = {}) {
  return join(home, '.config', 'dsh-crew', CREW_APP_DIRNAME);
}

export function crewReleasesDir({ home = homedir() } = {}) {
  return join(crewAppRoot({ home }), RELEASES_DIRNAME);
}

export function currentPointerFile({ home = homedir() } = {}) {
  return join(crewAppRoot({ home }), CURRENT_POINTER_FILENAME);
}

/** Package root of the currently executing (candidate) instance. */
export function runningPackageRoot() {
  return PACKAGE_ROOT;
}

function readManifest(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function timestampStamp(now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
}

let releaseSalt = 0;
function uniqueReleaseName(version) {
  // Second-resolution timestamps can collide across rapid sequential runs in
  // the same process; a process-local counter keeps release names unique so
  // an update never reuses (and thus never clobbers) an existing release.
  releaseSalt += 1;
  return `${timestampStamp()}-${process.pid}-${releaseSalt.toString(36)}-${version}`;
}

function isoNow() {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())}T${pad(new Date().getHours())}:${pad(new Date().getMinutes())}:${pad(new Date().getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// ---- installed-payload pointer ----------------------------------------------

/**
 * Read the active installed-release pointer. Returns null when no valid
 * pointer exists. The pointed-at directory must still exist with a matching
 * manifest to count as installed.
 */
export function readCurrentPointer({ home = homedir() } = {}) {
  const state = readCurrentPointerState({ home });
  return state.status === 'valid' ? state.pointer : null;
}

// Tri-state pointer read: ABSENT (no file) / VALID / MALFORMED (present
// but unparseable or schema-invalid). Recovery must never merge ABSENT
// and MALFORMED: a corrupt pointer fails closed with the journal retained.
export function readCurrentPointerState({ home = homedir() } = {}) {
  const file = currentPointerFile({ home });
  if (!existsSync(file)) return { status: 'absent', file };
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch {
    return { status: 'malformed', file, code: 'POINTER_UNPARSEABLE' };
  }
  if (!raw || typeof raw !== 'object') return { status: 'malformed', file, code: 'POINTER_NOT_OBJECT' };
  if (typeof raw.name !== 'string' || raw.name.length === 0
    || typeof raw.version !== 'string' || raw.version.length === 0
    || typeof raw.path !== 'string' || raw.path.length === 0) {
    return { status: 'malformed', file, code: 'POINTER_FIELDS_INVALID' };
  }
  if (!isAbsolute(raw.path)) return { status: 'malformed', file, code: 'POINTER_PATH_NOT_ABSOLUTE' };
  return { status: 'valid', file, pointer: raw };
}

function validJournalRelease(value) {
  return !!value && typeof value === 'object'
    && typeof value.name === 'string' && value.name.length > 0
    && typeof value.version === 'string' && value.version.length > 0
    && typeof value.path === 'string' && isAbsolute(value.path);
}

function validJournalCandidate(value) {
  return !!value && typeof value === 'object'
    && typeof value.name === 'string' && value.name.length > 0
    && typeof value.version === 'string' && value.version.length > 0
    && typeof value.stageDir === 'string' && isAbsolute(value.stageDir);
}

function writeFileAtomic(file, content) {
  // Same-directory temp + rename: a crash can never leave a truncated
  // pointer or journal behind to be misread as valid state.
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content);
  try {
    renameSync(temp, file);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

function writeCurrentPointer({ home, name, version, path }) {
  const pointer = { name, version, path, installed_at: isoNow(), managed_by: 'npx' };
  writeFileAtomic(currentPointerFile({ home }), JSON.stringify(pointer, null, 2) + '\n');
  return pointer;
}

export const UPDATE_JOURNAL_FILENAME = 'update-journal.json';
export const UPDATE_LOCK_FILENAME = 'update-in-progress.lock';

export function updateJournalFile({ home = homedir() } = {}) {
  return join(crewAppRoot({ home }), UPDATE_JOURNAL_FILENAME);
}

export function updateLockFile({ home = homedir() } = {}) {
  return join(crewAppRoot({ home }), UPDATE_LOCK_FILENAME);
}

export function acquireUpdateLock({ home = homedir() } = {}) {
  const file = updateLockFile({ home });
  mkdirSync(dirname(file), { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const record = { pid: process.pid, started_at: isoNow(), nonce, hostname: process.env.COMPUTERNAME ?? null };
  try {
    writeFileSync(file, JSON.stringify(record) + '\n', { flag: 'wx' });
    return { ok: true, owner: true, nonce };
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      return { ok: false, code: 'UPDATE_LOCK_FAILED', error: String(error?.message ?? error) };
    }
    return tryReclaimUpdateLock({ home, record });
  }
}

function lockOwnerAlive(record) {
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process (dead owner, safe to reclaim).
    // EPERM = process exists but we cannot signal it (live owner, keep).
    return error?.code !== 'ESRCH';
  }
}

// Stale-lock reclaim with a single atomic claim: each contender writes its
// full claim into a UNIQUE temp dir, then renames that dir onto the fixed
// arbitration path. Rename-onto-existing is atomic on the same filesystem:
// exactly one contender wins; the loser gets EEXIST and backs off. No
// shared claim.json is ever overwritten, so two contenders can never both
// believe they own the reclaim. A crashed winner leaves a stale arbitration
// dir: a later contender quarantines the whole dir (atomic rename away)
// only after proving the recorded owner dead, then restarts contention
// from the top. The winner's finally removes the arbitration dir only when
// its claim nonce still matches (CAS), never unconditionally.
function tryReclaimUpdateLock({ home, record }) {
  const file = updateLockFile({ home });
  const arbitrationPath = `${file}.arbitration`;
  const myClaim = { pid: process.pid, nonce: record.nonce, started_at: isoNow() };
  for (let round = 0; round < 3; round += 1) {
    let current = null;
    try { current = JSON.parse(readFileSync(file, 'utf8')); } catch { current = null; }
    if (!current || typeof current !== 'object') {
      // Unparseable lock: fail closed, keep for operator inspection.
      return { ok: false, code: 'UPDATE_LOCK_CORRUPT' };
    }
    if (lockOwnerAlive(current)) {
      return { ok: false, code: 'UPDATE_IN_PROGRESS' };
    }
    // Single atomic claim: unique temp dir -> rename onto fixed path.
    const tmpDir = `${arbitrationPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    try {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(join(tmpDir, 'claim.json'), JSON.stringify(myClaim) + '\n', { flag: 'wx' });
    } catch (error) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      return { ok: false, code: 'UPDATE_LOCK_FAILED', error: String(error?.message ?? error) };
    }
    let claimed = false;
    try {
      renameSync(tmpDir, arbitrationPath);
      claimed = true;
    } catch (error) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'ENOTEMPTY') {
        return { ok: false, code: 'UPDATE_LOCK_FAILED', error: String(error?.message ?? error) };
      }
      // Arbitration path occupied: quarantine it only when its recorded
      // owner is provably dead; a live contender's claim is never touched.
      let guard = null;
      try { guard = JSON.parse(readFileSync(join(arbitrationPath, 'claim.json'), 'utf8')); } catch { guard = null; }
      if (!guard || typeof guard !== 'object' || lockOwnerAlive(guard)) {
        return { ok: false, code: 'UPDATE_IN_PROGRESS' };
      }
      const quarantine = `${arbitrationPath}.quarantine.${Date.now()}.${Math.random().toString(36).slice(2)}`;
      try {
        renameSync(arbitrationPath, quarantine);
        try { rmSync(quarantine, { recursive: true, force: true }); } catch {}
      } catch {
        return { ok: false, code: 'UPDATE_IN_PROGRESS' };
      }
      continue;
    }
    try {
      // Winner: re-verify the main lock is still the same dead record.
      let reread = null;
      try { reread = JSON.parse(readFileSync(file, 'utf8')); } catch { reread = null; }
      if (!reread || reread.nonce !== current.nonce || reread.pid !== current.pid) {
        return { ok: false, code: 'UPDATE_IN_PROGRESS' };
      }
      if (lockOwnerAlive(reread)) {
        return { ok: false, code: 'UPDATE_IN_PROGRESS' };
      }
      rmSync(file, { force: true });
      try {
        writeFileSync(file, JSON.stringify(record) + '\n', { flag: 'wx' });
        return { ok: true, owner: true, nonce: record.nonce, reclaimed: true };
      } catch (error) {
        if (error?.code === 'EEXIST') return { ok: false, code: 'UPDATE_IN_PROGRESS' };
        return { ok: false, code: 'UPDATE_LOCK_FAILED', error: String(error?.message ?? error) };
      }
    } finally {
      // CAS cleanup: remove the arbitration dir only when its claim is
      // still ours; never delete another contender's claim.
      try {
        const mine = JSON.parse(readFileSync(join(arbitrationPath, 'claim.json'), 'utf8'));
        if (mine?.nonce === myClaim.nonce && mine?.pid === process.pid) {
          rmSync(arbitrationPath, { recursive: true, force: true });
        }
      } catch {}
    }
  }
  return { ok: false, code: 'UPDATE_IN_PROGRESS' };
}

export function releaseUpdateLock({ home = homedir(), nonce = null } = {}) {
  // Nonce-checked release: a stale owner finalizer must never delete a
  // replacement owner's lock. Without an expected nonce this is best-effort
  // legacy behavior; with one it fails closed on mismatch.
  if (nonce !== null && nonce !== undefined) {
    let current = null;
    try { current = JSON.parse(readFileSync(updateLockFile({ home }), 'utf8')); } catch { current = null; }
    if (!current || current.nonce !== nonce) {
      return { ok: false, code: 'NOT_OWNER' };
    }
  }
  try { rmSync(updateLockFile({ home }), { force: true }); } catch {}
  return { ok: true };
}

function readUpdateJournal({ home = homedir() } = {}) {
  const file = updateJournalFile({ home });
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // A truncated journal is a crash artifact, NOT absence: fail closed and
    // keep the file so an operator can inspect it instead of silently
    // treating an interrupted transaction as clean.
    return { malformed: true, file };
  }
  if (!raw || typeof raw !== 'object' || typeof raw.stage !== 'string') {
    return { malformed: true, file };
  }
  // Full schema check: a semantically broken journal (null candidate,
  // incomplete prior) must fail closed, never enter recovery.
  if (!validJournalCandidate(raw.candidate)) {
    return { malformed: true, file, code: 'JOURNAL_CANDIDATE_SCHEMA_INVALID' };
  }
  if (raw.prior !== null && raw.prior !== undefined && !validJournalRelease(raw.prior)) {
    return { malformed: true, file, code: 'JOURNAL_PRIOR_SCHEMA_INVALID' };
  }
  return raw;
}

function writeUpdateJournal({ home, stage, prior = null, candidate = null }) {
  const record = { stage, prior, candidate, updated_at: isoNow() };
  writeFileAtomic(updateJournalFile({ home }), JSON.stringify(record, null, 2) + '\n');
  return record;
}

function clearUpdateJournal({ home = homedir() } = {}) {
  try { rmSync(updateJournalFile({ home }), { force: true }); } catch {}
}

// Synchronous profile-registration compensation for crash recovery:
// re-point the dedicated Crew profile at the prior release. Host
// integrations (Codex/ZCode/startup/Claude) are repaired by the next
// successful install/update activation; the profile link is the surface
// that must never dangle at a deleted candidate.
function compensateActivationSync({ home, prior, manifest, log, installer }) {
  if (!prior?.path || !existsSync(prior.path)) return { ok: false, code: 'PRIOR_RELEASE_MISSING' };
  if (!manifest?.name) return { ok: false, code: 'PRIOR_MANIFEST_INVALID' };
  const registration = ensureCrewPluginRegistration({ home, root: prior.path, name: manifest.name });
  if (!registration.ok) return { ok: false, code: registration.code ?? 'PRIOR_REGISTRATION_FAILED' };
  return { ok: true, version: manifest.version, path: prior.path };
}

// Undo a first-install candidate's activation surfaces: remove its profile
// registration (dependency + bundle + junction) ONLY when each surface
// still references THIS journal's candidate. The dependency must resolve
// to exactly link:<candidateRealPath> (normalized slashes); a later
// legitimate registration pointing elsewhere is never removed. Mixed or
// unjudgeable state fails closed with the journal retained. When the
// profile manifest is missing/unreadable the junction is still handled
// independently so a "junction created, manifest never written" crash
// cannot leave a dangling junction.
function undoCandidateActivationSync({ home, candidateDir, candidateName }) {
  if (!candidateDir || !candidateName) return { ok: true, undone: false };
  const profileRoot = crewProfileDir({ home });
  const profileFile = join(profileRoot, 'package.json');
  let manifest = null;
  let manifestReadable = true;
  try { manifest = JSON.parse(readFileSync(profileFile, 'utf8')); } catch { manifest = null; manifestReadable = false; }
  const linkPath = join(profileRoot, 'node_modules', ...candidateName.split('/'));
  let linked = null;
  try {
    if (lstatSync(linkPath).isSymbolicLink()) linked = realpathSync(linkPath);
  } catch { linked = null; }
  let candidateReal = null;
  try { candidateReal = realpathSync(candidateDir); } catch { candidateReal = candidateDir; }
  const expectedDep = `link:${String(candidateReal).replace(/\\/g, '/')}`;
  const rawDep = manifest?.dependencies?.[candidateName];
  const depPointsAtCandidate = typeof rawDep === 'string'
    && rawDep.replace(/\\/g, '/') === expectedDep;
  const bundleNamesCandidate = Array.isArray(manifest?.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes(candidateName);
  const linkPointsAtCandidate = linked !== null && linked === candidateReal;
  // Bundle carries no path: it NEVER grants deletion authority by itself.
  // It is removed only when dependency or junction proves THIS journal's
  // candidate still owns the registration. A re-pointed dep/junction with
  // a leftover same-name bundle fails closed (journal retained).
  const identityEvidence = depPointsAtCandidate || linkPointsAtCandidate;
  const bundlePointsAtCandidate = bundleNamesCandidate && identityEvidence;
  // Manifest unreadable but junction dangles at candidate: remove junction.
  if (!manifestReadable) {
    if (!linkPointsAtCandidate) return { ok: true, undone: false };
    try { rmSync(linkPath, { force: true }); } catch (error) {
      return { ok: false, code: 'CANDIDATE_UNDO_FAILED', error: String(error?.message ?? error) };
    }
    return { ok: true, undone: true };
  }
  if (!manifest) return { ok: true, undone: false };
  // Same-name package re-pointed elsewhere (dep or junction references a
  // different target) while the bundle still names it: mixed state that
  // cannot prove THIS candidate owns the registration. Fail closed,
  // retain the journal for operator inspection.
  const depPointsElsewhere = typeof rawDep === 'string' && !depPointsAtCandidate;
  const linkPointsElsewhere = linked !== null && !linkPointsAtCandidate;
  if ((depPointsElsewhere || linkPointsElsewhere) && bundleNamesCandidate) {
    return { ok: false, code: 'CANDIDATE_UNDO_AMBIGUOUS', error: 'same-name package re-pointed elsewhere; refusing bundle removal' };
  }
  if (!depPointsAtCandidate && !bundlePointsAtCandidate && !linkPointsAtCandidate) {
    return { ok: true, undone: false };
  }
  // Partial registration: only undo the surfaces that reference THIS
  // candidate; leave anything already re-pointed elsewhere untouched.
  try {
    const next = { ...manifest };
    if (depPointsAtCandidate) {
      next.dependencies = { ...manifest.dependencies };
      delete next.dependencies[candidateName];
      if (Object.keys(next.dependencies).length === 0) delete next.dependencies;
    }
    if (bundlePointsAtCandidate) {
      next.dsh = { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: manifest.dsh.profile.bundles.filter((b) => b !== candidateName) } };
    }
    writeFileAtomic(profileFile, JSON.stringify(next, null, 2) + '\n');
    if (linkPointsAtCandidate) rmSync(linkPath, { force: true });
  } catch (error) {
    return { ok: false, code: 'CANDIDATE_UNDO_FAILED', error: String(error?.message ?? error) };
  }
  return { ok: true, undone: true };
}

// Reconcile a leftover journal from a crashed update/install. The single
// commit point is the pointer write: pointer == candidate means committed
// (finalize, do NOT roll back); pointer == prior/absent means pre-commit
// (restore activation surfaces, drop candidate). A malformed journal fails
// closed and is retained for operator inspection.
export function reconcileUpdateJournal({ home = homedir(), log = () => {}, installer = realInstaller } = {}) {
  const journal = readUpdateJournal({ home });
  if (!journal) return { ok: true, reconciled: false };
  if (journal.malformed) {
    return { ok: false, code: journal.code ?? 'JOURNAL_MALFORMED', file: journal.file };
  }
  // Tri-state pointer: a corrupt pointer is NOT absence. Recovery with a
  // malformed pointer fails closed with the journal retained.
  const pointerState = readCurrentPointerState({ home });
  if (pointerState.status === 'malformed') {
    return { ok: false, code: 'POINTER_MALFORMED', file: pointerState.file, error: pointerState.code ?? 'pointer unreadable; refusing recovery' };
  }
  const pointer = pointerState.status === 'valid' ? pointerState.pointer : null;
  const candidateDir = journal.candidate?.stageDir ?? null;
  const candidateManifest = candidateDir && existsSync(candidateDir) ? readManifest(candidateDir) : null;

  // Committed side: pointer must match the FULL journal candidate identity
  // (name + version + path), and the candidate manifest is verified against
  // the JOURNAL candidate name/version (not its own). Anything else is not
  // a commit: fall through to the diverged check below.
  const candidateIdent = journal.candidate ?? null;
  const pointerMatchesCandidate = candidateDir !== null
    && pointer?.path === candidateDir
    && typeof pointer?.name === 'string' && pointer.name.length > 0
    && typeof pointer?.version === 'string' && pointer.version.length > 0
    && pointer.name === candidateIdent?.name
    && pointer.version === candidateIdent?.version;
  if (candidateDir && pointer?.path === candidateDir && !pointerMatchesCandidate) {
    return { ok: false, code: 'JOURNAL_POINTER_DIVERGED', stage: journal.stage, error: 'pointer path matches candidate but name/version do not; refusing recovery' };
  }
  if (pointerMatchesCandidate) {
    if (!candidateManifest?.name || !candidateManifest?.version) {
      return { ok: false, code: 'JOURNAL_CANDIDATE_INVALID', stage: journal.stage };
    }
    const validated = validateInstalledPayload(candidateDir, { expectedName: candidateIdent.name, expectedVersion: candidateIdent.version });
    if (!validated.ok) {
      return { ok: false, code: 'JOURNAL_CANDIDATE_INVALID', stage: journal.stage, error: (validated.errors ?? []).join('; ') };
    }
    clearUpdateJournal({ home });
    gcOldReleases({ home, protect: journal.prior?.path ?? null });
    log(`- recovered update journal at stage ${journal.stage}: candidate ${candidateIdent.version} already committed, finalized`);
    return { ok: true, reconciled: true, stage: journal.stage, committed: true };
  }

  // Diverged side: pointer references neither candidate nor prior. No
  // authority to decide which release should win: fail closed, touch
  // nothing (no registration change, no release delete, no journal clear).
  const priorPath = journal.prior?.path ?? null;
  const priorMatches = priorPath !== null
    && pointer?.path === priorPath
    && pointer?.name === journal.prior?.name
    && pointer?.version === journal.prior?.version;
  const isAbsent = !pointer;
  if (!priorMatches && !isAbsent) {
    return { ok: false, code: 'JOURNAL_POINTER_DIVERGED', stage: journal.stage, error: `pointer references unexpected release ${pointer?.path ?? 'unknown'}; refusing recovery` };
  }

  // Pre-commit side: prior stays authoritative. Re-point live activation
  // surfaces back at prior (a crash between activation and pointer write
  // leaves them on the candidate), then drop the candidate.
  if (priorPath) {
    if (!existsSync(journal.prior.path)) {
      return { ok: false, code: 'JOURNAL_PRIOR_MISSING', stage: journal.stage, error: 'prior release disappeared; refusing silent recovery' };
    }
    const priorManifest = readManifest(journal.prior.path);
    const compensated = compensateActivationSync({ home, prior: journal.prior, manifest: priorManifest, log, installer });
    if (!compensated.ok) {
      return { ok: false, code: 'JOURNAL_COMPENSATE_FAILED', stage: journal.stage, error: compensated.error ?? compensated.code };
    }
    if (candidateDir && existsSync(candidateDir)) {
      try { rmSync(candidateDir, { recursive: true, force: true }); } catch {}
    }
    clearUpdateJournal({ home });
    log(`- recovered update journal at stage ${journal.stage}: restored prior release ${journal.prior.version}`);
    return { ok: true, reconciled: true, stage: journal.stage, committed: false };
  }

  // First-install pre-commit: no prior exists. Undo the candidate's
  // activation surfaces FIRST (a crash between activation and pointer
  // write leaves the profile link on the candidate), then remove the
  // orphan candidate pointer + dir. Journal clears only after successful
  // compensation.
  const undone = undoCandidateActivationSync({ home, candidateDir, candidateName: journal.candidate?.name ?? null });
  if (!undone.ok) {
    return { ok: false, code: 'JOURNAL_UNDO_FAILED', stage: journal.stage, error: undone.error ?? undone.code };
  }
  if (candidateDir && existsSync(candidateDir)) {
    try { rmSync(candidateDir, { recursive: true, force: true }); } catch {}
  }
  if (pointer && candidateDir && pointer.path === candidateDir) {
    try { rmSync(currentPointerFile({ home }), { force: true }); } catch {}
  }
  clearUpdateJournal({ home });
  log(`- recovered first-install journal at stage ${journal.stage}: removed orphan candidate`);
  return { ok: true, reconciled: true, stage: journal.stage, committed: false };
}

// ---- dependency tree materialization ----------------------------------------

function listPackageEdges(manifest) {
  // Returns [{name, optional}] covering dependencies and
  // required peerDependencies. Packages in the DSH cohort use peers for
  // shared protocol/runtime modules, but a persisted Crew payload has no host
  // node_modules to supply them, so their transitive peers are runtime edges.
  // Platform-specific optional bits and optional peers stay non-fatal.
  const edges = [];
  for (const [name] of Object.entries(manifest?.dependencies ?? {})) {
    edges.push({ name, optional: false });
  }
  for (const [name] of Object.entries(manifest?.optionalDependencies ?? {})) {
    if (!edges.some((edge) => edge.name === name)) edges.push({ name, optional: true });
  }
  for (const [name] of Object.entries(manifest?.peerDependencies ?? {})) {
    if (edges.some((edge) => edge.name === name)) continue;
    edges.push({ name, optional: manifest?.peerDependenciesMeta?.[name]?.optional === true });
  }
  return edges.filter((edge) => typeof edge.name === 'string' && edge.name.trim());
}

function findPackageDir(fromRoot, name, exists = existsSync) {
  // Node-style upward resolution: for each ancestor directory of fromRoot,
  // probe <ancestor>/node_modules/<name>. Covers npm's hoisted npx cache and
  // pnpm's virtual store (once a package is realpathed into .pnpm/<pkg>/
  // node_modules, walking up finds its exact sibling closure).
  const parts = name.split('/');
  const seen = new Set();
  let cursor = fromRoot;
  while (true) {
    const candidate = join(cursor, 'node_modules', ...parts);
    if (exists(candidate)) {
      try {
        const real = realpathSync(candidate);
        if (!seen.has(real)) { seen.add(real); return real; }
      } catch { /* skip unreadable entry */ }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/**
 * Copy the dependency closure of `names` out of the running instance's
 * dependency tree into `<toRoot>/node_modules`. Offline-safe: it replicates
 * exactly the dependency bits the candidate just executed with. Optional
 * edges (e.g. cross-platform native binaries) are copied when present but
 * reported separately when absent, so npm can reconcile them per-platform.
 * Returns { copied: Map<name, realSource>, missing: string[], missingOptional: string[] }.
 */
export function copyProductionDependencyTree({
  fromRoot,
  toRoot,
  names,
  exists = existsSync,
  copyDir = (src, dest) => cpSync(src, dest, { recursive: true, force: true, dereference: true }),
} = {}) {
  const toNodeModules = join(toRoot, 'node_modules');
  mkdirSync(toNodeModules, { recursive: true });
  const copied = new Map();
  const missing = [];
  const missingOptional = [];
  const queue = names.map((entry) => (typeof entry === 'string'
    ? { name: entry, fromRoot, optional: false }
    : { ...entry, fromRoot }));
  while (queue.length > 0) {
    const { name, fromRoot: searchRoot, optional } = queue.shift();
    if (copied.has(name) || missing.includes(name) || missingOptional.includes(name)) continue;
    const source = findPackageDir(searchRoot ?? fromRoot, name, exists);
    if (!source) {
      if (optional) missingOptional.push(name);
      else missing.push(name);
      continue;
    }
    const dest = join(toNodeModules, ...name.split('/'));
    copyDir(source, dest);
    copied.set(name, source);
    const depManifest = readManifest(source);
    for (const edge of listPackageEdges(depManifest)) {
      if (!copied.has(edge.name) && !missing.includes(edge.name) && !missingOptional.includes(edge.name)) {
        // Resolve children relative to the copied package's own physical
        // location so nested/virtual-store layouts resolve correctly.
        queue.push({ name: edge.name, fromRoot: dirname(source), optional: edge.optional || optional });
      }
    }
  }
  return { copied, missing, missingOptional };
}

function defaultNpmInstaller(stageRoot, log) {
  const npmArgs = [
    'install', '--prefix', stageRoot,
    '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    '--no-package-lock', '--loglevel=error',
  ];
  const invocation = npmCliInvocation(npmArgs);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000,
    windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    env: sanitizedPackageManagerEnv(),
  });
  if (result.status !== 0) {
    log(`- npm fallback install failed (${result.status}): ${(result.stderr || result.stdout || '').trim().slice(-300)}`);
    return false;
  }
  return true;
}

// ---- payload staging ---------------------------------------------------------

/**
 * Stage the candidate into its FINAL release directory, guarded by an
 * incompleteness marker. Committing = removing the marker (a single-file
 * operation that is reliable on all platforms); activation = writing the
 * pointer last. This avoids directory renames, which Windows can refuse with
 * transient EPERM while a freshly written tree is being scanned.
 *
 * The persisted manifest merges the exact-pinned DSH peer cohort into
 * `dependencies` (peer declarations are dropped): the installed payload runs
 * standalone — `src/server.mjs` statically imports DSH peers — so those
 * packages must exist inside the release, not be assumed from a host.
 */
export function stageCandidatePayload({
  sourceRoot = runningPackageRoot(),
  home = homedir(),
  log = () => {},
  now = new Date(),
  npmInstaller = defaultNpmInstaller,
  copyTree = copyProductionDependencyTree,
  smoke = defaultPayloadSmoke,
} = {}) {
  const manifest = readManifest(sourceRoot);
  if (!manifest?.name || !manifest?.version) return { ok: false, code: 'CANDIDATE_MANIFEST_INVALID' };
  if (!existsSync(join(sourceRoot, 'src', 'server.mjs')) || !existsSync(join(sourceRoot, 'cordis.patch.yml'))) {
    return { ok: false, code: 'CANDIDATE_NOT_RUNNABLE' };
  }

  const releasesDir = crewReleasesDir({ home });
  mkdirSync(releasesDir, { recursive: true });
  const stageDir = join(releasesDir, uniqueReleaseName(manifest.version));
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, INCOMPLETE_MARKER), String(Date.now()) + '\n');

  // Copy every top-level entry referenced by manifest.files (directories are
  // copied whole; single-segment wildcards match within their directory).
  const entries = new Set(['package.json']);
  for (const pattern of manifest.files ?? []) {
    if (typeof pattern !== 'string' || !pattern.trim()) continue;
    if (!pattern.includes('*')) { entries.add(pattern); continue; }
    const base = dirname(pattern);
    const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    const scanDir = join(sourceRoot, base);
    if (!existsSync(scanDir)) continue;
    for (const item of readdirSync(scanDir)) {
      const candidatePath = base === '.' ? item : `${base.replace(/\\/g, '/')}/${item}`;
      if (regex.test(candidatePath)) entries.add(candidatePath);
    }
  }

  for (const entry of entries) {
    const source = join(sourceRoot, entry);
    if (!existsSync(source)) continue;
    cpSync(source, join(stageDir, entry), { recursive: true, force: true, dereference: true });
  }

  // Persist an adjusted manifest: identity/runtime fields stay; production
  // dependencies gain the exact-pinned peer cohort so the payload runs
  // standalone (src/server.mjs statically imports DSH peers). Optional
  // dependencies keep their own section so npm reconciles them per-platform.
  const stagedManifest = { ...manifest };
  delete stagedManifest.devDependencies;
  delete stagedManifest.peerDependencies;
  delete stagedManifest.peerDependenciesMeta;
  const optionalNames = new Set(Object.keys(manifest.optionalDependencies ?? {}));
  stagedManifest.dependencies = {
    ...(manifest.peerDependencies ?? {}),
    ...(manifest.dependencies ?? {}),
  };
  writeFileSync(join(stageDir, 'package.json'), JSON.stringify(stagedManifest, null, 2) + '\n');

  // Materialize dependencies: prefer replicating the exact bits the candidate
  // ran with (offline-safe); fall back to npm for the rest (under npx this is
  // normally the exact-pinned DSH peer cohort).
  const depEdges = [
    ...Object.keys(stagedManifest.dependencies).map((name) => ({ name, optional: false })),
    ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
  ];
  const { missing, missingOptional } = copyTree({ fromRoot: sourceRoot, toRoot: stageDir, names: depEdges });
  if (missingOptional.length > 0) {
    log(`- platform-optional dependencies left to npm (${missingOptional.slice(0, 4).join(', ')}${missingOptional.length > 4 ? ', …' : ''})`);
  }
  if (missing.length > 0) {
    log(`- local dependency replication incomplete (${missing.join(', ')}); falling back to npm`);
    if (!npmInstaller(stageDir, log)) {
      rmSync(stageDir, { recursive: true, force: true });
      return { ok: false, code: 'DEPENDENCY_MATERIALIZE_FAILED', missing };
    }
  }

  const validated = validateInstalledPayload(stageDir, { expectedName: manifest.name, expectedVersion: manifest.version, allowIncomplete: true });
  if (!validated.ok) {
    rmSync(stageDir, { recursive: true, force: true });
    return { ok: false, code: 'STAGE_VALIDATION_FAILED', detail: validated.errors };
  }
  const smoked = smoke(stageDir);
  if (!smoked.ok) {
    rmSync(stageDir, { recursive: true, force: true });
    return { ok: false, code: 'STAGE_SMOKE_FAILED', detail: smoked.detail };
  }
  return { ok: true, stageDir, manifest, releasesDir };
}

/**
 * Boot-smoke a staged payload with the real Node binary: the CLI entry must
 * start and answer --help from inside the staged tree alone.
 */
export function defaultPayloadSmoke(dir, { nodePath = process.execPath, runner = spawnSync } = {}) {
  const cli = runner(nodePath, [join(dir, 'bin', 'dsh-crew.mjs'), '--help'], {
    encoding: 'utf8', timeout: 120_000, windowsHide: true,
    env: { ...process.env },
  });
  if (cli.status !== 0) {
    return { ok: false, detail: `bin --help exited ${cli.status}: ${(cli.stderr || cli.stdout || '').trim().slice(-300)}` };
  }

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-crew-payload-smoke', version: '1.0.0' },
    },
  };
  const mcp = runner(nodePath, [join(dir, 'src', 'server.mjs')], {
    encoding: 'utf8', timeout: 120_000, windowsHide: true,
    input: JSON.stringify(initialize) + '\n',
    env: { ...process.env },
  });
  if (mcp.status !== 0) {
    return { ok: false, detail: `MCP initialize exited ${mcp.status}: ${(mcp.stderr || mcp.stdout || '').trim().slice(-300)}` };
  }
  let response;
  try {
    response = String(mcp.stdout ?? '').split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line)).find((entry) => entry?.id === initialize.id);
  } catch { /* handled by the fail-closed response check below */ }
  if (response?.result?.serverInfo?.name !== 'dsh-crew') {
    return { ok: false, detail: `MCP initialize returned no valid dsh-crew response: ${String(mcp.stdout ?? '').trim().slice(-300)}` };
  }
  return { ok: true };
}

// Keyword boundaries reject identifiers containing the keywords
// ('legacy-import') and member calls (.from); captures stay on one line and
// bounded — real specifiers never span lines.
const IMPORT_SPECIFIER_RE = /(?<![\w.\-])(?:from|import|require)\b\s*\(?\s*["']([^"'\n]{1,200})["']/g;

function collectExternalSpecifiers(dir) {
  const specifiers = new Set();
  const walk = (root) => {
    if (!existsSync(root)) return;
    for (const item of readdirSync(root, { withFileTypes: true })) {
      const full = join(root, item.name);
      if (item.isDirectory()) walk(full);
      else if (/\.(?:mjs|js)$/.test(item.name)) {
        let content = '';
        try { content = readFileSync(full, 'utf8'); } catch { continue; }
        for (const match of content.matchAll(IMPORT_SPECIFIER_RE)) {
          specifiers.add(match[1]);
        }
      }
    }
  };
  walk(join(dir, 'src'));
  walk(join(dir, 'bin'));
  return [...specifiers].filter((spec) =>
    !spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:') && !isAbsolute(spec));
}

/**
 * Prove a payload directory is runnable on its own: correct identity, all
 * shipped runtime artifacts present, every declared dependency vendored, and
 * every external module specifier the payload's source actually imports
 * resolvable FROM THE PERSISTED LOCATION (never from a cache or checkout).
 */
export function validateInstalledPayload(dir, { expectedName, expectedVersion, allowIncomplete = false } = {}) {
  const errors = [];
  const manifest = readManifest(dir);
  if (!manifest) errors.push('package.json missing or invalid');
  else {
    if (expectedName && manifest.name !== expectedName) errors.push(`package name mismatch (${manifest.name})`);
    if (expectedVersion && manifest.version !== expectedVersion) errors.push(`package version mismatch (${manifest.version})`);
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (!existsSync(join(dir, 'node_modules', ...dep.split('/'), 'package.json'))) {
        errors.push(`vendored dependency missing from payload: ${dep}`);
      }
    }
  }
  if (manifest) {
    const requireFromPayload = createRequire(join(dir, 'package.json'));
    for (const spec of collectExternalSpecifiers(dir)) {
      try {
        requireFromPayload.resolve(spec);
      } catch {
        errors.push(`import target not resolvable from payload: ${spec}`);
      }
    }
  }
  for (const rel of [
    'cordis.patch.yml', 'src/server.mjs', 'src/hub/entry.mjs', 'lib/client.js', 'bin/dsh-crew.mjs',
    'official-web-bridge/package.json', 'official-web-bridge/cordis.patch.yml',
    'official-web-bridge/entry.mjs', 'official-web-bridge/lib/client.js',
  ]) {
    if (!existsSync(join(dir, rel))) errors.push(`payload artifact missing: ${rel}`);
  }
  if (!allowIncomplete && existsSync(join(dir, INCOMPLETE_MARKER))) errors.push('release is still marked incomplete');
  return { ok: errors.length === 0, errors, manifest };
}

// ---- release commit / activation ---------------------------------------------
// Transactional commit: stage -> journal(activating) -> activation ->
// pointer write LAST -> clear journal -> GC (prior protected until commit).
// A crash at any point before the pointer write leaves the prior release
// authoritative and the journal behind for reconcileUpdateJournal.
export function beginReleaseActivation({ stageDir, manifest, home, prior = null }) {
  // Journal FIRST, marker removal second: a crash between the two leaves a
  // journaled (recoverable) candidate, never a marker-free orphan that
  // looks complete but was never in a transaction. Marker removal failure
  // aborts the transaction instead of proceeding with a half-marked stage.
  writeUpdateJournal({
    home,
    stage: 'activating',
    prior: prior ? { name: prior.name, version: prior.version, path: prior.path } : null,
    candidate: { name: manifest.name, version: manifest.version, stageDir },
  });
  try {
    rmSync(join(stageDir, INCOMPLETE_MARKER), { force: true });
  } catch (error) {
    throw Object.assign(new Error(`cannot clear stage marker: ${error?.message ?? error}`), { code: 'STAGE_MARKER_REMOVE_FAILED' });
  }
  if (existsSync(join(stageDir, INCOMPLETE_MARKER))) {
    throw Object.assign(new Error('stage marker still present after removal'), { code: 'STAGE_MARKER_REMOVE_FAILED' });
  }
  return stageDir;
}

export function commitActivatedRelease({ stageDir, manifest, home, prior = null }) {
  writeCurrentPointer({ home, name: manifest.name, version: manifest.version, path: stageDir });
  clearUpdateJournal({ home });
  gcOldReleases({ home, protect: prior?.path ?? null });
  return stageDir;
}

function commitStagedRelease({ stageDir, manifest, home, prior = null }) {
  return commitActivatedRelease({ stageDir, manifest, home, prior });
}

const STALE_INCOMPLETE_MS = 24 * 60 * 60 * 1000;

function gcOldReleases({ home, keep = KEEP_RELEASES, protect = null }) {
  const pointer = readCurrentPointer({ home });
  const releasesDir = crewReleasesDir({ home });
  if (!existsSync(releasesDir)) return;
  const removed = [];
  const dirs = readdirSync(releasesDir)
    .map((name) => join(releasesDir, name))
    .filter((dir) => (!pointer || dir !== pointer.path) && (!protect || dir !== protect));
  const incomplete = [];
  const complete = [];
  for (const dir of dirs) {
    if (existsSync(join(dir, INCOMPLETE_MARKER))) {
      // Never race a concurrent staging; only reap clearly abandoned ones.
      try {
        if (Date.now() - lstatSync(dir).mtimeMs > STALE_INCOMPLETE_MS) incomplete.push(dir);
      } catch { /* ignore */ }
      continue;
    }
    complete.push(dir);
  }
  complete.sort();
  while (complete.length > Math.max(0, keep - 1)) {
    const victim = complete.shift();
    try { rmSync(victim, { recursive: true, force: true }); removed.push(victim); } catch { /* best effort */ }
  }
  for (const victim of incomplete) {
    try { rmSync(victim, { recursive: true, force: true }); removed.push(victim); } catch { /* best effort */ }
  }
  return removed;
}

export function listManagedReleases({ home = homedir() } = {}) {
  const pointer = readCurrentPointer({ home });
  const root = crewReleasesDir({ home });
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(root, entry.name);
      const manifest = readManifest(path);
      if (!manifest?.name || !manifest?.version) return null;
      const validation = validateInstalledPayload(path, { expectedName: manifest.name, expectedVersion: manifest.version });
      return {
        name: manifest.name,
        version: manifest.version,
        path,
        current: pointer?.path === path,
        healthy: validation.ok,
      };
    })
    .filter(Boolean)
    .sort((a, b) => compareVersions(b.version, a.version) || b.path.localeCompare(a.path));
}

async function restartOwnedRuntime(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('http://127.0.0.1:3080/_dsh/dsh-crew/supervisor/restart', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  const body = await response.json();
  return response.ok && body?.ok === true ? body : { ok: false, code: body?.code ?? 'CREW_3210_RESTART_FAILED' };
}

async function verifyRuntimeVersion(version, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('http://127.0.0.1:3210/_dsh/dsh-crew/runtime', { headers: { accept: 'application/json' } });
  const body = await response.json();
  return response.ok && body?.ok === true && body.runtime_version === version
    ? { ok: true, runtime_version: body.runtime_version }
    : { ok: false, code: 'RUNTIME_VERSION_MISMATCH' };
}

// Full Crew-owned 3210 identity check: service + execution plane + profile
// + port + non-empty runtime_id, plus the exact target cohort version.
// Used by production cohort migration instead of a version-only probe.
export async function verifyCrewRuntimeIdentity(version, fetchImpl = globalThis.fetch) {
  let body = null;
  try {
    const response = await fetchImpl('http://127.0.0.1:3210/_dsh/dsh-crew/extension', { headers: { accept: 'application/json' } });
    body = await response.json();
    if (!response.ok) return { ok: false, code: 'RUNTIME_IDENTITY_UNREACHABLE' };
  } catch (error) {
    return { ok: false, code: 'RUNTIME_IDENTITY_UNREACHABLE', error: String(error?.message ?? error) };
  }
  const runtime = body?.extension?.runtime ?? null;
  const checks = [
    body?.ok === true,
    runtime?.service === 'dsh-crew-hub',
    runtime?.execution_plane === 'hub-3210',
    runtime?.profile === 'dsh-crew',
    Number(runtime?.listen_port) === 3210,
    typeof runtime?.runtime_id === 'string' && runtime.runtime_id.trim().length > 0,
  ];
  if (!checks.every(Boolean)) return { ok: false, code: 'RUNTIME_IDENTITY_MISMATCH' };
  const extVersion = body?.extension?.runtime?.runtime_version ?? null;
  void extVersion;
  const versioned = await verifyRuntimeVersion(version, fetchImpl);
  if (!versioned.ok) return versioned;
  return { ok: true, runtime_id: runtime.runtime_id, runtime_version: versioned.runtime_version };
}

// Crew-owned stop/start for cohort migration come from the sidecar
// supervisor (PID-identity verified, no legacy bridge). The supervisor
// module owns the 3210 child lifecycle; the installer only drives its
// stop-only / start-only primitives around the runtime-tree swap.
function crewSupervisor({ home = homedir() } = {}) {
  const dshHome = crewDshHome({ home });
  return createCrewSidecarSupervisor({ home, ownershipFile: join(dshHome, 'supervisor-ownership.json') });
}

export async function npxReleases({ home = homedir(), log = console.log } = {}) {
  const releases = listManagedReleases({ home });
  log(JSON.stringify(releases, null, 2));
  return { ok: true, releases };
}

export async function npxRollback({
  home = homedir(),
  version,
  log = console.log,
  installer = realInstaller,
  ensureRuntime,
  validatePayload = validateInstalledPayload,
  activate,
  restart = () => restartOwnedRuntime(),
  verifyRuntime = (targetVersion) => verifyRuntimeVersion(targetVersion),
} = {}) {
  const targetVersion = typeof version === 'string' ? version.trim() : '';
  if (!targetVersion) return { ok: false, error: 'rollback requires a target version' };
  const current = readCurrentPointer({ home });
  if (!current?.path || !existsSync(current.path)) return { ok: false, error: 'no active Crew payload to roll back' };
  const target = listManagedReleases({ home }).find((release) => release.version === targetVersion);
  if (!target) return { ok: false, error: `retained release ${targetVersion} was not found` };
  if (target.path === current.path) return { ok: true, idempotent: true, version: target.version, path: target.path };
  const targetManifest = readManifest(target.path);
  const validation = validatePayload(target.path, { expectedName: targetManifest?.name, expectedVersion: targetManifest?.version });
  if (!validation.ok) return { ok: false, error: 'target release failed payload validation' };
  const previousManifest = readManifest(current.path);
  const activateReleaseFn = activate ?? (({ releaseDir, manifest }) => activateRelease({ home, releaseDir, manifest, log, installer, ensureRuntime }));
  const switchPointer = (release) => writeCurrentPointer({ home, name: release.name, version: release.version, path: release.path });
  try {
    switchPointer(target);
    if (!await activateReleaseFn({ releaseDir: target.path, manifest: targetManifest })) throw new Error('target release activation failed');
    const restarted = await restart(target.version);
    if (restarted?.ok === false) throw Object.assign(new Error('target runtime restart failed'), { code: restarted.code });
    const runtime = await verifyRuntime(target.version);
    if (runtime?.ok !== true) throw Object.assign(new Error('target runtime verification failed'), { code: runtime?.code ?? 'RUNTIME_VERSION_MISMATCH' });
    log(`✓ rolled back Crew payload to ${target.version}`);
    return { ok: true, rolled_back: true, version: target.version, path: target.path, restart: restarted, runtime };
  } catch (error) {
    const prior = { name: current.name, version: current.version, path: current.path };
    let recovery;
    try {
      switchPointer(prior);
      if (!previousManifest) throw Object.assign(new Error('previous release manifest unavailable'), { stage: 'activation' });
      const activated = await activateReleaseFn({ releaseDir: prior.path, manifest: previousManifest });
      if (activated !== true) throw Object.assign(new Error('previous release activation failed'), { stage: 'activation' });
      const restarted = await restart(prior.version);
      if (restarted?.ok !== true) throw Object.assign(new Error('previous runtime restart failed'), { stage: 'restart' });
      const runtime = await verifyRuntime(prior.version);
      if (runtime?.ok !== true) throw Object.assign(new Error('previous runtime verification failed'), { stage: 'verification' });
      const restoredPointer = readCurrentPointer({ home });
      if (restoredPointer?.path !== prior.path || restoredPointer.version !== prior.version) {
        throw Object.assign(new Error('previous release pointer was not restored'), { stage: 'pointer' });
      }
      recovery = { ok: true, version: prior.version, path: prior.path };
    } catch (recoveryError) {
      recovery = {
        ok: false,
        code: 'RELEASE_ROLLBACK_RECOVERY_FAILED',
        stage: ['activation', 'restart', 'verification', 'pointer'].includes(recoveryError?.stage) ? recoveryError.stage : 'unknown',
      };
    }
    return {
      ok: false,
      error: error?.message ?? 'release rollback failed',
      code: error?.code ?? 'RELEASE_ROLLBACK_FAILED',
      restored: recovery.ok === true,
      recovery,
    };
  }
}

function registrationLinkPath({ home, name }) {
  return join(crewProfileDir({ home }), 'node_modules', ...name.split('/'));
}

function registrationHealthy({ home, name, releaseDir }) {
  const link = registrationLinkPath({ home, name });
  if (!existsSync(link)) return false;
  try { return realpathSync(link) === realpathSync(releaseDir); } catch { return false; }
}

/**
 * Environment for child package managers. Under `npm exec`/npx the process
 * inherits dozens of npm_config_* variables describing the transient exec
 * context; leaking them into pnpm/npm children can misdirect their stores and
 * config resolution. Package-manager children must see the user's real
 * environment, not our execution context.
 */
export function sanitizedPackageManagerEnv(baseEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (/^npm_(config_|lifecycle|package_|execpath$|node_execpath$)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

// Production migration adapter: builds the migrate callback used by the
// default ensureRuntimeStep path. Exactly ONE supervisor instance is
// created per migration and reused by stop/start/verify/rollback so the
// child identity stays coherent. Exported so tests can prove the
// production default wiring (single instance, full identity verify)
// instead of hand-injecting three mock callbacks.
export function buildProductionMigration({ home, log = () => {}, stopOwned, startOwned, verifyOwned, supervisorFactory = crewSupervisor } = {}) {
  const supervisor = supervisorFactory({ home });
  return (opts) => migrateCrewDshRuntime({
    home,
    version: TARGET_DSH_VERSION,
    stopOwned: stopOwned ?? (() => supervisor.stopOwnedBackend()),
    startOwned: startOwned ?? (() => supervisor.startOwnedBackend()),
    verifyOwned: verifyOwned ?? (() => verifyCrewRuntimeIdentity(TARGET_DSH_VERSION)),
    ...opts,
  });
}

async function ensureRuntimeStep({ home, log, ensureRuntime, migrateRuntime, stopOwned, startOwned, verifyOwned, supervisorFactory = crewSupervisor }) {  const ensure = ensureRuntime ?? ((opts) => {
    const r = ensureCrewDshRuntime({ ...opts, env: sanitizedPackageManagerEnv() });
    if (!r.ok && r.stderrTail) {
      log(`  (runtime installer said: ${r.stderrTail})`);
    }
    if (!r.ok && r.code === 'DSH_RUNTIME_COHORT_MISMATCH') {
      return { ok: false, code: r.code, error: r.error, installed: r.installed, target: r.target, needsMigration: true };
    }
    return r.ok ? { ok: true, version: r.cli?.version ?? null } : { ok: false, error: r.error ?? r.code ?? 'runtime bootstrap failed' };
  });
  // Production migration wiring: ONE supervisor instance per migration,
  // reused by stop/start/verify/rollback so child identity stays coherent.
  // No legacy bridge involved. Missing callbacks fail closed inside
  // migrateCrewDshRuntime.
  const migrate = migrateRuntime ?? buildProductionMigration({ home, log, stopOwned, startOwned, verifyOwned, supervisorFactory });
  const r = await ensure({ home });
  if (r?.ok) {
    log(`✓ reusable Crew DSH runtime${r.version ? ` (@${r.version})` : ''}`);
    return true;
  }
  if (r?.needsMigration === true) {
    log(`- runtime cohort stale (${r.installed} -> ${r.target}); migrating via staged transaction`);
    const m = await migrate({ log });
    if (!m?.ok) {
      log(`✗ runtime cohort migration failed: ${m?.error ?? m?.code ?? 'unknown error'}`);
      return false;
    }
    log(`✓ runtime cohort migrated (@${m.version})`);
    return true;
  }
  log(`✗ reusable Crew DSH runtime unavailable: ${r?.error ?? 'unknown error'}`);
  return false;
}

// ---- commands -----------------------------------------------------------------

function currentInstallationHealth({ home }) {
  const pointer = readCurrentPointer({ home });
  if (!pointer) return { installed: false, healthy: false };
  if (!existsSync(pointer.path)) return { installed: false, healthy: false, pointer };
  const validated = validateInstalledPayload(pointer.path, { expectedName: pointer.name, expectedVersion: pointer.version });
  const registered = registrationHealthy({ home, name: pointer.name, releaseDir: pointer.path });
  return { installed: true, healthy: validated.ok && registered, validated, registered, pointer };
}

async function activateRelease({ home, releaseDir, manifest, log, installer }) {
  const registration = ensureCrewPluginRegistration({ home, root: releaseDir, name: manifest.name });
  if (!registration.ok) {
    log(`✗ Harness registration failed (${registration.code ?? 'unknown'})`);
    return false;
  }
  log(`✓ Harness plugin registered (dedicated dsh-crew profile → ${releaseDir})`);

  const codex = installer.installCodex({ home, root: releaseDir });
  if (codex.ok === false) {
    log(`✗ Codex Desktop integration failed: ${(codex.actions ?? []).join('; ')}`);
    return false;
  }
  log('✓ Codex Desktop integration');

  if (installer.installZCode) {
    const zcode = installer.installZCode({ home, root: releaseDir });
    if (zcode.ok === false) {
      log(`✗ ZCode integration failed (${zcode.code ?? 'unknown'})`);
      return false;
    }
    log('✓ ZCode integration');
  }

  const startup = installer.installWindowsStartup?.({ home, root: releaseDir });
  if (startup?.ok === false) {
    log(`✗ Windows login startup failed (${startup.code ?? 'unknown'})`);
    return false;
  }
  if (startup?.supported) log('✓ Windows login startup');

  const claude = await installer.installClaudeCode({ home, root: releaseDir });
  if (claude.ok === false) {
    log(`✗ Claude Code integration failed`);
    return false;
  }
  log('✓ Claude Code integration');

  // The official ~/.dsh/profiles/web tree is read-only: activation never
  // repairs or mutates the official bridge. The isolated 3210 Crew backend
  // is the only runtime Crew owns.
  const official = officialWebIntegrationStatus({ home });
  if (official.enabled) {
    log('- official 3080 bridge left untouched (official web profile is read-only)');
  }
  return true;
}

// Compensate a failed candidate activation by re-pointing live activation
// surfaces (profile registration + host integrations) back at the prior
// release. Rewriting current.json alone is NOT enough: a crash between
// activation and pointer commit leaves live surfaces on the candidate.
async function compensateActivation({ home, prior, log, installer }) {
  if (!prior?.path || !existsSync(prior.path)) return { ok: false, code: 'PRIOR_RELEASE_MISSING' };
  const manifest = readManifest(prior.path);
  if (!manifest?.name || !manifest?.version) return { ok: false, code: 'PRIOR_MANIFEST_INVALID' };
  const ok = await activateRelease({ home, releaseDir: prior.path, manifest, log, installer });
  return ok ? { ok: true, version: manifest.version, path: prior.path } : { ok: false, code: 'PRIOR_ACTIVATION_FAILED' };
}

export async function npxIntegrate({ home = homedir(), log = console.log } = {}) {
  log('✗ official 3080 integration is disabled: the official web profile is read-only');
  return { ok: false, error: 'OFFICIAL_WEB_PROFILE_READ_ONLY' };
}

export async function npxDetach({ home = homedir(), log = console.log } = {}) {
  log('✗ official 3080 detach is disabled: the official web profile is read-only');
  return { ok: false, error: 'OFFICIAL_WEB_PROFILE_READ_ONLY' };
}

export async function npxInstall({
  home = homedir(),
  log = console.log,
  sourceRoot,
  installer = realInstaller,
  ensureRuntime,
  npmInstaller,
} = {}) {
  log('DSH Crew installer (npx-managed)');
  const updateLock = acquireUpdateLock({ home });
  if (!updateLock.ok) return { ok: false, error: `another update is in progress (${updateLock.code})` };
  try {
    return await npxInstallInner({ home, log, sourceRoot, installer, ensureRuntime, npmInstaller });
  } finally {
    releaseUpdateLock({ home, nonce: updateLock.nonce ?? null });
  }
}

async function npxInstallInner({ home, log, sourceRoot, installer, ensureRuntime, npmInstaller }) {
  const reconciled = reconcileUpdateJournal({ home, log });
  if (!reconciled.ok) return { ok: false, error: `update journal recovery failed (${reconciled.code ?? 'unknown'})` };
  const candidateRoot = sourceRoot ?? runningPackageRoot();
  const manifest = readManifest(candidateRoot);
  if (!manifest?.name || !manifest?.version) return { ok: false, error: 'candidate package manifest invalid' };

  const health = currentInstallationHealth({ home });
  if (health.installed && health.pointer.version === manifest.version && health.validated.ok) {
    // Same-version reinstall: repair activation surfaces without restaging.
    log(`- installed payload ${manifest.version} already present and valid; repairing activation`);
    const activated = await activateRelease({ home, releaseDir: health.pointer.path, manifest, log, installer });
    if (!activated) return { ok: false, error: 'activation failed' };
    if (!await ensureRuntimeStep({ home, log, ensureRuntime })) return { ok: false, error: 'Crew DSH runtime bootstrap failed' };
    log('');
    log('Done.');
    return { ok: true, repaired: true, version: manifest.version, path: health.pointer.path };
  }

  const staged = stageCandidatePayload({ sourceRoot: candidateRoot, home, log, npmInstaller });
  if (!staged.ok) {
    log(`✗ staging failed (${staged.code})${staged.detail ? `: ${staged.detail.join('; ')}` : ''}`);
    return { ok: false, error: `staging failed (${staged.code})` };
  }
  log(`✓ candidate payload staged (${manifest.version})`);

  // Transaction order: stage -> runtime gate -> journal(begin) ->
  // activation -> pointer commit LAST -> clear journal -> GC. A crash
  // anywhere before the pointer write leaves the prior release
  // authoritative for reconcileUpdateJournal.
  const prior = readCurrentPointer({ home });
  if (!await ensureRuntimeStep({ home, log, ensureRuntime })) return { ok: false, error: 'Crew DSH runtime bootstrap failed' };

  beginReleaseActivation({ stageDir: staged.stageDir, manifest, home, prior });
  log(`✓ candidate payload staged (${manifest.version})`);

  const activated = await activateRelease({ home, releaseDir: staged.stageDir, manifest, log, installer });
  if (!activated) {
    const compensated = prior?.path ? await compensateActivation({ home, prior, log, installer }) : null;
    return { ok: false, error: 'activation failed', compensated: compensated?.ok === true };
  }

  const releaseDir = commitActivatedRelease({ stageDir: staged.stageDir, manifest, home, prior });
  log(`✓ durable release committed under Crew-owned state`);

  log('');
  log('Done.');
  log('Restart DeepSeek Harness and Codex Desktop.');
  return { ok: true, version: manifest.version, path: releaseDir };
}

export const UPDATE_PACKAGE_NAME = '@ran-sh/dsh-crew';
export const UPDATE_DEFAULT_SPEC = `${UPDATE_PACKAGE_NAME}@latest`;

/**
 * Extract a packed npm tarball with the platform `tar` binary (bsdtar ships
 * with Windows 10+, macOS, and Linux) into destDir; npm tarballs always root
 * at `package/`.
 */
export function extractPackageTarball(tgzPath, destDir, { runner = spawnSync } = {}) {
  mkdirSync(destDir, { recursive: true });
  // GNU tar interprets a `C:\...` argument as a remote rsh host ("Cannot
  // connect to C:"), so anchor the invocation inside destDir and pass the
  // archive by basename: every argument stays colon-free for both bsdtar
  // (Windows 10+) and GNU tar, whatever PATH resolves first.
  const localArchive = join(destDir, 'candidate.tgz');
  copyFileSync(tgzPath, localArchive);
  const result = runner('tar', ['-xzf', 'candidate.tgz'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: destDir,
  });
  const root = join(destDir, 'package');
  if (result.status !== 0 || !existsSync(join(root, 'package.json'))) {
    return { ok: false, detail: `tar extract failed (${result.status}): ${(result.stderr || result.stdout || '').trim().slice(-200)}` };
  }
  return { ok: true, sourceRoot: root };
}

/**
 * The globally installed launcher intentionally does not self-replace. When
 * the payload is newer, keep it authoritative and give the exact launcher
 * refresh command. A newer launcher is handled by npxUpdate before this point.
 */
function noteLauncherDivergence({ log, home = homedir() }) {
  const launcherVersion = readManifest(runningPackageRoot())?.version ?? null;
  let installedVersion = null;
  try { installedVersion = readCurrentPointer({ home }).version ?? null; } catch { installedVersion = null; }
  if (launcherVersion && installedVersion && compareVersions(installedVersion, launcherVersion) > 0) {
    log('');
    log(`- note: managed payload ${installedVersion} is newer than the global launcher ${launcherVersion}; the payload remains authoritative.`);
    log(`  Refresh the launcher when convenient: npm install -g ${UPDATE_PACKAGE_NAME}@${installedVersion}`);
  }
}

/**
 * Resolve an update candidate WITHOUT a source checkout:
 *  - explicit candidate path: a payload directory or a packed .tgz file;
 *  - otherwise npm registry mode: `npm pack <spec>` using the user's own
 *    configured registry/auth (no policy or config mutation), extracted to a
 *    disposable directory the caller cleans up via returned cleanup().
 */
export function resolveUpdateCandidate({
  candidate,
  spec = UPDATE_DEFAULT_SPEC,
  home = homedir(),
  log = () => {},
  runner = spawnSync,
} = {}) {
  const candidateValue = candidate ?? process.env.DSH_CREW_CANDIDATE ?? undefined;
  if (candidateValue !== undefined && typeof candidateValue !== 'string') {
    return { ok: false, code: 'INVALID_CANDIDATE', detail: 'candidate must be a directory or .tgz path' };
  }
  if (typeof candidateValue === 'string' && candidateValue.trim()) {
    const value = resolve(candidateValue.trim());
    if (!existsSync(value)) return { ok: false, code: 'CANDIDATE_NOT_FOUND', detail: value };
    if (existsSync(join(value, 'package.json'))) {
      const manifest = readManifest(value);
      if (!manifest?.name || !manifest?.version) return { ok: false, code: 'CANDIDATE_MANIFEST_INVALID', detail: value };
      return { ok: true, sourceRoot: value, version: manifest.version, cleanup: null };
    }
    if (/\.tgz$/i.test(value)) {
      const tmpRoot = join(crewReleasesDir({ home }), `.candidate-${timestampStamp()}-${process.pid}`);
      const extracted = extractPackageTarball(value, tmpRoot, { runner });
      if (!extracted.ok) {
        rmSync(tmpRoot, { recursive: true, force: true });
        return { ok: false, code: 'CANDIDATE_EXTRACT_FAILED', detail: extracted.detail };
      }
      const manifest = readManifest(extracted.sourceRoot);
      if (!manifest?.name || !manifest?.version) {
        rmSync(tmpRoot, { recursive: true, force: true });
        return { ok: false, code: 'CANDIDATE_MANIFEST_INVALID', detail: value };
      }
      return {
        ok: true,
        sourceRoot: extracted.sourceRoot,
        version: manifest.version,
        cleanup: () => rmSync(tmpRoot, { recursive: true, force: true }),
      };
    }
    return { ok: false, code: 'UNSUPPORTED_CANDIDATE', detail: value };
  }

  // Registry mode.
  const tmpDir = join(crewReleasesDir({ home }), `.candidate-${timestampStamp()}-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    const effectiveSpec = process.env.DSH_CREW_UPDATE_SPEC ?? spec;
    const packArgs = ['pack', effectiveSpec, '--pack-destination', tmpDir, '--json', '--loglevel=error'];
    log(`- resolving update candidate from the configured npm registry (${effectiveSpec})`);
    const invocation = npmCliInvocation(packArgs);
    const packed = runner(invocation.command, invocation.args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000, windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      env: sanitizedPackageManagerEnv(),
    });
    if (packed.status !== 0) {
      return { ok: false, code: 'REGISTRY_PACK_FAILED', detail: `${effectiveSpec}: ${(packed.stderr || packed.stdout || '').trim().slice(-300)}` };
    }
    let info;
    try { info = JSON.parse(packed.stdout)[0]; } catch {
      return { ok: false, code: 'REGISTRY_PACK_UNPARSEABLE', detail: String(packed.stdout).slice(-200) };
    }
    if (!info?.filename) return { ok: false, code: 'REGISTRY_PACK_UNPARSEABLE', detail: 'pack output missing filename' };
    const tgzPath = join(tmpDir, info.filename);
    const extracted = extractPackageTarball(tgzPath, join(tmpDir, 'x'), { runner });
    if (!extracted.ok) {
      return { ok: false, code: 'CANDIDATE_EXTRACT_FAILED', detail: extracted.detail };
    }
    const manifest = readManifest(extracted.sourceRoot);
    if (!manifest?.name || !manifest?.version) {
      return { ok: false, code: 'CANDIDATE_MANIFEST_INVALID', detail: info.filename };
    }
    if (info.name !== manifest.name || info.version !== manifest.version) {
      return { ok: false, code: 'CANDIDATE_IDENTITY_MISMATCH', detail: `pack ${info.name}@${info.version} vs manifest ${manifest.name}@${manifest.version}` };
    }
    return {
      ok: true,
      sourceRoot: extracted.sourceRoot,
      version: manifest.version,
      cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    return { ok: false, code: 'REGISTRY_PACK_FAILED', detail: String(error?.message ?? error).slice(-300) };
  }
}

export async function npxUpdate({
  home = homedir(),
  log = console.log,
  sourceRoot,
  candidate,
  spec,
  installer = realInstaller,
  ensureRuntime,
  npmInstaller,
  runner = spawnSync,
} = {}) {
  log('DSH Crew updater');
  const updateLock = acquireUpdateLock({ home });
  if (!updateLock.ok) return { ok: false, error: `another update is in progress (${updateLock.code})` };
  try {
    return await npxUpdateInner({ home, log, sourceRoot, candidate, spec, installer, ensureRuntime, npmInstaller, runner });
  } finally {
    releaseUpdateLock({ home, nonce: updateLock.nonce ?? null });
  }
}

async function npxUpdateInner({ home, log, sourceRoot, candidate, spec, installer, ensureRuntime, npmInstaller, runner = spawnSync }) {
  const journalRecovery = reconcileUpdateJournal({ home, log });
  if (!journalRecovery.ok) return { ok: false, error: `update journal recovery failed (${journalRecovery.code ?? 'unknown'})` };
  // Candidate resolution: explicit path/dir override > a newer validated
  // running launcher > configured npm registry (@latest). This makes the
  // supported legacy bootstrap (`npm install -g ...@latest`, then `update`)
  // independent of registry propagation after the launcher refresh.
  const explicitCandidate = candidate ?? sourceRoot;
  const initialHealth = currentInstallationHealth({ home });
  const launcherRoot = runningPackageRoot();
  const launcherManifest = readManifest(launcherRoot);
  const launcherCanConverge = explicitCandidate === undefined
    && initialHealth.pointer?.version
    && launcherManifest?.name === UPDATE_PACKAGE_NAME
    && launcherManifest?.version
    && compareVersions(launcherManifest.version, initialHealth.pointer.version) > 0;
  let resolved;
  if (launcherCanConverge) {
    log(`- newer launcher ${launcherManifest.version}; converging managed payload ${initialHealth.pointer.version} before registry resolution`);
    resolved = { ok: true, sourceRoot: launcherRoot, version: launcherManifest.version, cleanup: null };
  } else {
    resolved = resolveUpdateCandidate({ candidate: explicitCandidate, spec, home, log, runner });
  }
  if (!resolved.ok) {
    log(`✗ candidate resolution failed (${resolved.code})${resolved.detail ? `: ${resolved.detail}` : ''}`);
    return { ok: false, error: `candidate resolution failed (${resolved.code})` };
  }
  try {
    const manifest = readManifest(resolved.sourceRoot);
    if (!manifest?.name || !manifest?.version) return { ok: false, error: 'candidate package manifest invalid' };

    const health = currentInstallationHealth({ home });

    if (health.installed && health.healthy && health.pointer.version === manifest.version) {
      log(`- already current (${manifest.version}); repairing registration/integrations idempotently`);
      const activated = await activateRelease({ home, releaseDir: health.pointer.path, manifest, log, installer });
      if (!activated) return { ok: false, error: 'activation failed' };
      if (!await ensureRuntimeStep({ home, log, ensureRuntime })) return { ok: false, error: 'Crew DSH runtime bootstrap failed' };
      log('');
      log('Done.');
      return { ok: true, idempotent: true, version: manifest.version, path: health.pointer.path };
    }

    if (health.installed && health.healthy && compareVersions(manifest.version, health.pointer.version) < 0) {
      const source = explicitCandidate === undefined && !launcherCanConverge ? 'registry latest' : 'candidate';
      log(`- ${source} (${manifest.version}) is not newer than the installed payload (${health.pointer.version}); nothing to update`);
      const activated = await activateRelease({ home, releaseDir: health.pointer.path, manifest: readManifest(health.pointer.path), log, installer });
      if (!activated) return { ok: false, error: 'activation failed' };
      return { ok: true, idempotent: true, version: health.pointer.version, path: health.pointer.path };
    }

    // Stale, unhealthy, older, or missing installation: stage the candidate
    // fully and validate it before switching. The previous usable release is
    // left in place until the replacement has been committed and activated.
    if (health.installed && !health.healthy) {
      log('- existing installation is stale or incomplete; repairing via fresh candidate staging');
    } else if (health.installed) {
      log(`- updating managed payload ${health.pointer.version} -> ${manifest.version}`);
    }

    const staged = stageCandidatePayload({ sourceRoot: resolved.sourceRoot, home, log, npmInstaller });
    if (!staged.ok) {
      log(`✗ staging failed (${staged.code})${staged.detail ? `: ${staged.detail.join('; ')}` : ''}`);
      return { ok: false, error: `staging failed (${staged.code})` };
    }
    log(`✓ candidate payload staged and validated (${manifest.version})`);

    // Transaction order: stage -> runtime gate -> journal(begin) ->
    // activation -> pointer commit LAST -> clear journal -> GC. A crash
    // anywhere before the pointer write leaves the prior release
    // authoritative for reconcileUpdateJournal.
    const prior = readCurrentPointer({ home });
    if (!await ensureRuntimeStep({ home, log, ensureRuntime })) return { ok: false, error: 'Crew DSH runtime bootstrap failed' };

    beginReleaseActivation({ stageDir: staged.stageDir, manifest, home, prior });

    const activated = await activateRelease({ home, releaseDir: staged.stageDir, manifest, log, installer });
    if (!activated) {
      const compensated = prior?.path ? await compensateActivation({ home, prior, log, installer }) : null;
      return { ok: false, error: 'activation failed', compensated: compensated?.ok === true };
    }

    const releaseDir = commitActivatedRelease({ stageDir: staged.stageDir, manifest, home, prior });
    log('✓ durable release committed under Crew-owned state');

    noteLauncherDivergence({ log, home });
    log('');
    log('Done.');
    log('Restart DeepSeek Harness and Codex Desktop.');
    return { ok: true, updated: true, version: manifest.version, path: releaseDir };
  } finally {
    resolved.cleanup?.();
  }
}

/**
 * Compare dotted numeric versions; returns -1/0/1. Non-numeric segments fall
 * back to string comparison so prerelease identifiers stay deterministic.
 */
export function compareVersions(left, right) {
  const asParts = (value) => String(value ?? '').split('.');
  const a = asParts(left);
  const b = asParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? '0';
    const y = b[index] ?? '0';
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (xn !== yn) {
      // npm semantics: a numeric release segment outranks a prerelease segment.
      return xn ? 1 : -1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function npxStatus({
  home = homedir(),
  log = console.log,
  sourceRoot,
  installer = realInstaller,
} = {}) {
  const candidateRoot = sourceRoot ?? runningPackageRoot();
  const manifest = readManifest(candidateRoot);
  const candidateVersion = manifest?.version ?? null;

  const pointer = readCurrentPointer({ home });
  let installedLine = 'not installed';
  let installedVersion = null;
  if (pointer) {
    if (existsSync(pointer.path)) {
      const validated = validateInstalledPayload(pointer.path, { expectedName: pointer.name, expectedVersion: pointer.version });
      if (validated.ok) {
        installedVersion = pointer.version;
        installedLine = `${pointer.version} (${pointer.path})`;
      } else {
        installedVersion = pointer.version;
        installedLine = `${pointer.version} at ${pointer.path} (unverifiable/damaged)`;
      }
    } else {
      installedLine = `pointer references missing payload (${pointer.path})`;
    }
  }

  // Read-only DSH plugin state from the dedicated Crew profile only; the
  // official web profile layout is intentionally never inspected.
  let dshPlugin = 'not installed';
  const profilePkgFile = join(crewProfileDir({ home }), 'package.json');
  const packageName = manifest?.name ?? pointer?.name ?? null;
  if (packageName && existsSync(profilePkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(profilePkgFile, 'utf8'));
      const listed = Boolean(pkg.dependencies?.[packageName]) || Boolean(pkg.dsh?.profile?.bundles?.includes?.(packageName));
      const linkOk = packageName && existsSync(registrationLinkPath({ home, name: packageName }));
      dshPlugin = listed && linkOk ? 'installed' : listed ? 'registered but payload link missing' : 'not installed';
    } catch { dshPlugin = 'unknown'; }
  }

  const st = installer.installStatus
    ? installer.installStatus({ home, root: pointer?.path ?? runningPackageRoot() })
    : realInstaller.installStatus({ home, root: pointer?.path ?? runningPackageRoot() });
  const codex = st?.codex?.installed ? 'installed' : 'not installed';
  const zcode = st?.zcode?.installed ? 'installed' : 'not installed';
  const claude = st?.claude?.installed ? 'installed' : 'not installed';
  const official = officialWebIntegrationStatus({ home, releaseDir: pointer?.path });
  const officialWeb = !official.enabled ? 'disabled' : official.healthy ? 'installed' : 'needs repair';
  const startupState = installer.windowsStartupStatus?.({ home });
  const windowsStartup = !startupState?.supported ? 'not supported'
    : startupState.ready ? 'installed' : startupState.installed ? 'needs repair' : 'not installed';

  log(`DSH Crew launcher/candidate: ${candidateVersion ?? 'unknown'}`);
  log(`Installed DSH Crew payload: ${installedLine}`);
  if (candidateVersion && installedVersion && candidateVersion !== installedVersion) {
    const direction = compareVersions(candidateVersion, installedVersion);
    if (direction > 0) {
      log(`- launcher ${candidateVersion} is newer than the managed payload ${installedVersion}.`);
      log('  Run: dsh-crew update');
    } else {
      log(`- managed payload ${installedVersion} is newer than the launcher ${candidateVersion}; the payload remains authoritative.`);
      log(`  Refresh the launcher with: npm install -g ${UPDATE_PACKAGE_NAME}@${installedVersion}`);
    }
  }
  log(`DSH plugin: ${dshPlugin} (dedicated dsh-crew profile on 3210)`);
  log(`Official 3080 UI bridge: ${officialWeb}`);
  log(`Codex Desktop integration: ${codex}`);
  log(`ZCode integration: ${zcode}`);
  log(`Claude Code integration: ${claude}`);
  log(`Windows login startup: ${windowsStartup}`);

  return {
    ok: true,
    candidateVersion,
    installedVersion,
    installedPath: pointer?.path ?? null,
    dshPlugin,
    officialWeb,
    codex,
    zcode,
    claude,
    windowsStartup,
  };
}

export async function npxUninstall({
  home = homedir(),
  purge = false,
  log = console.log,
  installer = realInstaller,
} = {}) {
  log('DSH Crew uninstaller (npx-managed)');
  const failures = [];
  const fail = (text) => { log(`✗ ${text}`); failures.push(text); };

  const pointer = readCurrentPointer({ home });
  const name = pointer?.name ?? readManifest(runningPackageRoot())?.name;

  const cx = installer.uninstallCodex({ home });
  if (cx.ok !== false) log('✓ Codex Desktop integration removed');
  else fail('Codex Desktop integration removal failed');

  if (installer.uninstallZCode) {
    const zc = installer.uninstallZCode({ home });
    if (zc.ok !== false) log('✓ ZCode integration removed');
    else fail('ZCode integration removal failed');
  }

  const cl = installer.uninstallClaudeCode ? await installer.uninstallClaudeCode({ home }) : realInstaller.uninstallClaudeCode({ home });
  if (cl.ok !== false) log('✓ Claude Code integration removed');
  else fail('Claude Code integration removal failed');

  const startup = installer.uninstallWindowsStartup?.({ home });
  if (startup?.ok === false) fail('Windows login startup removal failed');
  else if (startup?.supported) log('✓ Windows login startup removed');

  const official = removeOfficialWebIntegration({ home, preserveIntent: !purge, remember: !purge });
  if (!official.ok && official.code !== 'OFFICIAL_WEB_PROFILE_READ_ONLY') fail(`official 3080 bridge removal failed (${official.code ?? 'unknown'})`);
  else if (official.code === 'OFFICIAL_WEB_PROFILE_READ_ONLY') log('- official 3080 bridge left untouched (official web profile is read-only)');
  else log(official.removed ? '✓ official 3080 bridge removed' : '- official 3080 bridge already absent');

  if (name) {
    const removed = removeCrewPluginRegistration({ home, name });
    if (!removed.ok) fail(`Harness registration removal failed (${removed.code ?? 'unknown'})`);
    else log(removed.removed ? '✓ Harness plugin registration removed (offline, Crew-owned state)' : '- Harness plugin registration already absent');
  } else {
    fail('installed package name unknown; registration not removed');
  }

  if (purge) {
    try {
      rmSync(join(home, '.config', 'dsh-crew'), { recursive: true, force: true });
      log('✓ ~/.config/dsh-crew purged');
    } catch { fail('could not purge ~/.config/dsh-crew'); }
  } else {
    // Remove ONLY the Crew-managed installed payload; config, credentials,
    // backups, and the isolated Harness home stay untouched.
    try {
      rmSync(crewAppRoot({ home }), { recursive: true, force: true });
      log('✓ Crew-managed installed payload removed (config/backups kept)');
    } catch { fail('could not remove the Crew-managed installed payload'); }
  }

  if (failures.length > 0) {
    log('');
    log('FAILED: uninstall incomplete');
    return { ok: false, failures };
  }
  log('');
  log('Done.');
  return { ok: true, failures: [] };
}

// ---- CLI dispatch --------------------------------------------------------------

export const USAGE = `usage: dsh-crew <command> [--purge] [--candidate <path>]

Commands:
  install     persist the candidate package into Crew-owned state and register it
  integrate   show Crew inside the official 3080 UI; backend stays isolated on 3210
  detach      remove only the official 3080 bridge; isolated 3210 mode remains available
  status      read-only report of launcher/installed versions and integrations
  inspect     print the machine-readable extension capability/readiness contract
  jobs        machine-first job API: list|get|watch|cancel|submit
  providers   3210 provider lifecycle API: list|migration-status|migrate-plan|migrate|verify-migration|rollback-migration|verify-rollback-migration|delete-plan|delete|rollback|probe
  credentials 3210 credential references: list|purge-plan|purge (separate confirmation)
  releases    list retained, validated Crew payload releases
  rollback    switch to a retained payload version and verify the 3210 runtime
  update      resolve the newest permitted package from the configured npm registry (or
              --candidate), stage and validate it, then activate; idempotent when current
  uninstall   remove the Crew-managed payload, registration, and integrations (config kept)

Options:
  --candidate <path>  update from a local payload directory or packed .tgz instead of the registry
  --after <sequence>  with jobs watch/get: return canonical events after this cursor
  --detail <mode>     with jobs get/watch: compact (default) or full
  --request <path>    with jobs submit: JSON Job Request document
  --plan <id>         with providers/credentials destructive actions: approved plan id
  --expected-revision <sha256>  with providers/credentials actions: revision from plan
  --replacement-default <id>   with providers delete-plan: replacement Harness Default provider
  --confirm           with providers delete: confirm the destructive mutation
  --purge             with uninstall: also remove ~/.config/dsh-crew config/backups (destructive)
  --help              show this help

Primary install: npm install -g @ran-sh/dsh-crew   (then run: dsh-crew install)
Source checkouts use scripts/setup.mjs instead.`;

export async function npxInspect({
  log = console.log,
  fetchImpl = globalThis.fetch,
  readConfig = realInstaller.readGlobalConfig,
} = {}) {
  const hubUrl = String(readConfig()?.hub_url ?? PRODUCTION_HUB_URL).replace(/\/$/, '');
  await assertProductionHub({ hubUrl, requiredCapabilities: INSPECT_CAPABILITIES, purpose: 'inspect', fetchImpl });
  const url = `${String(hubUrl).replace(/\/$/, '')}/_dsh/dsh-crew/extension`;
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  const body = await response.json();
  if (!response.ok || body?.ok !== true || !body.extension) {
    throw new Error('isolated Crew Hub extension contract is unavailable');
  }
  log(JSON.stringify(body.extension, null, 2));
  return { ok: true, extension: body.extension };
}

export async function npxJobs({
  args = [],
  after = 0,
  detail = 'compact',
  request,
  log = console.log,
  fetchImpl = globalThis.fetch,
  readConfig = realInstaller.readGlobalConfig,
} = {}) {
  const hubUrl = String(readConfig()?.hub_url ?? 'http://127.0.0.1:3210').replace(/\/$/, '');
  const base = `${hubUrl}/_dsh/dsh-crew/jobs`;
  const action = args[0] ?? 'list';
  const id = args[1];
  const requiredCapabilities = JOB_CAPABILITY_REQUIREMENTS[action];
  if (!requiredCapabilities) throw new Error(`unknown jobs action: ${action}`);
  await assertProductionHub({ hubUrl, requiredCapabilities, purpose: 'job', fetchImpl });
  let url = base;
  let init = { headers: { accept: 'application/json' } };
  if (action === 'get' || action === 'watch') {
    if (!id) throw new Error(`jobs ${action} requires a job id`);
    url = `${base}/${encodeURIComponent(id)}/contract?detail=${detail}&after=${after}`;
  } else if (action === 'cancel') {
    if (!id) throw new Error('jobs cancel requires a job id');
    url = `${base}/${encodeURIComponent(id)}/cancel`;
    init = { ...init, method: 'POST' };
  } else if (action === 'submit') {
    if (!request) throw new Error('jobs submit requires --request <json-file>');
    const document = JSON.parse(readFileSync(resolve(request), 'utf8'));
    init = { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(document) };
  }
  const response = await fetchImpl(url, init);
  const body = await response.json();
  if (!response.ok || body?.ok === false) throw new Error(body?.error ?? 'Crew jobs API unavailable');
  log(JSON.stringify(body, null, 2));
  return { ok: true, body };
}

const PROVIDER_CAPABILITY_REQUIREMENTS = Object.freeze({
  list: Object.freeze(['provider-inventory']),
  'migration-status': Object.freeze(['provider-inventory']),
  'migrate-plan': Object.freeze(['provider-inventory', 'provider-layer-migration-v1']),
  migrate: Object.freeze(['provider-inventory', 'provider-layer-migration-v1']),
  'verify-migration': Object.freeze(['provider-inventory', 'provider-layer-migration-v1']),
  'rollback-migration': Object.freeze(['provider-inventory', 'provider-layer-migration-v1']),
  'verify-rollback-migration': Object.freeze(['provider-inventory', 'provider-layer-migration-v1']),
  'delete-plan': Object.freeze(['provider-inventory', 'provider-lifecycle-v1']),
  delete: Object.freeze(['provider-inventory', 'provider-lifecycle-v1']),
  rollback: Object.freeze(['provider-inventory', 'provider-lifecycle-v1']),
  probe: Object.freeze(['provider-inventory', 'provider-health-v1', 'provider-probe-stream-v1']),
});
const JOB_CAPABILITY_REQUIREMENTS = Object.freeze({
  list: Object.freeze(['jobs']),
  get: Object.freeze(['jobs', 'jobs-wait']),
  watch: Object.freeze(['jobs', 'jobs-wait']),
  cancel: Object.freeze(['jobs', 'jobs-cancel']),
  submit: Object.freeze(['jobs', 'roles', 'attempt-index', 'model-policy']),
});
const INSPECT_CAPABILITIES = Object.freeze(['extension-contract', 'evidence', 'runtime-provenance-v1']);
const CREDENTIAL_CAPABILITY_REQUIREMENTS = Object.freeze({
  list: Object.freeze(['credential-reference-inventory-v1']),
  'purge-plan': Object.freeze(['credential-reference-inventory-v1', 'credential-purge-v1']),
  purge: Object.freeze(['credential-reference-inventory-v1', 'credential-purge-v1']),
});
export const PRODUCTION_HUB_URL = 'http://127.0.0.1:3210';

export async function assertProductionHub({ hubUrl, requiredCapabilities = [], purpose = 'command', fetchImpl = globalThis.fetch } = {}) {
  if (hubUrl !== PRODUCTION_HUB_URL) throw new Error(`${purpose} requires the isolated 3210 Crew Hub`);
  const response = await fetchImpl(`${hubUrl}${CREW_ROUTE_BASE}/runtime`, { headers: { accept: 'application/json' } });
  let body;
  try { body = await response.json(); } catch { body = null; }
  const validIdentity = response.ok && body?.ok === true
    && body?.service === 'dsh-crew-hub'
    && body?.execution_plane === 'hub-3210'
    && body?.profile === 'dsh-crew'
    && Number(body?.listen_port) === 3210
    && typeof body?.runtime_id === 'string' && body.runtime_id.trim().length > 0;
  if (!validIdentity) throw new Error(`${purpose} requires a compatible isolated 3210 Crew Hub`);
  const advertised = new Set(Array.isArray(body.capabilities) ? body.capabilities.filter((value) => typeof value === 'string') : []);
  const missing = requiredCapabilities.filter((capability) => !advertised.has(capability));
  if (missing.length > 0) throw new Error(`missing ${purpose} capability: ${missing.join(', ')}`);
  return { ok: true, runtime: body, capabilities: [...advertised] };
}

/**
 * Confirm the target is the live isolated Hub and advertises the lifecycle
 * surface before sending a provider request. This prevents a same-port stale
 * Hub from turning a later 404 into an ambiguous destructive failure.
 */
export async function assertProviderHubCapabilities({ hubUrl, action, fetchImpl = globalThis.fetch } = {}) {
  return assertProductionHub({
    hubUrl,
    requiredCapabilities: PROVIDER_CAPABILITY_REQUIREMENTS[action] ?? PROVIDER_CAPABILITY_REQUIREMENTS.list,
    purpose: 'provider lifecycle',
    fetchImpl,
  });
}

/**
 * Call the isolated 3210 provider lifecycle API. The CLI never parses or
 * edits Harness YAML itself; the Hub remains the sole mutation authority.
 */
export async function npxProviders({
  args = [],
  planId,
  expectedRevision,
  replacementDefault,
  confirm = false,
  purgeOrphanCredentials = false,
  log = console.log,
  fetchImpl = globalThis.fetch,
  readConfig = realInstaller.readGlobalConfig,
} = {}) {
  const configuredHubUrl = String(readConfig()?.hub_url ?? PRODUCTION_HUB_URL).replace(/\/$/, '');
  const hubUrl = configuredHubUrl;
  const base = `${hubUrl}/_dsh/dsh-crew/providers`;
  const action = args[0] ?? 'list';
  const id = args[1];
  const options = new Map();
  for (let index = 2; index < args.length; index += 1) {
    const value = args[index];
    if (!value?.startsWith('--')) continue;
    const [name, inline] = value.split('=', 2);
    if (name === '--confirm' || name === '--purge-orphan-credentials') options.set(name === '--confirm' ? 'confirm' : name, true);
    else if (inline !== undefined) options.set(name, inline);
    else if (args[index + 1] !== undefined) options.set(name, args[++index]);
  }
  const resolvedPlan = planId ?? options.get('--plan');
  const resolvedRevision = expectedRevision ?? options.get('--expected-revision');
  const resolvedReplacement = replacementDefault ?? options.get('--replacement-default');
  const resolvedConfirm = confirm === true || options.get('confirm') === true;
  if (purgeOrphanCredentials === true || options.get('--purge-orphan-credentials') === true) {
    throw new Error('credential purge requires a separate explicit confirmation flow');
  }
  await assertProviderHubCapabilities({ hubUrl, action, fetchImpl });
  let url = base;
  let init = { headers: { accept: 'application/json' } };
  if (action === 'list') {
    // keep defaults
  } else if (action === 'migration-status') {
    url = `${base}/migration-status`;
  } else if (action === 'migrate-plan') {
    if (!id) throw new Error('providers migrate-plan requires a provider id');
    url = `${base}/${encodeURIComponent(id)}/migrate-plan`;
    init = { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{}' };
  } else if (action === 'migrate') {
    if (!id) throw new Error('providers migrate requires a provider id');
    if (!resolvedPlan || !resolvedConfirm) throw new Error('providers migrate requires --plan and --confirm');
    url = `${base}/${encodeURIComponent(id)}/migrate`;
    init = { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ plan_id: resolvedPlan, confirm: true }) };
  } else if (action === 'verify-migration') {
    if (!id) throw new Error('providers verify-migration requires a provider id');
    if (!resolvedPlan || !resolvedConfirm) throw new Error('providers verify-migration requires --plan and --confirm');
    url = `${base}/${encodeURIComponent(id)}/verify-migration`;
    init = { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ transaction_id: resolvedPlan, confirm: true }) };
  } else if (action === 'rollback-migration') {
    if (!id) throw new Error('providers rollback-migration requires a provider id');
    if (!resolvedPlan || !resolvedConfirm) throw new Error('providers rollback-migration requires --plan and --confirm');
    url = `${base}/${encodeURIComponent(id)}/rollback-migration`;
    init = { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ transaction_id: resolvedPlan, confirm: true }) };
  } else if (action === 'verify-rollback-migration') {
    if (!id) throw new Error('providers verify-rollback-migration requires a provider id');
    if (!resolvedPlan || !resolvedConfirm) throw new Error('providers verify-rollback-migration requires --plan and --confirm');
    url = `${base}/${encodeURIComponent(id)}/verify-rollback-migration`;
    init = { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ transaction_id: resolvedPlan, confirm: true }) };
  } else if (action === 'delete-plan') {
    if (!id) throw new Error('providers delete-plan requires a provider id');
    url = `${base}/${encodeURIComponent(id)}/delete-plan`;
    init = { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ ...(resolvedReplacement ? { replacement_default: resolvedReplacement } : {}) }) };
  } else if (action === 'delete') {
    if (!id) throw new Error('providers delete requires a provider id');
    if (!resolvedPlan || !resolvedRevision || !resolvedConfirm) throw new Error('providers delete requires --plan, --expected-revision and --confirm');
    url = `${base}/${encodeURIComponent(id)}`;
    init = {
      method: 'DELETE',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ plan_id: resolvedPlan, expected_revision: resolvedRevision, confirm: true }),
    };
  } else if (action === 'probe') {
    if (!id) throw new Error('providers probe requires a provider id');
    url = `${base}/${encodeURIComponent(id)}/probe`;
    init = { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: '{}' };
  } else if (action === 'rollback') {
    if (!id) throw new Error('providers rollback requires a provider id');
    if (!resolvedPlan || !resolvedConfirm) throw new Error('providers rollback requires --plan and --confirm');
    url = `${base}/${encodeURIComponent(id)}/rollback`;
    init = { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ transaction_id: resolvedPlan, confirm: true }) };
  } else {
    throw new Error(`unknown providers action: ${action}`);
  }
  const response = await fetchImpl(url, init);
  let body = await response.json();
  if (!response.ok || body?.ok === false) throw new Error(body?.code ?? body?.error ?? 'Crew provider API unavailable');
  if (action === 'delete' && body?.restart_required === true && body?.result?.state === 'RESTART_PENDING') {
    const restartResponse = await fetchImpl('http://127.0.0.1:3080/_dsh/dsh-crew/supervisor/restart', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const restartBody = await restartResponse.json();
    if (!restartResponse.ok || restartBody?.ok !== true) throw new Error(restartBody?.code ?? restartBody?.error ?? 'Crew 3210 restart failed');
    const verifyUrl = `${base}/${encodeURIComponent(id)}/verify-delete`;
    const verifyResponse = await fetchImpl(verifyUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ transaction_id: resolvedPlan, confirm: true }),
    });
    const verifyBody = await verifyResponse.json();
    if (!verifyResponse.ok || verifyBody?.ok !== true) throw new Error(verifyBody?.code ?? verifyBody?.error ?? 'Crew provider deletion verification failed');
    body = { ...body, restart: restartBody, verification: verifyBody };
  }
  if (action === 'migrate' && body?.restart_required === true && body?.result?.state === 'RESTART_PENDING') {
    const restartResponse = await fetchImpl('http://127.0.0.1:3080/_dsh/dsh-crew/supervisor/restart', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    const restartBody = await restartResponse.json();
    if (!restartResponse.ok || restartBody?.ok !== true) throw new Error(restartBody?.code ?? restartBody?.error ?? 'Crew 3210 restart failed');
    const verifyResponse = await fetchImpl(`${base}/${encodeURIComponent(id)}/verify-migration`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ transaction_id: resolvedPlan, confirm: true }),
    });
    const verifyBody = await verifyResponse.json();
    if (!verifyResponse.ok || verifyBody?.ok !== true) throw new Error(verifyBody?.code ?? verifyBody?.error ?? 'Crew provider migration verification failed');
    body = { ...body, restart: restartBody, verification: verifyBody };
  }
  if (action === 'rollback-migration' && body?.restart_required === true && body?.state === 'ROLLBACK_RESTART_PENDING') {
    const restartResponse = await fetchImpl('http://127.0.0.1:3080/_dsh/dsh-crew/supervisor/restart', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    const restartBody = await restartResponse.json();
    if (!restartResponse.ok || restartBody?.ok !== true) throw new Error(restartBody?.code ?? restartBody?.error ?? 'Crew 3210 restart failed');
    const verifyResponse = await fetchImpl(`${base}/${encodeURIComponent(id)}/verify-rollback-migration`, {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ transaction_id: resolvedPlan, confirm: true }),
    });
    const verifyBody = await verifyResponse.json();
    if (!verifyResponse.ok || verifyBody?.ok !== true) throw new Error(verifyBody?.code ?? verifyBody?.error ?? 'Crew provider migration rollback verification failed');
    body = { ...body, restart: restartBody, verification: verifyBody };
  }
  if (action === 'rollback' && body?.restart_required === true && body?.state === 'ROLLBACK_PENDING') {
    const restartResponse = await fetchImpl('http://127.0.0.1:3080/_dsh/dsh-crew/supervisor/restart', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const restartBody = await restartResponse.json();
    if (!restartResponse.ok || restartBody?.ok !== true) throw new Error(restartBody?.code ?? restartBody?.error ?? 'Crew 3210 restart failed');
    const verifyUrl = `${base}/${encodeURIComponent(id)}/verify-rollback`;
    const verifyResponse = await fetchImpl(verifyUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ transaction_id: resolvedPlan, confirm: true }),
    });
    const verifyBody = await verifyResponse.json();
    if (!verifyResponse.ok || verifyBody?.ok !== true) throw new Error(verifyBody?.code ?? verifyBody?.error ?? 'Crew provider rollback verification failed');
    body = { ...body, restart: restartBody, verification: verifyBody };
  }
  log(JSON.stringify(body, null, 2));
  return { ok: true, body };
}

/** Independent credential-reference inventory and irreversible purge CLI. */
export async function npxCredentials({
  args = [],
  planId,
  expectedRevision,
  confirm = false,
  log = console.log,
  fetchImpl = globalThis.fetch,
  readConfig = realInstaller.readGlobalConfig,
} = {}) {
  const hubUrl = String(readConfig()?.hub_url ?? PRODUCTION_HUB_URL).replace(/\/$/, '');
  const action = args[0] ?? 'list';
  const id = args[1];
  const requiredCapabilities = CREDENTIAL_CAPABILITY_REQUIREMENTS[action];
  if (!requiredCapabilities) throw new Error(`unknown credentials action: ${action}`);
  await assertProductionHub({ hubUrl, requiredCapabilities, purpose: 'credential', fetchImpl });
  const base = `${hubUrl}${CREW_ROUTE_BASE}/credential-references`;
  let url = base;
  let init = { headers: { accept: 'application/json' } };
  if (action === 'purge-plan') {
    if (!id) throw new Error('credentials purge-plan requires a reference id');
    url = `${base}/${encodeURIComponent(id)}/purge-plan`;
    init = { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ ...(expectedRevision ? { expected_revision: expectedRevision } : {}) }) };
  } else if (action === 'purge') {
    if (!id) throw new Error('credentials purge requires a reference id');
    if (!planId || !expectedRevision || confirm !== true) throw new Error('credentials purge requires --plan, --expected-revision and --confirm');
    url = `${base}/${encodeURIComponent(id)}`;
    init = { method: 'DELETE', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ plan_id: planId, expected_revision: expectedRevision, confirm: true }) };
  }
  const response = await fetchImpl(url, init);
  const body = await response.json();
  if (!response.ok || body?.ok === false) throw new Error(body?.code ?? body?.error ?? 'Crew credential API unavailable');
  log(JSON.stringify(body, null, 2));
  return { ok: true, body };
}

function normalizeCommand(argv) {
  const flags = argv.slice(1);
  let candidate;
  let after = 0;
  let detail = 'compact';
  let request;
  let planId;
  let expectedRevision;
  let replacementDefault;
  let confirm = false;
  let purgeOrphanCredentials = false;
  for (let index = 0; index < flags.length; index += 1) {
    if (flags[index] === '--candidate') {
      candidate = flags[index + 1];
      flags.splice(index, 2);
      index -= 1;
    } else if (flags[index]?.startsWith('--candidate=')) {
      candidate = flags[index].slice('--candidate='.length);
      flags.splice(index, 1);
      index -= 1;
    } else if (flags[index] === '--after' || flags[index] === '--detail' || flags[index] === '--request') {
      const name = flags[index];
      const value = flags[index + 1];
      if (name === '--after') after = Number(value);
      if (name === '--detail') detail = value;
      if (name === '--request') request = value;
      flags.splice(index, 2);
      index -= 1;
    } else if (flags[index]?.startsWith('--after=')) {
      after = Number(flags[index].slice('--after='.length)); flags.splice(index, 1); index -= 1;
    } else if (flags[index]?.startsWith('--detail=')) {
      detail = flags[index].slice('--detail='.length); flags.splice(index, 1); index -= 1;
    } else if (flags[index]?.startsWith('--request=')) {
      request = flags[index].slice('--request='.length); flags.splice(index, 1); index -= 1;
    } else if (flags[index] === '--plan' || flags[index] === '--expected-revision' || flags[index] === '--replacement-default') {
      const name = flags[index];
      const value = flags[index + 1];
      if (name === '--plan') planId = value;
      if (name === '--expected-revision') expectedRevision = value;
      if (name === '--replacement-default') replacementDefault = value;
      flags.splice(index, 2); index -= 1;
    } else if (flags[index]?.startsWith('--plan=')) {
      planId = flags[index].slice('--plan='.length); flags.splice(index, 1); index -= 1;
    } else if (flags[index]?.startsWith('--expected-revision=')) {
      expectedRevision = flags[index].slice('--expected-revision='.length); flags.splice(index, 1); index -= 1;
    } else if (flags[index]?.startsWith('--replacement-default=')) {
      replacementDefault = flags[index].slice('--replacement-default='.length); flags.splice(index, 1); index -= 1;
    } else if (flags[index] === '--confirm') {
      confirm = true; flags.splice(index, 1); index -= 1;
    } else if (flags[index] === '--purge-orphan-credentials') {
      purgeOrphanCredentials = true; flags.splice(index, 1); index -= 1;
    }
  }
  const knownFlags = new Set(['--purge']);
  const unknown = flags.filter((f) => f.startsWith('--') && !knownFlags.has(f));
  const args = flags.filter((f) => !f.startsWith('--'));
  if (!Number.isInteger(after) || after < 0) unknown.push('--after');
  if (!['compact', 'full'].includes(detail)) unknown.push('--detail');
  return { command: argv[0], purge: flags.includes('--purge'), candidate, after, detail, request, planId, expectedRevision, replacementDefault, confirm, purgeOrphanCredentials, args, unknown };
}

/**
 * CLI dispatcher used by bin/dsh-crew.mjs. Returns a process exit code.
 */
export async function runNpxCli({
  argv = process.argv.slice(2),
  log = console.log,
  error = console.error,
  commands = {},
} = {}) {
  const { command, purge, candidate, after, detail, request, planId, expectedRevision, replacementDefault, confirm, purgeOrphanCredentials, args, unknown } = normalizeCommand(argv);
  if (command === '--help' || command === '-h' || command === 'help') {
    log(USAGE);
    return 0;
  }
  if (!command) {
    error(USAGE);
    return 1;
  }
  if (unknown.length > 0 || !['install', 'integrate', 'detach', 'status', 'inspect', 'jobs', 'providers', 'credentials', 'releases', 'rollback', 'update', 'uninstall'].includes(command)) {
    error(`unknown command: ${command ?? '<none>'}\n\n${USAGE}`);
    return 1;
  }
  try {
    const actions = {
      install: commands.install ?? npxInstall,
      integrate: commands.integrate ?? npxIntegrate,
      detach: commands.detach ?? npxDetach,
      status: commands.status ?? npxStatus,
      inspect: commands.inspect ?? npxInspect,
      jobs: commands.jobs ?? npxJobs,
      providers: commands.providers ?? npxProviders,
      credentials: commands.credentials ?? npxCredentials,
      releases: commands.releases ?? npxReleases,
      rollback: commands.rollback ?? npxRollback,
      update: commands.update ?? npxUpdate,
      uninstall: commands.uninstall ?? npxUninstall,
    };
    let result;
    if (command === 'uninstall') result = await actions.uninstall({ purge, log });
    else if (command === 'update') result = await actions.update({ candidate, log });
    else if (command === 'jobs') result = await actions.jobs({ args, after, detail, request, log });
    else if (command === 'providers') result = await actions.providers({ args, planId, expectedRevision, replacementDefault, confirm, purgeOrphanCredentials, log });
    else if (command === 'credentials') result = await actions.credentials({ args, planId, expectedRevision, confirm, log });
    else if (command === 'releases') result = await actions.releases({ args, log });
    else if (command === 'rollback') result = await actions.rollback({ version: args?.[0], args, log });
    else result = await actions[command]({ log });
    return result?.ok === false ? 1 : 0;
  } catch (err) {
    error(`dsh-crew ${command} failed: ${err?.message ?? err}`);
    return 1;
  }
}
