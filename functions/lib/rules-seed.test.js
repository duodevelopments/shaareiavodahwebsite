import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTimes } from './rules-engine.js';
import { seedRules } from './rules-seed.js';

// Shared synthetic zmanim. Realistic-ish for Detroit summer/winter.
const summerZmanim = { shkia: '20:45', tzeis: '21:18', plag: '19:35' };
const winterZmanim = { shkia: '17:10', tzeis: '17:42', plag: '16:02' };

// --- Rule 1 -----------------------------------------------------------------

test('rule 1 (summer): erev shabbos mincha = plag - 15', () => {
  // summerZmanim.plag = 19:35 → mincha 19:20
  const r = resolveTimes(seedRules, {
    dayTags: ['erev_shabbos'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.mincha.time, '19:20');
  assert.equal(r.mincha.source.ruleId, 'mincha-erev-shabbos-summer');
});

test('rule 1 (winter): erev shabbos mincha = shkia - 15', () => {
  // winterZmanim.shkia = 17:10 → mincha 16:55
  const r = resolveTimes(seedRules, {
    dayTags: ['erev_shabbos'],
    season: 'winter',
    zmanim: winterZmanim,
  });
  assert.equal(r.mincha.time, '16:55');
  assert.equal(r.mincha.source.ruleId, 'mincha-erev-shabbos-winter');
});

test('rule 1: erev yom tov mincha = shkia - 15', () => {
  const r = resolveTimes(seedRules, {
    dayTags: ['erev_yom_tov'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.mincha.time, '20:30');
  assert.equal(r.mincha.source.ruleId, 'mincha-erev-yom-tov');
});

// --- Rule 2 -----------------------------------------------------------------

test('rule 2: motzei shabbos maariv = shkia + 55', () => {
  const r = resolveTimes(seedRules, {
    dayTags: ['motzei_shabbos'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.maariv.time, '21:40');
  assert.equal(r.maariv.source.ruleId, 'maariv-motzei-shabbos');
});

test('rule 2: motzei last-day yom tov maariv = shkia + 55', () => {
  const r = resolveTimes(seedRules, {
    dayTags: ['motzei_yom_tov'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.maariv.time, '21:40');
  assert.equal(r.maariv.source.ruleId, 'maariv-motzei-yom-tov');
});

// --- Rule 3 -----------------------------------------------------------------

test('rule 3: yom tov night-entry maariv = tzeis', () => {
  const r = resolveTimes(seedRules, {
    dayTags: ['erev_yom_tov'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.maariv.time, '21:18');
  assert.equal(r.maariv.source.ruleId, 'maariv-erev-yom-tov');
});

// --- Rule 4 -----------------------------------------------------------------

test('rule 4: regular shabbos shacharis = 08:35', () => {
  const r = resolveTimes(seedRules, {
    dayTags: ['shabbos'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.shacharis.time, '08:35');
});

test('rule 4: yom tov shacharis = 08:45 (trumps shabbos when both)', () => {
  const r = resolveTimes(seedRules, {
    dayTags: ['shabbos', 'yom_tov'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.shacharis.time, '08:45');
  assert.equal(r.shacharis.source.ruleId, 'shacharis-yom-tov');
});

test('rule 4: pesach day 1 shacharis = 09:00 (trumps yom tov + shabbos)', () => {
  const r = resolveTimes(seedRules, {
    dayTags: ['shabbos', 'yom_tov', 'pesach_day_1'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.shacharis.time, '09:00');
  assert.equal(r.shacharis.source.ruleId, 'shacharis-pesach-1-2');
});

test('rule 4: pesach day 2 shacharis = 09:00', () => {
  const r = resolveTimes(seedRules, {
    dayTags: ['yom_tov', 'pesach_day_2'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.shacharis.time, '09:00');
});

// --- Rule 5 -----------------------------------------------------------------

test('rule 5: shabbos mincha summer = fixed 18:45', () => {
  const r = resolveTimes(seedRules, {
    dayTags: ['shabbos'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.mincha.time, '18:45');
  assert.equal(r.mincha.source.ruleId, 'mincha-shabbos-summer');
});

test('rule 5: shabbos mincha winter = shkia - 40', () => {
  // shkia 17:10 → mincha 16:30
  const r = resolveTimes(seedRules, {
    dayTags: ['shabbos'],
    season: 'winter',
    zmanim: winterZmanim,
  });
  assert.equal(r.mincha.time, '16:30');
  assert.equal(r.mincha.source.ruleId, 'mincha-shabbos-winter');
});

test('rule 5: yom tov afternoon mincha = shkia - 20 (trumps shabbos mincha when both)', () => {
  // shabbos+yom_tov in summer: yom tov rule wins (priority 20 vs 10)
  // shkia 20:45 → mincha 20:25
  const r = resolveTimes(seedRules, {
    dayTags: ['shabbos', 'yom_tov'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.mincha.time, '20:25');
  assert.equal(r.mincha.source.ruleId, 'mincha-yom-tov');
});

test('rule 5: yom tov afternoon mincha on a weekday yom tov', () => {
  const r = resolveTimes(seedRules, {
    dayTags: ['yom_tov'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.mincha.time, '20:25');
});

// --- Rule 3 priority: first-night Pesach on Motzei Shabbos = tzeis ---------

test('first night Pesach maariv = tzeis even when Erev Pesach is on Shabbos', () => {
  // Scenario: Saturday that is both motzei_shabbos AND erev_yom_tov.
  // maariv-erev-yom-tov (priority 20) beats maariv-motzei-shabbos (priority 10).
  const r = resolveTimes(seedRules, {
    dayTags: ['shabbos', 'motzei_shabbos', 'erev_yom_tov'],
    season: 'winter',
    zmanim: { shkia: '20:11', tzeis: '20:55' },
  });
  assert.equal(r.maariv.time, '20:55');
  assert.equal(r.maariv.source.ruleId, 'maariv-erev-yom-tov');
});

// --- Rule 6: plag maariv on second night of yom tov pair -------------------

test('rule 6: yom_tov_continues day → maariv = plag', () => {
  const r = resolveTimes(seedRules, {
    dayTags: ['sunday', 'yom_tov', 'pesach_day_1', 'yom_tov_continues'],
    season: 'winter',
    zmanim: { shkia: '20:12', tzeis: '20:56', plag: '18:49' },
  });
  assert.equal(r.maariv.time, '18:49');
  assert.equal(r.maariv.source.ruleId, 'maariv-yom-tov-continues');
});

test('rule 6: yom_tov_continues beats motzei_shabbos when 7th day Pesach is on Shabbos', () => {
  // Pesach VII on a Saturday, going into Pesach VIII (still yom tov) →
  // maariv uses plag (second-night rule) not shkia+55 (motzei_shabbos).
  const r = resolveTimes(seedRules, {
    dayTags: ['shabbos', 'motzei_shabbos', 'yom_tov', 'yom_tov_continues'],
    season: 'winter',
    zmanim: { shkia: '20:19', tzeis: '21:03', plag: '18:54' },
  });
  assert.equal(r.maariv.time, '18:54');
  assert.equal(r.maariv.source.ruleId, 'maariv-yom-tov-continues');
});

// --- Composite: full shabbos day -------------------------------------------

test('composite: regular summer shabbos resolves shacharis + mincha together', () => {
  const r = resolveTimes(seedRules, {
    dayTags: ['shabbos'],
    season: 'summer',
    zmanim: summerZmanim,
  });
  assert.equal(r.shacharis.time, '08:35');
  assert.equal(r.mincha.time, '18:45');
  // no motzei_shabbos tag here → no maariv
  assert.equal(r.maariv, undefined);
});
