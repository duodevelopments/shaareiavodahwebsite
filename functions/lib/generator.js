/**
 * Schedule generator.
 *
 * Turns a date range (or a "next week" sunday) into a fully-resolved schedule
 * object — the thing the admin UI renders, the docx/email render from, and
 * D1 persists.
 *
 * Two entry points:
 *   - generateSpan(start, end, rules)   — inclusive range, pure iteration
 *   - planWeekSpan(sunday)              — decides whether the "week" should
 *                                          stretch to cover a nearby holiday
 */

import { buildDayContext } from './zmanim.js';
import { resolveTimes } from './rules-engine.js';

// Bundling threshold: a holiday day within this many days of the current
// span boundary gets pulled into the span. Anything further → separate sheet.
const BUNDLE_THRESHOLD_DAYS = 2;

export const HOLIDAY_TAGS = new Set([
  'yom_tov',
  'chol_hamoed',
  'erev_yom_tov',
  'motzei_yom_tov',
]);

/**
 * Generate a schedule for an inclusive civil-date range.
 *
 * @param {{year:number,month:number,day:number}} start
 * @param {{year:number,month:number,day:number}} end
 * @param {Array} rules
 * @returns {{
 *   startDate: string,
 *   endDate: string,
 *   spanType: 'regular_week'|'holiday_span'|'custom',
 *   label: string|null,
 *   days: Array<{
 *     date: string,
 *     dayOfWeek: string,
 *     hebrew: string,
 *     tags: string[],
 *     season: 'summer'|'winter',
 *     zmanim: object,
 *     times: object,
 *   }>
 * }}
 */
export function generateSpan(start, end, rules) {
  if (compareCivil(start, end) > 0) {
    throw new Error('generator: start date is after end date');
  }
  const days = [];
  let cursor = start;
  while (compareCivil(cursor, end) <= 0) {
    const ctx = buildDayContext(cursor);
    const times = resolveTimes(rules, ctx);
    days.push({
      date: ctx.date,
      dayOfWeek: weekdayName(cursor),
      hebrew: ctx.hebrew.label,
      tags: ctx.dayTags,
      season: ctx.season,
      zmanim: ctx.zmanim,
      parsha: ctx.parsha,
      times,
    });
    cursor = addDays(cursor, 1);
  }
  const spanType = inferSpanType(days);

  // Find the parsha from the first Shabbos in the span (if any).
  const shabbosDay = days.find((d) => d.tags.includes('shabbos'));
  const parsha = shabbosDay?.parsha || null;

  return {
    startDate: days[0].date,
    endDate: days[days.length - 1].date,
    spanType,
    label: inferLabel(days, spanType),
    parsha,
    days,
  };
}

/**
 * Decide what dates this week's schedule should cover.
 *
 * Since the shul has no weekday minyanim, a "normal weekly sheet" is just
 * Fri + Sat (Friday mincha/kabbalas shabbos + Shabbos shacharis/mincha/maariv).
 * The span only grows when a yom tov stretch is within BUNDLE_THRESHOLD_DAYS
 * of that Shabbos — on either side.
 *
 * @param {{year,month,day}} sunday  Any day in the target "week". Canonically
 *        the Sunday that starts it; we derive the Shabbos ourselves.
 */
export function planWeekSpan(sunday) {
  if (weekdayIndex(sunday) !== 0) {
    throw new Error('planWeekSpan: expected a Sunday, got ' + JSON.stringify(sunday));
  }
  // Default span = this week's Friday and Saturday.
  let start = addDays(sunday, 5); // Friday
  let end = addDays(sunday, 6); // Saturday

  // Extend FORWARD from the end, keeping going as long as there's another
  // holiday day within BUNDLE_THRESHOLD_DAYS of the new end. Caps at ~4 weeks
  // so runaway scans can't happen.
  end = walkWhileHolidayNearby(end, +1, 28);
  // Extend BACKWARD similarly. Handles yom tov ending just before Shabbos
  // and, more importantly, chol hamoed / erev yom tov days that should
  // bundle into the preceding Shabbos sheet.
  start = walkWhileHolidayNearby(start, -1, 28);

  return { startDate: start, endDate: end };
}

function walkWhileHolidayNearby(from, direction, maxSteps) {
  let pos = from;
  let stepsTaken = 0;
  while (stepsTaken < maxSteps) {
    // Look up to BUNDLE_THRESHOLD_DAYS in `direction` for a holiday day.
    let jumped = false;
    for (let offset = 1; offset <= BUNDLE_THRESHOLD_DAYS; offset++) {
      const d = addDays(pos, direction * offset);
      if (isHolidayDay(d)) {
        pos = d;
        stepsTaken += offset;
        jumped = true;
        break;
      }
    }
    if (!jumped) return pos;
  }
  return pos;
}

function isHolidayDay(civil) {
  const ctx = buildDayContext(civil);
  return ctx.dayTags.some((t) => HOLIDAY_TAGS.has(t));
}

/**
 * Convenience: plan + generate in one call.
 */
export function generateWeek(sunday, rules) {
  const { startDate, endDate } = planWeekSpan(sunday);
  return generateSpan(startDate, endDate, rules);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferSpanType(days) {
  const touchesHoliday = days.some((d) =>
    d.tags.some((t) => HOLIDAY_TAGS.has(t))
  );
  if (touchesHoliday) return 'holiday_span';
  // Default weekly sheet: just Friday + Saturday of a normal week.
  if (days.length === 2 && days[0].dayOfWeek === 'Friday' && days[1].dayOfWeek === 'Saturday') {
    return 'regular_shabbos';
  }
  return 'custom';
}

function inferLabel(days, spanType) {
  if (spanType === 'regular_week') return null;
  // Pick the "headline" holiday — first yom_tov day's human label.
  const firstYt = days.find((d) => d.tags.includes('yom_tov'));
  if (firstYt) {
    // Try to find a matching Hebcal-style name via the day's tags.
    if (firstYt.tags.includes('pesach_day_1') || firstYt.tags.includes('pesach_day_2'))
      return 'Pesach';
    // Fall back to hebrew label month (crude, good enough for v1).
    return firstYt.hebrew;
  }
  return null;
}

// Civil-date arithmetic (anchored at noon UTC to avoid TZ drift).
function toDate(civil) {
  return new Date(Date.UTC(civil.year, civil.month - 1, civil.day, 12, 0, 0));
}
function fromDate(d) {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
export function addDays(civil, n) {
  const d = toDate(civil);
  d.setUTCDate(d.getUTCDate() + n);
  return fromDate(d);
}
function compareCivil(a, b) {
  return (a.year - b.year) * 10000 + (a.month - b.month) * 100 + (a.day - b.day);
}
function weekdayIndex(civil) {
  return toDate(civil).getUTCDay();
}
function weekdayName(civil) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    weekdayIndex(civil)
  ];
}
