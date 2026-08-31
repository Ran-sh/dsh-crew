export const SETTINGS_SECTION_STORAGE_KEY = 'dsh-crew.settings-sections.v1';

export const SETTINGS_SECTION_IDS = Object.freeze([
  'integrations',
  'workflow',
  'flash',
  'pro',
  'dispatch',
  'adaptive',
  'runtime',
  'multimodal',
  'harnessProviders',
  'providers',
  'jobs',
]);

export function createDefaultSectionState() {
  return Object.fromEntries(SETTINGS_SECTION_IDS.map((id) => [id, id === 'workflow']));
}

export function readSectionState(storage, key = SETTINGS_SECTION_STORAGE_KEY) {
  const defaults = createDefaultSectionState();
  if (!storage?.getItem) return defaults;
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    for (const id of SETTINGS_SECTION_IDS) {
      if (typeof parsed[id] === 'boolean') defaults[id] = parsed[id];
    }
  } catch {
    return defaults;
  }
  return defaults;
}

export function writeSectionState(storage, state, key = SETTINGS_SECTION_STORAGE_KEY) {
  if (!storage?.setItem) return;
  try {
    storage.setItem(key, JSON.stringify(
      Object.fromEntries(SETTINGS_SECTION_IDS.map((id) => [id, state[id] === true])),
    ));
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
  }
}

export function setEverySection(expanded) {
  return Object.fromEntries(SETTINGS_SECTION_IDS.map((id) => [id, expanded === true]));
}

export function openSections(state, ids) {
  const next = { ...state };
  for (const id of ids) {
    if (SETTINGS_SECTION_IDS.includes(id)) next[id] = true;
  }
  return next;
}
