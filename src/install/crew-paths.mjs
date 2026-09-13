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
import { join } from 'node:path';
import { homedir } from 'node:os';

export const CREW_PROFILE_NAME = 'dsh-crew';
export const CREW_HOME_REL = join('.config', 'dsh-crew', 'harness');

export function crewDshHome({ home = homedir() } = {}) {
  return join(home, CREW_HOME_REL);
}

export function crewProfileDir({ home = homedir() } = {}) {
  return join(crewDshHome({ home }), 'profiles', CREW_PROFILE_NAME);
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
