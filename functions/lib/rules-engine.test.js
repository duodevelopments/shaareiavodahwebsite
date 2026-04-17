import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTimes } from './rules-engine.js';

const baseRules = [
  {
    id: 'shacharis-weekday',
    minyan: 'shacharis',
    dayTypes: ['weekday'],
    season: 'all',
    mode: 'fixed',
    value: '06:45',
    priority: 10,
  },
  {
    id: 'shacharis-sunday',
    minyan: 'shacharis',
    dayTypes: ['sunday'],
    season: 'all',
    mode: 'fixed',
    value: '08:00',
    priority: 10,
  },
  {
    id: 'shacharis-shabbos',
    minyan: 'shacharis',
    dayTypes: ['shabbos'],
    season: 'all',
    mode: 'fixed',
    value: '09:00',
    priority: 10,
  },
  {
    id: 'shacharis-rosh-chodesh',
    minyan: 'shacharis',
    dayTypes: ['rosh_chodesh'],
    season: 'all',
    mode: 'fixed',
    value: '06:30',
    priority: 20,
  },
  {
    id: 'mincha-summer',
    minyan: 'mincha',
    dayTypes: ['weekday', 'sunday', 'friday'],
    season: 'summer',
    mode: 'relative',
    value: { zman: 'shkia', offsetMin: -15, round: 5 },
    priority: 10,
  },
  {
    id: 'mincha-winter',
    minyan: 'mincha',
    dayTypes: ['weekday', 'sunday', 'friday'],
    season: 'winter',
    mode: 'fixed',
    value: '16:15',
    priority: 10,
  },
  {
    id: 'maariv-weekday',
    minyan: 'maariv',
    dayTypes: ['weekday'],
    season: 'all',
    mode: 'relative',
    value: { zman: 'shkia', offsetMin: 42, round: 0 },
    priority: 10,
  },
];

test('summer weekday: fixed shacharis + relative mincha rounded down to 5', () => {
  // shkia 20:32 → mincha 20:32 - 15 = 20:17 → round-to-5 → 20:15
  // maariv 20:32 + 42 = 21:14
  const result = resolveTimes(baseRules, {
    dayTags: ['weekday'],
    season: 'summer',
    zmanim: { shkia: '20:32' },
  });
  assert.equal(result.shacharis.time, '06:45');
  assert.equal(result.shacharis.source.ruleId, 'shacharis-weekday');
  assert.equal(result.mincha.time, '20:15');
  assert.equal(result.maariv.time, '21:14');
});

test('winter weekday: mincha falls back to fixed 16:15 regardless of shkia', () => {
  const result = resolveTimes(baseRules, {
    dayTags: ['weekday'],
    season: 'winter',
    zmanim: { shkia: '17:10' },
  });
  assert.equal(result.mincha.time, '16:15');
  assert.equal(result.mincha.source.ruleId, 'mincha-winter');
});

test('rosh chodesh overrides weekday shacharis by priority', () => {
  const result = resolveTimes(baseRules, {
    dayTags: ['weekday', 'rosh_chodesh'],
    season: 'summer',
    zmanim: { shkia: '20:32' },
  });
  assert.equal(result.shacharis.time, '06:30');
  assert.equal(result.shacharis.source.ruleId, 'shacharis-rosh-chodesh');
});

test('sunday uses the sunday rule even though weekday rule could technically match neither', () => {
  const result = resolveTimes(baseRules, {
    dayTags: ['sunday'],
    season: 'summer',
    zmanim: { shkia: '20:30' },
  });
  assert.equal(result.shacharis.time, '08:00');
  assert.equal(result.shacharis.source.ruleId, 'shacharis-sunday');
});

test('shabbos uses the shabbos rule', () => {
  const result = resolveTimes(baseRules, {
    dayTags: ['shabbos'],
    season: 'summer',
    zmanim: { shkia: '20:30' },
  });
  assert.equal(result.shacharis.time, '09:00');
});

test('missing zman surfaces a clear error naming the rule', () => {
  const rules = [
    {
      id: 'needs-shkia',
      minyan: 'mincha',
      dayTypes: ['weekday'],
      season: 'all',
      mode: 'relative',
      value: { zman: 'shkia', offsetMin: -15, round: 5 },
      priority: 10,
    },
  ];
  assert.throws(
    () =>
      resolveTimes(rules, {
        dayTags: ['weekday'],
        season: 'summer',
        zmanim: {},
      }),
    /needs-shkia/
  );
});

test('rounding handles midnight wraparound without going negative', () => {
  const rules = [
    {
      id: 'wrap',
      minyan: 'maariv',
      dayTypes: ['weekday'],
      season: 'all',
      mode: 'relative',
      value: { zman: 'shkia', offsetMin: 90, round: 0 },
      priority: 10,
    },
  ];
  // 23:30 + 90 = 25:00 → wraps to 01:00 next day
  const r = resolveTimes(rules, {
    dayTags: ['weekday'],
    season: 'summer',
    zmanim: { shkia: '23:30' },
  });
  assert.equal(r.maariv.time, '01:00');
});

test('round: 5 rounds to nearest 5-minute boundary (up and down)', () => {
  const rules = [
    {
      id: 'rup',
      minyan: 'mincha',
      dayTypes: ['weekday'],
      season: 'all',
      mode: 'relative',
      value: { zman: 'shkia', offsetMin: 0, round: 5 },
      priority: 10,
    },
  ];
  // 20:18 → 20:20 (18 rounds up)
  assert.equal(
    resolveTimes(rules, { dayTags: ['weekday'], season: 'summer', zmanim: { shkia: '20:18' } }).mincha.time,
    '20:20'
  );
  // 20:17 → 20:15 (17 rounds down)
  assert.equal(
    resolveTimes(rules, { dayTags: ['weekday'], season: 'summer', zmanim: { shkia: '20:17' } }).mincha.time,
    '20:15'
  );
});

test('minyan with no matching rule is simply omitted from the output', () => {
  const result = resolveTimes(baseRules, {
    dayTags: ['shabbos'],
    season: 'summer',
    zmanim: { shkia: '20:30' },
  });
  // baseRules has no shabbos mincha rule, so mincha should not appear
  assert.equal(result.mincha, undefined);
  assert.equal(result.shacharis.time, '09:00');
});
