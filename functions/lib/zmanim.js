/**
 * Zmanim / calendar wrapper for Shaarei Avodah.
 *
 * Turns a civil date (Detroit time) into the { dayTags, season, zmanim }
 * context object consumed by the rules engine. Everything else in the app
 * (generator, API, UI) should go through `buildDayContext` — never touch
 * @hebcal/core directly.
 */

import { HebrewCalendar, HDate, Location, Zmanim, Sedra, flags, Locale } from '@hebcal/core';

// Shul location — Shaarei Avodah, Detroit metro area.
export const SHUL_LOCATION = new Location(
  42.468793,
  -83.209647,
  false, // not Israel
  'America/Detroit',
  'Shaarei Avodah',
  'US'
);

// Diaspora (chul) — Pesach is 8 days, Shavuos is 2 days, etc.
const IL = false;

/**
 * Main entry point.
 *
 * @param {{year:number, month:number, day:number}} civilDate  Gregorian date,
 *        interpreted as the civil day in Detroit. `month` is 1-based.
 * @returns {{
 *   date: string,           // 'YYYY-MM-DD'
 *   dayTags: string[],
 *   season: 'summer'|'winter',
 *   zmanim: { shkia: string, tzeis: string, hanetz: string },
 *   hebrew: { label: string }  // e.g. "15 Nisan 5785" — for display only
 * }}
 */
export function buildDayContext({ year, month, day }) {
  // Anchor at noon UTC so the same civil date is represented regardless of
  // host timezone. Zmanim uses the location's tzid internally.
  const anchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  const z = new Zmanim(SHUL_LOCATION, anchor, false);
  const zmanim = {
    shkia: formatHM(z.sunset()),
    tzeis: formatHM(z.tzeit()), // 8.5° (3 medium stars) — confirmed by user
    hanetz: formatHM(z.sunrise()),
    plag: formatHM(z.plagHaMincha()),
  };

  const todayEvents = HebrewCalendar.getHolidaysOnDate(anchor, IL) || [];
  const tomorrowAnchor = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0));
  const tomorrowEvents = HebrewCalendar.getHolidaysOnDate(tomorrowAnchor, IL) || [];

  const dayTags = deriveDayTags(anchor, todayEvents, tomorrowEvents);
  const season = computeSeason({ year, month, day });

  const hd = new HDate(anchor);

  // Parsha (only on Shabbos — uses Sedra class, not holidays API).
  let parsha = null;
  if (dayTags.includes('shabbos')) {
    try {
      const sedra = new Sedra(hd.getFullYear(), IL);
      const p = sedra.lookup(hd);
      if (!p.chag) {
        parsha = {
          en: 'Parashat ' + p.parsha.join('-'),
          he: 'פרשת ' + p.parsha.map((n) => Locale.gettext(n, 'he')).join('-'),
        };
      } else {
        // Chag Shabbos — use the chag name instead.
        parsha = {
          en: p.parsha.join(' '),
          he: p.parsha.map((n) => Locale.gettext(n, 'he')).join(' '),
        };
      }
    } catch {
      // Sedra lookup failed — leave null.
    }
  }

  return {
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    dayTags,
    season,
    zmanim,
    hebrew: { label: hd.render('en') },
    parsha,
  };
}

// ---------------------------------------------------------------------------
// Day-tag derivation
// ---------------------------------------------------------------------------

function deriveDayTags(anchor, todayEvents, tomorrowEvents) {
  const tags = new Set();

  // Day of week — use the Detroit-local dow, not UTC dow.
  const dow = localDow(anchor, SHUL_LOCATION.getTzid());
  if (dow === 0) tags.add('sunday');
  else if (dow === 5) {
    tags.add('friday');
    tags.add('erev_shabbos');
  } else if (dow === 6) {
    tags.add('shabbos');
    tags.add('motzei_shabbos'); // evening of the same civil date
  } else {
    tags.add('weekday');
  }

  const isChag = (ev) => (ev.getFlags() & flags.CHAG) !== 0;
  const isEligibleToday = (ev) => !(ev.getFlags() & flags.IL_ONLY);

  // Filter out Israel-only events (we pass il=false already, but belt-and-suspenders).
  const today = todayEvents.filter(isEligibleToday);
  const tomorrow = tomorrowEvents.filter(isEligibleToday);

  const todayIsChag = today.some(isChag);
  const tomorrowIsChag = tomorrow.some(isChag);

  for (const ev of today) {
    const f = ev.getFlags();
    const desc = ev.getDesc();

    if (f & flags.CHAG) tags.add('yom_tov');
    if (f & flags.EREV) {
      // Only count erev-of-a-yom-tov, not erev-of-a-fast.
      if (isErevOfYomTov(desc)) tags.add('erev_yom_tov');
    }
    if (f & flags.ROSH_CHODESH) tags.add('rosh_chodesh');
    if (f & flags.CHOL_HAMOED) tags.add('chol_hamoed');
    if (f & (flags.MAJOR_FAST | flags.MINOR_FAST)) tags.add('fast');

    // Pesach day 1 / 2 (diaspora)
    if (desc === 'Pesach I') tags.add('pesach_day_1');
    if (desc === 'Pesach II') tags.add('pesach_day_2');

    // Shavuos day 1 (diaspora) — needs its own shacharis rule (hanetz - 45).
    if (desc === 'Shavuot I') tags.add('shavuos_day_1');
  }

  // motzei_yom_tov: today is chag, tomorrow is not. Covers end-of-yom-tov going
  // into chol hamoed (Pesach day 2 → day 3) as well as full holiday end
  // (Pesach day 8 → Isru Chag).
  if (todayIsChag && !tomorrowIsChag) tags.add('motzei_yom_tov');

  // yom_tov_continues: today is yom tov AND tomorrow is also yom tov. This
  // is the "second night" of a yom tov pair — e.g., maariv on Pesach I leads
  // into Pesach II, maariv on Pesach VII leads into Pesach VIII. Halachically
  // these maarivs may start earlier (from plag) because the next day is
  // "yom tov sheni" — not the first night of a chag.
  if (todayIsChag && tomorrowIsChag) tags.add('yom_tov_continues');

  return [...tags];
}

