import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPeakAt,
  modelScheduleMode,
  scheduleAdmission,
  normalizeModelSchedule,
  defaultModelSchedule,
  DEFAULT_PEAK_WINDOWS,
  DEFAULT_TIMEZONE_OFFSET_MINUTES,
  DEFAULT_PEAK_WEEKDAYS,
} from '../src/model-schedule.mjs';

const at = (iso) => new Date(iso);
const model = { provider: 'deepseek-official', model: 'deepseek-v4-pro' };

test('the defaults are DeepSeek peak hours expressed in UTC+8', () => {
  const schedule = defaultModelSchedule();
  assert.equal(schedule.timezone_offset_minutes, DEFAULT_TIMEZONE_OFFSET_MINUTES);
  assert.equal(schedule.timezone_offset_minutes, 480, 'UTC+8');
  assert.deepEqual(schedule.weekdays, [...DEFAULT_PEAK_WEEKDAYS]);
  assert.deepEqual(schedule.peak_windows, DEFAULT_PEAK_WINDOWS.map((window) => ({ ...window })));
  assert.deepEqual(schedule.peak_windows, [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ]);
  assert.deepEqual(schedule.models, [], 'no model is restricted until one is named');
});

// DeepSeek publishes peak as UTC 01:00-04:00 and 06:00-10:00, Mon-Fri. Those are
// exactly 09:00-12:00 and 14:00-18:00 at UTC+8, which is what the defaults must
// reproduce or the feature silently bills at the wrong time of day.
test('default windows reproduce the published DeepSeek peak hours', () => {
  const schedule = defaultModelSchedule();
  const peaks = [
    '2026-09-14T01:00:00Z', '2026-09-14T03:59:00Z',   // Mon 09:00-11:59 local
    '2026-09-14T06:00:00Z', '2026-09-14T09:59:00Z',   // Mon 14:00-17:59 local
  ];
  const offPeak = [
    '2026-09-14T04:00:00Z',                            // Mon 12:00 local, window end
    '2026-09-14T10:00:00Z',                            // Mon 18:00 local, window end
    '2026-09-14T00:59:00Z',                            // Mon 08:59 local, before window
    '2026-09-19T02:00:00Z',                            // Saturday
    '2026-09-20T02:00:00Z',                            // Sunday
  ];
  for (const iso of peaks) assert.equal(isPeakAt(schedule, at(iso)), true, `${iso} must be peak`);
  for (const iso of offPeak) assert.equal(isPeakAt(schedule, at(iso)), false, `${iso} must be off-peak`);
});

test('a window boundary is half-open: the start is peak, the end is not', () => {
  const schedule = normalizeModelSchedule({
    timezone_offset_minutes: 0,
    weekdays: [1],
    peak_windows: [{ start: '09:00', end: '12:00' }],
  });
  assert.equal(isPeakAt(schedule, at('2026-09-14T09:00:00Z')), true);
  assert.equal(isPeakAt(schedule, at('2026-09-14T11:59:00Z')), true);
  assert.equal(isPeakAt(schedule, at('2026-09-14T12:00:00Z')), false);
});

test('a window crossing midnight belongs to the weekday it starts on', () => {
  const schedule = normalizeModelSchedule({
    timezone_offset_minutes: 0,
    weekdays: [1], // Monday only
    peak_windows: [{ start: '22:00', end: '02:00' }],
  });
  assert.equal(isPeakAt(schedule, at('2026-09-14T22:30:00Z')), true, 'Monday evening');
  assert.equal(isPeakAt(schedule, at('2026-09-15T01:00:00Z')), true, 'Tuesday early hours still belong to Monday');
  assert.equal(isPeakAt(schedule, at('2026-09-16T01:00:00Z')), false, 'Wednesday early hours belong to Tuesday');
});

test('an empty weekday set never reports peak', () => {
  const schedule = normalizeModelSchedule({ weekdays: [], peak_windows: [{ start: '00:00', end: '23:59' }] });
  assert.deepEqual(schedule.weekdays, []);
  assert.equal(isPeakAt(schedule, at('2026-09-14T02:00:00Z')), false);
});

test('only listed models are restricted, and per model', () => {
  const schedule = normalizeModelSchedule({
    models: [
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', mode: 'block' },
      { provider: 'deepseek-official', model: 'deepseek-flash', mode: 'warn' },
    ],
  });
  assert.equal(modelScheduleMode(schedule, model), 'block');
  assert.equal(modelScheduleMode(schedule, { provider: 'deepseek-official', model: 'deepseek-flash' }), 'warn');
  assert.equal(modelScheduleMode(schedule, { provider: 'deepseek-official', model: 'v41-flash' }), 'off');
  assert.equal(modelScheduleMode(schedule, { provider: 'commandcode', model: 'deepseek-v4-pro' }), 'off', 'keyed by provider too');
});

