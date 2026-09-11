// Per-model peak/off-peak scheduling.
//
// Some providers price by time of day: DeepSeek charges double during its peak
// hours (UTC 01:00-04:00 and 06:00-10:00, Monday to Friday) and half that
// off-peak. An operator who wants to avoid that spend needs to say which models
// may run during peak, which must not, and which should merely be flagged.
//
// One schedule is shared; the per-model list decides who it applies to. A model
// absent from the list is unrestricted — the feature is opt-in per model, so
// turning it on never silently changes routing for everything at once.
//
// Wall-clock windows are stored in the configured offset, not UTC, so the value
// an operator types is the value they see. The defaults are DeepSeek's published
// peak hours (UTC 01:00-04:00 and 06:00-10:00, Mon-Fri) expressed in the default
// UTC+8: 09:00-12:00 and 14:00-18:00.
//
// This module is pure: no I/O, no ambient clock. Callers pass `at`.

/** Per-model restriction strength. Absent from the list means `off`. */
export const MODEL_SCHEDULE_MODES = Object.freeze(['off', 'warn', 'block']);

/** Peak means "expensive". Off-peak is every hour outside the windows. */
export const DEFAULT_PEAK_WINDOWS = Object.freeze([
  Object.freeze({ start: '09:00', end: '12:00' }),
  Object.freeze({ start: '14:00', end: '18:00' }),
]);

export const DEFAULT_TIMEZONE_OFFSET_MINUTES = 8 * 60;
export const DEFAULT_PEAK_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5]);
export const MINUTES_PER_DAY = 24 * 60;
// A fixed offset is bounded by the real-world range of UTC offsets; anything
// wider is a typo, not a timezone.
const MAX_OFFSET_MINUTES = 14 * 60;

/** "HH:MM" in 24-hour form to minutes past local midnight, or null. */
function clockMinutes(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function offsetMinutes(value, fallback) {
  if (value === undefined || value === null) return fallback;
  // Strict: a partially numeric string ("480garbage") or a float is a broken
  // value, not a request for 480, and must not silently move the clock.
  if (typeof value === 'number' ? !Number.isInteger(value) : !/^-?\d+$/.test(String(value).trim())) return null;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10);
  if (Math.abs(parsed) > MAX_OFFSET_MINUTES) return null;
  return parsed;
}

function weekdayList(value, fallback) {
  if (value === undefined || value === null) return [...fallback];
  // A present-but-unusable container is not a request for Mon-Fri: treating it
  // as one could switch on restrictions the operator never specified.
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
}

function peakWindows(value, fallback) {
  if (value === undefined || value === null) return fallback.map((window) => ({ ...window }));
  if (!Array.isArray(value)) return null;
  const windows = [];
  for (const entry of value) {
    const start = clockMinutes(entry?.start);
    const end = clockMinutes(entry?.end);
    // A window that does not parse is dropped rather than widened to all day.
    if (start === null || end === null || start === end) continue;
    windows.push({ start: entry.start.trim(), end: entry.end.trim() });
  }
  return windows;
}

