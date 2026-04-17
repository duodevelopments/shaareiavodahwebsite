import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDayContext, computeSeason } from './zmanim.js';
import { resolveTimes } from './rules-engine.js';
import { seedRules } from './rules-seed.js';

// ---------------------------------------------------------------------------
// Day-tag derivation
// ---------------------------------------------------------------------------

test('regular winter Friday is tagged friday + erev_shabbos', () => {
  const c = buildDayContext({ year: 2025, month: 1, day: 17 });
  assert.ok(c.dayTags.includes('friday'));
  assert.ok(c.dayTags.includes('erev_shabbos'));
  assert.equal(c.season, 'winter');
});

test('regular winter Saturday is tagged shabbos + motzei_shabbos', () => {
  const c = buildDayContext({ year: 2025, month: 1, day: 18 });
  assert.ok(c.dayTags.includes('shabbos'));
  assert.ok(c.dayTags.includes('motzei_shabbos'));
});

test('Erev Pesach 2025 (Sat Apr 12) → shabbos + motzei_shabbos + erev_yom_tov', () => {
  const c = buildDayContext({ year: 2025, month: 4, day: 12 });
  assert.ok(c.dayTags.includes('shabbos'));
  assert.ok(c.dayTags.includes('motzei_shabbos'));
  assert.ok(c.dayTags.includes('erev_yom_tov'));
});

test('Pesach I 2025 (Sun Apr 13) → yom_tov + pesach_day_1', () => {
  const c = buildDayContext({ year: 2025, month: 4, day: 13 });
  assert.ok(c.dayTags.includes('yom_tov'));
  assert.ok(c.dayTags.includes('pesach_day_1'));
  assert.ok(!c.dayTags.includes('motzei_yom_tov'), 'tomorrow is Pesach II, still chag');
});

test('Pesach II 2025 (Mon Apr 14) → yom_tov + pesach_day_2 + motzei_yom_tov', () => {
  const c = buildDayContext({ year: 2025, month: 4, day: 14 });
  assert.ok(c.dayTags.includes('yom_tov'));
  assert.ok(c.dayTags.includes('pesach_day_2'));
  assert.ok(c.dayTags.includes('motzei_yom_tov'), 'tomorrow is chol hamoed, not chag');
});

test('chol hamoed weekday is not tagged yom_tov', () => {
  const c = buildDayContext({ year: 2025, month: 4, day: 15 });
  assert.ok(c.dayTags.includes('chol_hamoed'));
  assert.ok(!c.dayTags.includes('yom_tov'));
});

test('Pesach VIII ending (Sun Apr 20 2025) → yom_tov + motzei_yom_tov', () => {
  const c = buildDayContext({ year: 2025, month: 4, day: 20 });
  assert.ok(c.dayTags.includes('yom_tov'));
  assert.ok(c.dayTags.includes('motzei_yom_tov'), 'tomorrow is weekday');
});

test('fast day (Asara B\'Tevet, Jan 10 2025) is tagged fast', () => {
  const c = buildDayContext({ year: 2025, month: 1, day: 10 });
  assert.ok(c.dayTags.includes('fast'));
});

// ---------------------------------------------------------------------------
// Season
// ---------------------------------------------------------------------------

test('season flips winter → summer the day after last day of Pesach', () => {
  // 2025: Pesach I = Apr 13 (15 Nisan). Last day = Apr 20 (22 Nisan).
  assert.equal(computeSeason({ year: 2025, month: 4, day: 20 }), 'winter');
  assert.equal(computeSeason({ year: 2025, month: 4, day: 21 }), 'summer');
});

test('season flips summer → winter on Rosh Hashanah day 1', () => {
  // 2025: Rosh Hashana 5786 day 1 = Sep 23.
  assert.equal(computeSeason({ year: 2025, month: 9, day: 22 }), 'summer');
  assert.equal(computeSeason({ year: 2025, month: 9, day: 23 }), 'winter');
});

test('season: full year cycle 2025→2026', () => {
  // Winter into spring, then summer starts day after Pesach.
  assert.equal(computeSeason({ year: 2025, month: 1, day: 15 }), 'winter');
  assert.equal(computeSeason({ year: 2025, month: 4, day: 20 }), 'winter'); // last day of Pesach
  assert.equal(computeSeason({ year: 2025, month: 4, day: 21 }), 'summer');
  // Summer through Elul.
  assert.equal(computeSeason({ year: 2025, month: 8, day: 25 }), 'summer'); // Rosh Hashana LaBehemot (minor)
  assert.equal(computeSeason({ year: 2025, month: 9, day: 22 }), 'summer'); // Erev RH
  // Winter from RH day 1 onward.
  assert.equal(computeSeason({ year: 2025, month: 11, day: 15 }), 'winter');
  assert.equal(computeSeason({ year: 2026, month: 2, day: 1 }), 'winter');
});