test('admission separates block from warn and ignores off-peak and unlisted models', () => {
  const schedule = normalizeModelSchedule({
    models: [
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', mode: 'block' },
      { provider: 'deepseek-official', model: 'deepseek-flash', mode: 'warn' },
    ],
  });
  const peak = at('2026-09-14T02:00:00Z');   // Mon 10:00 local
  const off = at('2026-09-14T11:00:00Z');    // Mon 19:00 local
  assert.deepEqual(scheduleAdmission(schedule, model, peak), { mode: 'block', peak: true });
  assert.deepEqual(scheduleAdmission(schedule, { provider: 'deepseek-official', model: 'deepseek-flash' }, peak), { mode: 'warn', peak: true });
  assert.equal(scheduleAdmission(schedule, { provider: 'deepseek-official', model: 'v41-flash' }, peak), null);
  assert.equal(scheduleAdmission(schedule, model, off), null, 'off-peak admits every model');
});

test("mode 'off' is the absence of a rule and is never stored", () => {
  const schedule = normalizeModelSchedule({
    models: [
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', mode: 'off' },
      { provider: 'deepseek-official', model: 'deepseek-flash', mode: 'block' },
    ],
  });
  assert.deepEqual(schedule.models, [{ provider: 'deepseek-official', model: 'deepseek-flash', mode: 'block' }]);
  assert.equal(modelScheduleMode(schedule, model), 'off');
});

test('malformed entries inside a valid container are dropped, not widened', () => {
  const schedule = normalizeModelSchedule({
    timezone_offset_minutes: null, // absent, so the default applies
    peak_windows: [{ start: 'nope', end: '10:00' }, { start: '01:00', end: '05:00' }, { start: '07:00', end: '07:00' }],
    weekdays: [1, 1, 9, -1, 3],
    models: [{ provider: '', model: 'x', mode: 'block' }, { provider: 'p', model: 'm', mode: 'nope' }, { provider: 'p', model: 'm', mode: 'block' }],
  });
  assert.equal(schedule.timezone_offset_minutes, DEFAULT_TIMEZONE_OFFSET_MINUTES);
  assert.deepEqual(schedule.peak_windows, [{ start: '01:00', end: '05:00' }], 'unparseable and zero-length windows are dropped');
  assert.deepEqual(schedule.weekdays, [1, 3], 'duplicates and out-of-range days are dropped');
  assert.deepEqual(schedule.models, [{ provider: 'p', model: 'm', mode: 'block' }]);
});

// The failure direction matters: substituting defaults for a *broken* field
// would switch on restrictions the operator never asked for, so a present but
// unusable container makes the schedule non-restricting instead.
test('a present but unusable container fails open rather than to the defaults', () => {
  const restrictive = [{ provider: 'p', model: 'm', mode: 'block' }];
  for (const bad of [
    { peak_windows: 'corrupt', models: restrictive },
    { weekdays: 'corrupt', models: restrictive },
    { timezone_offset_minutes: '480garbage', models: restrictive },
    { timezone_offset_minutes: 480.9, models: restrictive },
    { timezone_offset_minutes: 99_99, models: restrictive },
  ]) {
    const schedule = normalizeModelSchedule({ ...bad, models: restrictive });
    assert.deepEqual(schedule.weekdays, [], `must not restrict on ${JSON.stringify(bad)}`);
    assert.deepEqual(schedule.peak_windows, []);
    assert.equal(isPeakAt(schedule, at('2026-09-14T02:00:00Z')), false, 'corruption must never activate a window');
    assert.equal(scheduleAdmission(schedule, { provider: 'p', model: 'm' }, at('2026-09-14T02:00:00Z')), null);
    // The rule itself survives: with no windows nothing can be peak, and keeping
    // it means a corrupted window does not also erase the operator's choices.
    assert.deepEqual(schedule.models, restrictive, 'the per-model rules must not be destroyed');
  }
});

test('a missing field still receives its documented default', () => {
  const schedule = normalizeModelSchedule({ models: [] });
  assert.equal(schedule.timezone_offset_minutes, DEFAULT_TIMEZONE_OFFSET_MINUTES);
  assert.deepEqual(schedule.weekdays, [...DEFAULT_PEAK_WEEKDAYS]);
  assert.deepEqual(schedule.peak_windows, DEFAULT_PEAK_WINDOWS.map((window) => ({ ...window })));
});

test('a non-object schedule normalizes to the defaults', () => {
  for (const raw of [null, undefined, 'nope', 42, []]) {
    assert.deepEqual(normalizeModelSchedule(raw), defaultModelSchedule(), `raw=${JSON.stringify(raw)}`);
  }
});
