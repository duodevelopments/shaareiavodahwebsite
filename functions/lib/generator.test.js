import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSpan, planWeekSpan, generateWeek, addDays } from './generator.js';
import { seedRules } from './rules-seed.js';

// ---------------------------------------------------------------------------
// generateSpan — basic iteration + output shape
// ---------------------------------------------------------------------------

test('generateSpan iterates inclusive range and labels days correctly', () => {
  const out = generateSpan(
    { year: 2025, month: 1, day: 10 },
    { year: 2025, month: 1, day: 11 },
    seedRules
  );
  assert.equal(out.days.length, 2);
  assert.equal(out.startDate, '2025-01-10');
  assert.equal(out.endDate, '2025-01-11');
  assert.equal(out.days[0].dayOfWeek, 'Friday');
  assert.equal(out.days[1].dayOfWeek, 'Saturday');
  assert.equal(out.spanType, 'regular_shabbos');
  assert.equal(out.label, null);
});

test('generateSpan attaches zmanim + resolved times to each day', () => {
  const out = generateSpan(
    { year: 2025, month: 7, day: 12 },
    { year: 2025, month: 7, day: 12 },
    seedRules
  );
  const sat = out.days[0];
  assert.match(sat.zmanim.shkia, /^\d\d:\d\d$/);
  assert.equal(sat.times.shacharis.time, '08:35');
  assert.equal(sat.times.mincha.time, '18:45'); // summer fixed
  assert.equal(sat.season, 'summer');
});

test('generateSpan throws if start > end', () => {
  assert.throws(() =>
    generateSpan(
      { year: 2025, month: 4, day: 15 },
      { year: 2025, month: 4, day: 10 },
      seedRules
    )
  );
});

// ---------------------------------------------------------------------------
// planWeekSpan — span reshaping around holidays
// ---------------------------------------------------------------------------

test('planWeekSpan: regular winter week → default Fri+Sat, 2 days', () => {
  const plan = planWeekSpan({ year: 2025, month: 1, day: 5 });
  assert.deepEqual(plan.startDate, { year: 2025, month: 1, day: 10 }); // Friday
  assert.deepEqual(plan.endDate, { year: 2025, month: 1, day: 11 }); // Saturday
});

test('planWeekSpan: regular summer week → default Fri+Sat', () => {
  const plan = planWeekSpan({ year: 2025, month: 7, day: 6 });
  assert.deepEqual(plan.startDate, { year: 2025, month: 7, day: 11 });
  assert.deepEqual(plan.endDate, { year: 2025, month: 7, day: 12 });
});

test('planWeekSpan: week of Pesach I → extends back to Shabbos Erev Pesach and forward to Pesach VIII', () => {
  // Sunday Apr 13 2025 is Pesach I. Backward walk from Friday Apr 18 reaches
  // all the way to Shabbos Erev Pesach (Apr 12) through chol hamoed chain.
  // Forward walk from Saturday Apr 19 reaches Sunday Apr 20 (Pesach VIII).
  const plan = planWeekSpan({ year: 2025, month: 4, day: 13 });
  assert.deepEqual(plan.startDate, { year: 2025, month: 4, day: 12 });
  assert.deepEqual(plan.endDate, { year: 2025, month: 4, day: 20 });
});

test('planWeekSpan: week before Pesach (Shabbos is Erev Pesach) → Fri..Pesach VIII', () => {
  // Sunday Apr 6. Shabbos Apr 12 is Erev Pesach. Forward extension from Apr 12
  // pulls in the whole Pesach stretch.
  const plan = planWeekSpan({ year: 2025, month: 4, day: 6 });
  assert.deepEqual(plan.startDate, { year: 2025, month: 4, day: 11 }); // Friday
  assert.deepEqual(plan.endDate, { year: 2025, month: 4, day: 20 });
});

test('planWeekSpan: week AFTER Pesach is a separate sheet (default Fri+Sat)', () => {
  const plan = planWeekSpan({ year: 2025, month: 4, day: 20 });
  assert.deepEqual(plan.startDate, { year: 2025, month: 4, day: 25 });
  assert.deepEqual(plan.endDate, { year: 2025, month: 4, day: 26 });
});

test('planWeekSpan: Shavuos 2025 (Mon-Tue Jun 2-3) bundles with the preceding Shabbos', () => {
  // Sunday May 25. Shabbos May 31. Sun Jun 1 = erev_yom_tov. Bundling
  // threshold = 2 days, so forward walk from Sat May 31 reaches Sun Jun 1
  // (offset 1) → Mon Jun 2 (yom_tov) → Tue Jun 3 (yom_tov) → Wed Jun 4 weekday → stop.
  const plan = planWeekSpan({ year: 2025, month: 5, day: 25 });
  assert.deepEqual(plan.startDate, { year: 2025, month: 5, day: 30 }); // Friday
  assert.deepEqual(plan.endDate, { year: 2025, month: 6, day: 3 }); // Shavuos II
});

test('planWeekSpan: week AFTER Shavuos is separate (>2 days away)', () => {
  // Sunday Jun 1 2025 — technically Erev Shavuos, but the Shabbos of that
  // week (Jun 7) is 4 days past Shavuos II (Jun 3). Not bundled.
  const plan = planWeekSpan({ year: 2025, month: 6, day: 1 });
  assert.deepEqual(plan.startDate, { year: 2025, month: 6, day: 6 });
  assert.deepEqual(plan.endDate, { year: 2025, month: 6, day: 7 });
});

test('planWeekSpan: rejects non-Sunday start', () => {
  assert.throws(() => planWeekSpan({ year: 2025, month: 1, day: 6 }));
});

// ---------------------------------------------------------------------------
// generateWeek — integration
// ---------------------------------------------------------------------------

test('generateWeek: Pesach week produces holiday_span labeled "Pesach"', () => {
  const out = generateWeek({ year: 2025, month: 4, day: 13 }, seedRules);
  assert.equal(out.spanType, 'holiday_span');
  assert.equal(out.label, 'Pesach');
  assert.equal(out.days.length, 9);

  // First day of the span is Shabbos Erev Pesach.
  assert.equal(out.days[0].date, '2025-04-12');
  // Pesach I morning: shacharis 09:00
  const pesach1 = out.days.find((d) => d.date === '2025-04-13');
  assert.equal(pesach1.times.shacharis.time, '09:00');
  // 7th day of Pesach (Apr 19) is a Saturday that's also yom_tov → 08:45
  const day7 = out.days.find((d) => d.date === '2025-04-19');
  assert.equal(day7.times.shacharis.time, '08:45');
});

test('generateWeek: regular summer week → regular_shabbos, no label, 2 days', () => {
  const out = generateWeek({ year: 2025, month: 7, day: 6 }, seedRules);
  assert.equal(out.spanType, 'regular_shabbos');
  assert.equal(out.label, null);
  assert.equal(out.days.length, 2);
});

// ---------------------------------------------------------------------------
// addDays helper
// ---------------------------------------------------------------------------

test('addDays crosses month and year boundaries correctly', () => {
  assert.deepEqual(addDays({ year: 2025, month: 1, day: 30 }, 3), {
    year: 2025,
    month: 2,
    day: 2,
  });
  assert.deepEqual(addDays({ year: 2025, month: 12, day: 31 }, 1), {
    year: 2026,
    month: 1,
    day: 1,
  });
  assert.deepEqual(addDays({ year: 2025, month: 3, day: 1 }, -1), {
    year: 2025,
    month: 2,
    day: 28,
  });
});