function modelModes(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const modes = [];
  for (const entry of value) {
    const provider = typeof entry?.provider === 'string' ? entry.provider.trim() : '';
    const model = typeof entry?.model === 'string' ? entry.model.trim() : '';
    const mode = typeof entry?.mode === 'string' ? entry.mode.trim() : '';
    if (!provider || !model || !MODEL_SCHEDULE_MODES.includes(mode)) continue;
    // `off` is the absence of a rule, so it is not stored.
    if (mode === 'off') continue;
    const key = `${provider}\0${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    modes.push({ provider, model, mode });
  }
  return modes;
}

/**
 * Coerce a stored or user-supplied schedule into the canonical shape.
 *
 * Lenient toward *missing* fields, strict toward *broken* ones. A missing field
 * gets its documented default; a field that is present but unusable (a string
 * where a list belongs, a non-integer offset) makes the whole schedule
 * non-restricting instead of substituting defaults. Substituting would let
 * accidental corruption switch on restrictions the operator never asked for.
 */
export function normalizeModelSchedule(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // Keep the per-model rules even when the schedule turns inert: with no windows
  // nothing is ever peak, so the rules cannot fire, and preserving them means a
  // corrupted window does not also destroy the operator's model choices once the
  // coerced config is written back.
  const models = modelModes(source.models);
  const offset = offsetMinutes(source.timezone_offset_minutes, DEFAULT_TIMEZONE_OFFSET_MINUTES);
  const weekdays = weekdayList(source.weekdays, DEFAULT_PEAK_WEEKDAYS);
  const windows = peakWindows(source.peak_windows, DEFAULT_PEAK_WINDOWS);
  if (offset === null || weekdays === null || windows === null) {
    // Fail open by emptying the axis that activates restrictions — weekdays
    // schedule the windows — while keeping every field that still parses. A
    // whole-schedule reset would discard a valid custom offset and windows, and
    // the panel writes the schedule as a whole, so that loss could stick.
    return {
      timezone_offset_minutes: offset === null ? DEFAULT_TIMEZONE_OFFSET_MINUTES : offset,
      weekdays: [],
      peak_windows: windows === null ? [] : windows,
      models,
    };
  }
  return {
    timezone_offset_minutes: offset,
    weekdays,
    peak_windows: windows,
    models,
  };
}

export function defaultModelSchedule() {
  return normalizeModelSchedule({
    timezone_offset_minutes: DEFAULT_TIMEZONE_OFFSET_MINUTES,
    weekdays: [...DEFAULT_PEAK_WEEKDAYS],
    peak_windows: DEFAULT_PEAK_WINDOWS.map((window) => ({ ...window })),
    models: [],
  });
}

/** Local wall clock for an instant under a fixed offset. */
function localParts(at, offset) {
  const shifted = new Date(at.getTime() + offset * 60_000);
  return {
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

function inWindow(minutes, start, end) {
  return start < end
    ? minutes >= start && minutes < end
    // A window crossing midnight runs from `start` on one day to `end` the next.
    : minutes >= start || minutes < end;
}

/**
 * Whether one instant falls in a peak window.
 *
 * A window crossing midnight also belongs to the weekday it starts on, so the
 * early-morning half is checked against the previous day.
 */
export function isPeakAt(schedule, at = new Date()) {
  const normalized = normalizeModelSchedule(schedule);
  if (normalized.weekdays.length === 0) return false;
  const { weekday, minutes } = localParts(at, normalized.timezone_offset_minutes);
  for (const window of normalized.peak_windows) {
    const start = clockMinutes(window.start);
    const end = clockMinutes(window.end);
    if (start === null || end === null) continue;
    if (!inWindow(minutes, start, end)) continue;
    const owner = start < end || minutes >= start ? weekday : (weekday + 6) % 7;
    if (normalized.weekdays.includes(owner)) return true;
  }
  return false;
}

/** The configured mode for one model ref; an unlisted model is unrestricted. */
export function modelScheduleMode(schedule, ref) {
  const provider = typeof ref?.provider === 'string' ? ref.provider.trim() : '';
  const model = typeof ref?.model === 'string' ? ref.model.trim() : '';
  if (!provider || !model) return 'off';
  const entry = normalizeModelSchedule(schedule).models.find(
    (candidate) => candidate.provider === provider && candidate.model === model,
  );
  return entry?.mode ?? 'off';
}

/**
 * Decide whether one model ref is currently peak-restricted.
 *
 * Returns `null` when the model is unrestricted, off-peak, or the schedule is
 * empty; otherwise `{ mode, peak: true }` where `mode` is `warn` or `block`.
 * The caller decides: `block` skips the candidate, `warn` selects it and records
 * the advisory.
 */
export function scheduleAdmission(schedule, ref, at = new Date()) {
  const mode = modelScheduleMode(schedule, ref);
  if (mode === 'off') return null;
  if (!isPeakAt(schedule, at)) return null;
  return { mode, peak: true };
}
