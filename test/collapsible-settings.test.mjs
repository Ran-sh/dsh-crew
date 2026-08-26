import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  SETTINGS_SECTION_IDS,
  createDefaultSectionState,
  readSectionState,
  writeSectionState,
  setEverySection,
  openSections,
} from '../src/client/collapsible-sections.mjs';

const source = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key) => values.get(key),
  };
}

test('settings open only the core workflow by default', () => {
  const state = createDefaultSectionState();
  assert.deepEqual(SETTINGS_SECTION_IDS, [
    'integrations', 'workflow', 'flash', 'pro', 'dispatch', 'adaptive',
    'runtime', 'multimodal', 'providers', 'jobs',
  ]);
  assert.equal(state.workflow, true);
  assert.deepEqual(
    Object.entries(state).filter(([, expanded]) => expanded).map(([id]) => id),
    ['workflow'],
  );
});

test('settings restore only valid persisted section state', () => {
  const storage = memoryStorage({
    'dsh-crew.settings-sections.v1': JSON.stringify({ flash: true, workflow: false, unknown: true, pro: 'yes' }),
  });
  const state = readSectionState(storage);
  assert.equal(state.flash, true);
  assert.equal(state.workflow, false);
  assert.equal(state.pro, false);
  assert.equal('unknown' in state, false);
});

test('malformed persisted state falls back without breaking settings', () => {
  const storage = memoryStorage({ 'dsh-crew.settings-sections.v1': '{not-json' });
  assert.deepEqual(readSectionState(storage), createDefaultSectionState());
  assert.deepEqual(readSectionState(null), createDefaultSectionState());
  assert.deepEqual(readSectionState(memoryStorage({ 'dsh-crew.settings-sections.v1': '[]' })), createDefaultSectionState());
  assert.deepEqual(readSectionState({ getItem: () => { throw new Error('storage locked'); } }), createDefaultSectionState());
});

test('bulk controls and attention events produce complete immutable state', () => {
  const initial = createDefaultSectionState();
  const expanded = setEverySection(true);
  assert.equal(Object.values(expanded).every(Boolean), true);
  assert.equal(Object.values(setEverySection(false)).some(Boolean), false);

  const alerted = openSections(initial, ['providers', 'jobs', 'missing']);
  assert.equal(alerted.providers, true);
  assert.equal(alerted.jobs, true);
  assert.equal(alerted.workflow, true);
  assert.equal(initial.providers, false);
});

test('section state is persisted under the versioned key', () => {
  const storage = memoryStorage();
  const state = setEverySection(true);
  writeSectionState(storage, state);
  assert.deepEqual(JSON.parse(storage.value('dsh-crew.settings-sections.v1')), state);
  assert.doesNotThrow(() => writeSectionState(null, state));
  assert.doesNotThrow(() => writeSectionState({ setItem: () => { throw new Error('quota exceeded'); } }, state));
});

test('settings surface exposes accessible module accordions and bulk controls', () => {
  assert.match(source, /aria-expanded=/);
  assert.match(source, /aria-controls=/);
  assert.match(source, /toggleAllSections/);
  assert.match(source, /sectionSummary/);
  for (const id of SETTINGS_SECTION_IDS) {
    assert.match(source, new RegExp(`sectionId=["']${id}["']`));
  }
});