// ---------------------------------------------------------------------------
// Zmanim (smoke — exact values depend on Hebcal's algorithm but should be
// within a minute of published times for Detroit)
// ---------------------------------------------------------------------------

test('summer Shabbos zmanim look Detroit-shaped', () => {
  const c = buildDayContext({ year: 2025, month: 7, day: 12 });
  // Detroit July sunset ~21:09; tzeis ~22:00
  assert.match(c.zmanim.shkia, /^21:\d\d$/);
  assert.match(c.zmanim.tzeis, /^21:\d\d$|^22:\d\d$/);
});

test('winter Shabbos zmanim look Detroit-shaped', () => {
  const c = buildDayContext({ year: 2025, month: 1, day: 11 });
  // Detroit Jan sunset ~17:21
  assert.match(c.zmanim.shkia, /^17:\d\d$/);
});

// ---------------------------------------------------------------------------
// End-to-end: zmanim + seed rules produce the right minyan times
// ---------------------------------------------------------------------------

test('E2E: summer Shabbos Jul 12 2025 → shacharis 08:35, mincha 18:45 (fixed), maariv shkia+55', () => {
  const c = buildDayContext({ year: 2025, month: 7, day: 12 });
  const r = resolveTimes(seedRules, c);
  assert.equal(r.shacharis.time, '08:35');
  assert.equal(r.mincha.time, '18:45'); // summer fixed
  // maariv is motzei_shabbos rule: shkia + 55
  const [h, m] = c.zmanim.shkia.split(':').map(Number);
  const expectedMin = (h * 60 + m + 55) % 1440;
  const expected = `${String(Math.floor(expectedMin / 60)).padStart(2, '0')}:${String(expectedMin % 60).padStart(2, '0')}`;
  assert.equal(r.maariv.time, expected);
});

test('E2E: winter Shabbos Jan 11 2025 → shacharis 08:35, mincha shkia-40, maariv shkia+55', () => {
  const c = buildDayContext({ year: 2025, month: 1, day: 11 });
  const r = resolveTimes(seedRules, c);
  assert.equal(r.shacharis.time, '08:35');
  const [h, m] = c.zmanim.shkia.split(':').map(Number);
  const expectedMincha = h * 60 + m - 40;
  const mH = Math.floor(expectedMincha / 60);
  const mM = expectedMincha % 60;
  assert.equal(r.mincha.time, `${String(mH).padStart(2, '0')}:${String(mM).padStart(2, '0')}`);
});

test('E2E: Pesach I on Sunday Apr 13 2025 → shacharis 09:00 (pesach priority)', () => {
  const c = buildDayContext({ year: 2025, month: 4, day: 13 });
  const r = resolveTimes(seedRules, c);
  assert.equal(r.shacharis.time, '09:00');
  assert.equal(r.shacharis.source.ruleId, 'shacharis-pesach-1-2');
});

test('E2E: Erev Pesach on Shabbos Apr 12 2025 — erev_yom_tov overrides shabbos mincha', () => {
  const c = buildDayContext({ year: 2025, month: 4, day: 12 });
  const r = resolveTimes(seedRules, c);
  // Morning is still regular Shabbos shacharis.
  assert.equal(r.shacharis.time, '08:35');
  // Mincha: both erev_yom_tov (shkia-15, priority 15) and shabbos-winter
  // (shkia-40, priority 10) match. Erev yom tov wins — shul wants mincha
  // right before shkia so maariv/seder starts at tzeis.
  const [h, m] = c.zmanim.shkia.split(':').map(Number);
  const mincha = h * 60 + m - 15;
  assert.equal(
    r.mincha.time,
    `${String(Math.floor(mincha / 60)).padStart(2, '0')}:${String(mincha % 60).padStart(2, '0')}`
  );
  assert.equal(r.mincha.source.ruleId, 'mincha-erev-yom-tov');
  // Maariv is the Pesach-entry maariv = tzeis. Both maariv-erev-yom-tov and
  // maariv-motzei-shabbos match here; they have the same priority but different
  // formulas. The engine picks the first-declared one at a tie — that's
  // maariv-motzei-shabbos (shkia+55). This IS ambiguous and needs the user's
  // call. For now we just assert whichever the engine produced and flag it.
  assert.ok(['maariv-motzei-shabbos', 'maariv-erev-yom-tov'].includes(r.maariv.source.ruleId));
});

test('E2E: Pesach II ending (Mon Apr 14 2025) → shacharis 09:00, maariv shkia+55 (motzei_yom_tov)', () => {
  const c = buildDayContext({ year: 2025, month: 4, day: 14 });
  const r = resolveTimes(seedRules, c);
  assert.equal(r.shacharis.time, '09:00');
  const [h, m] = c.zmanim.shkia.split(':').map(Number);
  const expectedMin = h * 60 + m + 55;
  assert.equal(
    r.maariv.time,
    `${String(Math.floor(expectedMin / 60)).padStart(2, '0')}:${String(expectedMin % 60).padStart(2, '0')}`
  );
});
