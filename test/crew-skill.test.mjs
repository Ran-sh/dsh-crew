import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CREW_SKILL_NAME,
  crewSkillFiles,
  crewSkillRoots,
  installCrewSkill,
  readCrewSkill,
  removeCrewSkill,
} from '../src/install/crew-skill.mjs';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-crew-skill-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

// The guidance used to be a policy block written into each host's global
// instruction file, which shaped every session whether or not Crew was wanted.
// It is a skill now, so it loads only when the operator asks for it.
test('the template declares itself on-demand', () => {
  const content = readCrewSkill({ root: ROOT });
  assert.ok(content, 'the payload must ship the skill template');
  assert.match(content, /^---\nname: dsh-crew\n/);
  assert.match(content, /description:.*asks to use dsh-crew/);
  assert.match(content, /On demand only/);
});

// Each host reads its own skill directory, so the skill goes to all of them.
test('the skill is installed for every host, including a redirected CODEX_HOME', (t) => {
  const home = fixture(t);
  const codexHome = join(home, 'elsewhere', 'codex');
  const env = { CODEX_HOME: codexHome };
  const result = installCrewSkill({ home, root: ROOT, env });
  assert.equal(result.ok, true);
  const expected = readCrewSkill({ root: ROOT });
  for (const file of crewSkillFiles({ home, env })) {
    assert.equal(existsSync(file), true, `${file} must exist`);
    assert.equal(readFileSync(file, 'utf8'), expected);
  }
  // Codex may point its home elsewhere; writing only to ~/.codex would put the
  // skill where Codex never looks.
  assert.equal(existsSync(join(codexHome, 'skills', CREW_SKILL_NAME, 'SKILL.md')), true);
  assert.equal(existsSync(join(home, '.codex', 'skills', CREW_SKILL_NAME, 'SKILL.md')), false);
});

test('an unset or blank CODEX_HOME falls back to ~/.codex', (t) => {
  const home = fixture(t);
  for (const env of [{}, { CODEX_HOME: '' }, { CODEX_HOME: '   ' }]) {
    assert.deepEqual(crewSkillRoots({ home, env }), [
      join(home, '.agents', 'skills'),
      join(home, '.codex', 'skills'),
      join(home, '.claude', 'skills'),
    ]);
  }
});

test('reinstalling an unchanged skill writes nothing', (t) => {
  const home = fixture(t);
  const first = installCrewSkill({ home, root: ROOT, env: {} });
  assert.equal(first.changed, true);
  const second = installCrewSkill({ home, root: ROOT, env: {} });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false, 'a repeat install must not rewrite');
  assert.deepEqual(second.written, []);
});

test('a drifted copy is restored', (t) => {
  const home = fixture(t);
  const env = {};
  installCrewSkill({ home, root: ROOT, env });
  const [first] = crewSkillFiles({ home, env });
  writeFileSync(first, '# edited by hand\n');
  const again = installCrewSkill({ home, root: ROOT, env });
  assert.equal(again.changed, true);
  assert.equal(readFileSync(first, 'utf8'), readCrewSkill({ root: ROOT }));
});

test('removal takes only Crew’s own skill directory', (t) => {
  const home = fixture(t);
  const env = {};
  installCrewSkill({ home, root: ROOT, env });
  const neighbour = join(home, '.agents', 'skills', 'someone-else', 'SKILL.md');
  mkdirSync(join(home, '.agents', 'skills', 'someone-else'), { recursive: true });
  writeFileSync(neighbour, '# not ours\n');

  const removed = removeCrewSkill({ home, env });
  assert.equal(removed.changed, true);
  assert.equal(removed.removed.length, 3);
  for (const file of crewSkillFiles({ home, env })) assert.equal(existsSync(file), false);
  assert.equal(existsSync(neighbour), true, 'another skill is untouched');
});

test('a missing template fails closed rather than writing nothing quietly', (t) => {
  const home = fixture(t);
  const result = installCrewSkill({ home, root: join(home, 'no-such-payload'), env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CREW_SKILL_TEMPLATE_MISSING');
});
