/**
 * Shaarei Avodah starter rule set.
 *
 * Day tags expected from the caller (produced by `zmanim.js` at runtime,
 * hand-written in tests):
 *
 *   weekday, sunday, friday,
 *   erev_shabbos, shabbos, motzei_shabbos,
 *   erev_yom_tov, yom_tov, motzei_yom_tov,   (motzei_yom_tov = end of the holiday only,
 *                                             not day-1-to-day-2 transition)
 *   pesach_day_1, pesach_day_2,
 *   rosh_chodesh, chol_hamoed, fast
 *
 * Zmanim keys expected: shkia (sunset), tzeis (nightfall).
 *
 * Priority ladder for shacharis (rule 4): regular Shabbos 10 < Yom Tov 20 <
 * Pesach day 1/2 30. Days that are several of these at once (e.g. Pesach day 1
 * that is also Shabbos) resolve to the highest-priority match.
 */

export const seedRules = [
  // --- Rule 1: Erev Shabbos Mincha --------------------------------------------
  // Summer: 15 minutes before plag hamincha (early-shabbos pattern — maariv /
  // kabbalas shabbos can then begin at plag).
  // Winter: 15 minutes before shkia (plag and shkia are close enough).
  {
    id: 'mincha-erev-shabbos-summer',
    minyan: 'mincha',
    dayTypes: ['erev_shabbos'],
    season: 'summer',
    mode: 'relative',
    value: { zman: 'plag', offsetMin: -15 },
    priority: 10,
  },
  {
    id: 'mincha-erev-shabbos-winter',
    minyan: 'mincha',
    dayTypes: ['erev_shabbos'],
    season: 'winter',
    mode: 'relative',
    value: { zman: 'shkia', offsetMin: -15 },
    priority: 10,
  },
  // Erev Yom Tov Mincha: unchanged — shkia - 15, year-round.
  {
    // Priority 15 (not 10) so that when Erev Pesach/Erev YT falls on Shabbos
    // this beats the regular Shabbos-afternoon rule. In that case the shul
    // davens mincha right before shkia so maariv can be at tzeis for the seder.
    id: 'mincha-erev-yom-tov',
    minyan: 'mincha',
    dayTypes: ['erev_yom_tov'],
    season: 'all',
    mode: 'relative',
    value: { zman: 'shkia', offsetMin: -15 },
    priority: 15,
  },

  // --- Rule 2: Motzei Shabbos / Motzei Yom Tov Maariv = shkia + 55 -----------
  {
    id: 'maariv-motzei-shabbos',
    minyan: 'maariv',
    dayTypes: ['motzei_shabbos'],
    season: 'all',
    mode: 'relative',
    value: { zman: 'shkia', offsetMin: 55 },
    priority: 10,
  },
  {
    id: 'maariv-motzei-yom-tov',
    minyan: 'maariv',
    dayTypes: ['motzei_yom_tov'],
    season: 'all',
    mode: 'relative',
    value: { zman: 'shkia', offsetMin: 55 },
    priority: 10,
  },

  // --- Rule 3: Yom Tov night-entry Maariv = tzeis ----------------------------
  // Priority 20 so that when Erev Pesach falls on motzei Shabbos, the first
  // night of Pesach still resolves to tzeis (user: "maariv the first night
  // of Pesach always has to be at tzeis"), beating maariv-motzei-shabbos.
  {
    id: 'maariv-erev-yom-tov',
    minyan: 'maariv',
    dayTypes: ['erev_yom_tov'],
    season: 'all',
    mode: 'relative',
    value: { zman: 'tzeis', offsetMin: 0 },
    priority: 20,
  },

  // --- Rule 6: Maariv on the 2nd night of a yom tov pair = plag --------------
  // Entering the second day of a yom tov pair (Pesach I→II, Pesach VII→VIII,
  // Sukkos I→II, Shmini Atzeret→Simchas Torah, Rosh Hashana I→II, Shavuos I→II)
  // may start from plag hamincha rather than waiting for tzeis.
  {
    id: 'maariv-yom-tov-continues',
    minyan: 'maariv',
    dayTypes: ['yom_tov_continues'],
    season: 'all',
    mode: 'relative',
    value: { zman: 'plag', offsetMin: 0 },
    priority: 15,
  },

  // --- Rule 4: Shacharis fixed times by day type -----------------------------
  {
    id: 'shacharis-shabbos',
    minyan: 'shacharis',
    dayTypes: ['shabbos'],
    season: 'all',
    mode: 'fixed',
    value: '08:35',
    priority: 10,
  },
  {
    id: 'shacharis-yom-tov',
    minyan: 'shacharis',
    dayTypes: ['yom_tov'],
    season: 'all',
    mode: 'fixed',
    value: '08:45',
    priority: 20,
  },
  {
    id: 'shacharis-pesach-1-2',
    minyan: 'shacharis',
    dayTypes: ['pesach_day_1', 'pesach_day_2'],
    season: 'all',
    mode: 'fixed',
    value: '09:00',
    priority: 30,
  },
  // First day of Shavuos: shacharis davens early, starting from neitz hachama
  // after the tikkun leil all-nighter. 45 minutes before hanetz to allow for
  // korbanos / birchos hashachar before sunrise.
  {
    id: 'shacharis-shavuos-day-1',
    minyan: 'shacharis',
    dayTypes: ['shavuos_day_1'],
    season: 'all',
    mode: 'relative',
    value: { zman: 'hanetz', offsetMin: -45 },
    priority: 30,
  },

  // --- Rule 5: Shabbos / Yom Tov afternoon Mincha ----------------------------
  // "After Pesach" (summer): fixed 18:45. Rest of year (winter): shkia - 40.
  // NOTE: the summer/winter boundary for this rule is Pesach-delimited, not
  // clocks-change. The caller is responsible for picking `season` with the
  // right boundary until we add explicit active_from/active_to date ranges.
  {
    id: 'mincha-shabbos-summer',
    minyan: 'mincha',
    dayTypes: ['shabbos'],
    season: 'summer',
    mode: 'fixed',
    value: '18:45',
    priority: 10,
  },
  {
    id: 'mincha-shabbos-winter',
    minyan: 'mincha',
    dayTypes: ['shabbos'],
    season: 'winter',
    mode: 'relative',
    value: { zman: 'shkia', offsetMin: -40 },
    priority: 10,
  },
  // Yom Tov afternoon mincha: shkia - 20. Higher priority than Shabbos mincha
  // so days that are both shabbos+yom_tov take the yom tov rule.
  {
    id: 'mincha-yom-tov',
    minyan: 'mincha',
    dayTypes: ['yom_tov'],
    season: 'all',
    mode: 'relative',
    value: { zman: 'shkia', offsetMin: -20 },
    priority: 20,
  },
];