function isErevOfYomTov(desc) {
  // Hebcal's erev events: "Erev Pesach", "Erev Sukkot", "Erev Rosh Hashana",
  // "Erev Shavuot", "Erev Yom Kippur", "Erev Simchat Torah", "Erev Shemini Atzeret".
  // (Not "Erev Tish'a B'Av" — that's a fast, we don't want it tagged as erev_yom_tov.)
  return /^Erev (Pesach|Sukkot|Rosh Hashana|Shavuot|Yom Kippur|Simchat Torah|Shemini Atzeret)$/.test(
    desc
  );
}

// ---------------------------------------------------------------------------
// Season
// ---------------------------------------------------------------------------

/**
 * Returns 'summer' or 'winter' for rule-5 selection.
 *
 * - Summer begins the day AFTER the last day of Pesach (23 Nisan).
 * - Summer ends on Rosh Hashanah day 1 (1 Tishrei) — that day is already
 *   winter.
 *
 * Implementation: for the target date D, find the most recent "summer-start"
 * boundary (day after Pesach ends) and the most recent "winter-start" boundary
 * (1 Tishrei / RH day 1), both on-or-before D. Whichever is more recent
 * determines the current season.
 */
export function computeSeason({ year, month, day }) {
  const target = Date.UTC(year, month - 1, day);
  const summerStart = mostRecentSummerStartOnOrBefore(target);
  const winterStart = mostRecentWinterStartOnOrBefore(target);
  if (summerStart == null && winterStart == null) return 'winter';
  if (summerStart == null) return 'winter';
  if (winterStart == null) return 'summer';
  return summerStart > winterStart ? 'summer' : 'winter';
}

function mostRecentSummerStartOnOrBefore(targetUTC) {
  // Try this gregorian year, then previous year.
  for (const y of [new Date(targetUTC).getUTCFullYear(), new Date(targetUTC).getUTCFullYear() - 1]) {
    const ts = dayAfterLastDayOfPesachUTC(y);
    if (ts != null && ts <= targetUTC) return ts;
  }
  return null;
}

function mostRecentWinterStartOnOrBefore(targetUTC) {
  for (const y of [new Date(targetUTC).getUTCFullYear(), new Date(targetUTC).getUTCFullYear() - 1]) {
    const ts = roshHashanahDay1UTC(y);
    if (ts != null && ts <= targetUTC) return ts;
  }
  return null;
}

function dayAfterLastDayOfPesachUTC(gYear) {
  // Last day of Pesach in diaspora = 22 Nisan. Summer starts 23 Nisan.
  const events = HebrewCalendar.calendar({
    year: gYear,
    isHebrewYear: false,
    numYears: 1,
  });
  const pesach1 = events.find((ev) => ev.getDesc() === 'Pesach I');
  if (!pesach1) return null;
  const d = pesach1.getDate().greg();
  // Pesach I is 15 Nisan; 23 Nisan is 8 days later.
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + 8);
}

function roshHashanahDay1UTC(gYear) {
  const events = HebrewCalendar.calendar({
    year: gYear,
    isHebrewYear: false,
    numYears: 1,
  });
  // Desc format is "Rosh Hashana <hebrew year>" (e.g. "Rosh Hashana 5786").
  // Must NOT match "Erev Rosh Hashana" or "Rosh Hashana LaBehemot" / "II".
  const rh = events.find((ev) => /^Rosh Hashana \d+$/.test(ev.getDesc()));
  if (!rh) return null;
  const d = rh.getDate().greg();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHM(date) {
  // Format a Date (instant) as HH:MM in the shul's timezone.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: SHUL_LOCATION.getTzid(),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function localDow(date, tzid) {
  // Returns 0..6 (Sun..Sat) in the given timezone.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    weekday: 'short',
  }).formatToParts(date);
  const w = parts.find((p) => p.type === 'weekday').value;
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
