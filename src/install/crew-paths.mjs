// Where the Crew-owned Harness profile lives, and where the registration link
// that the host integrations point at is rooted.
//
// This is its own module because two layers must agree about it and neither may
// import the other: the installers write host integrations against the loader
// link, and the readiness checks decide whether those integrations are correct.
// When readiness derived its expected paths from the release directory instead,
// every correctly installed machine read as needing repair — the installer and
// the check disagreed about what "the installed server" is, and only the
// installer was right.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const CREW_PROFILE_NAME = 'dsh-crew';
export const CREW_HOME_REL = join('.config', 'dsh-crew', 'harness');

/**
 * The Harness session store, as a POSIX path relative to the Crew root (the
 * parent of the Harness home).
 *
 * Two very different readers need this fact in different shapes: `archive-store`
 * walks it relative to the Crew root to prove a session artifact is really gone
 * before history is deleted, and it also compiles the artifact path into a
 * regular expression, while `crewHarnessSessionsDir` resolves it to an absolute
 * path for the reviewer's evidence pointer. It is one literal here so those can
 * not drift apart — a divergence would either mis-target a deletion or hand a
 * reviewer a path that does not exist.
 */
export const CREW_SESSIONS_REL = 'harness/sessions';

export function crewDshHome({ home = homedir() } = {}) {
  return join(home, CREW_HOME_REL);
}

export function crewProfileDir({ home = homedir() } = {}) {
  return join(crewDshHome({ home }), 'profiles', CREW_PROFILE_NAME);
}

/**
 * Where the Harness persists its session records (`harness/sessions`).
 *
 * This is the only durable record of what an attempt actually executed: the
 * `tool/result` entries carry the exact file contents a `write` produced and the
 * captured stdout, stderr and exit code of every command. A reviewer that has to
 * judge a transient change — work that was created, run and then removed before
 * the review started — has nothing left in the workspace to inspect, so this is
 * the evidence it must read instead of trusting the worker's summary of it.
 */
export function crewHarnessSessionsDir({ home = homedir() } = {}) {
  return join(dirname(crewDshHome({ home })), CREW_SESSIONS_REL);
}

// The profile's `node_modules/<name>` entry for the installed package. The
// registration points this at the live release, so it is stable across
// upgrades while the release path underneath it is not.
export function loaderLinkPath({ home = homedir(), name } = {}) {
  if (typeof name !== 'string' || name.trim() === '') return null;
  return join(crewProfileDir({ home }), 'node_modules', ...name.split('/'));
}

function sameDirectory(left, right) {
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}

/**
 * The root the host integrations were installed from.
 *
 * Readiness must judge the integrations against the path they were actually
 * written with. That path is the loader link when it resolves to this release,
 * and the release directory itself otherwise — a machine whose link is missing
 * or points somewhere else is reported against the release, which is exactly
 * the mismatch the operator needs to see.
 */
export function integrationRoot({ home = homedir(), root, name } = {}) {
  const link = loaderLinkPath({ home, name });
  if (!link || !root || !existsSync(link)) return root;
  return sameDirectory(link, root) ? link : root;
}
