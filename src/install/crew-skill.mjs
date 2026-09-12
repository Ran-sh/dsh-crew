// On-demand Crew guidance, installed as a user skill.
//
// Crew used to inject a "capability-aware delegation policy" block into the
// host's global instruction file. That made every host session — Codex, ZCode —
// carry Crew's delegation rules whether or not the operator wanted Crew that
// turn, which shapes how the host does its own work.
//
// The guidance now lives in a skill instead, loaded only when the operator asks
// for Crew. Nothing about the host's default behaviour changes; the knowledge is
// there the moment it is wanted.
//
// Each host reads its own skill directory, so the skill is copied to all of them
// — the same layout the Oracle skill uses, plus the shared `~/.agents/skills`
// that ZCode reads. Installing a skill replaces writing a policy block, so the
// host installers also *remove* any block a previous release left behind.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const CREW_SKILL_NAME = 'dsh-crew';

/**
 * Skill roots, in the order they are installed. `.agents/skills` is the shared
 * directory ZCode reads; the other two are what Codex and Claude Code read. The
 * Codex one is resolved through `CODEX_HOME` because Codex may point elsewhere —
// writing only to `~/.codex` would put the skill where Codex never looks.
 */
export function crewSkillRoots({ home = homedir(), env = process.env } = {}) {
  const codexHome = typeof env?.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
    ? resolve(env.CODEX_HOME.trim())
    : join(home, '.codex');
  return [
    join(home, '.agents', 'skills'),
    join(codexHome, 'skills'),
    join(home, '.claude', 'skills'),
  ];
}

export function crewSkillFiles({ home = homedir(), env = process.env } = {}) {
  return crewSkillRoots({ home, env }).map((root) => join(root, CREW_SKILL_NAME, 'SKILL.md'));
}

/** The skill template shipped in the payload. */
export function crewSkillSource({ root }) {
  return join(root, 'skills', CREW_SKILL_NAME, 'SKILL.md');
}

export function readCrewSkill({ root }) {
  const file = crewSkillSource({ root });
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * Copy the skill template into every host skill directory. Idempotent: a file
 * that already matches is left alone, so a repeat install stays quiet.
 */
export function installCrewSkill({ home = homedir(), root, env = process.env } = {}) {
  if (!root) return { ok: false, code: 'CREW_SKILL_SOURCE_REQUIRED' };
  const content = readCrewSkill({ root });
  if (content === null) return { ok: false, code: 'CREW_SKILL_TEMPLATE_MISSING', source: crewSkillSource({ root }) };
  const written = [];
  const files = crewSkillFiles({ home, env });
  for (const file of files) {
    let current = null;
    try { current = readFileSync(file, 'utf8'); } catch { /* absent or unreadable */ }
    if (current === content) continue;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      written.push(file);
    } catch (error) {
      return { ok: false, code: 'CREW_SKILL_WRITE_FAILED', file, error: String(error?.message ?? error) };
    }
  }
  return { ok: true, changed: written.length > 0, written, files, file: files[0] };
}

/**
 * Remove the installed skill from every host directory. Only Crew's own skill
 * folder is touched, so a user's other skills are never affected.
 */
export function removeCrewSkill({ home = homedir(), env = process.env } = {}) {
  const removed = [];
  for (const dir of crewSkillRoots({ home, env }).map((root) => join(root, CREW_SKILL_NAME))) {
    if (!existsSync(dir)) continue;
    try { rmSync(dir, { recursive: true, force: true }); removed.push(dir); }
    catch { /* best effort: a locked file is not worth failing an uninstall */ }
  }
  return { ok: true, changed: removed.length > 0, removed, file: removed[0] ?? null };
}
