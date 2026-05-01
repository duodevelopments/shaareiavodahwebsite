import {
  generateSpan,
  planWeekSpan,
  addDays,
  HOLIDAY_TAGS,
} from '../../../lib/generator.js';
import { seedRules } from '../../../lib/rules-seed.js';
import { buildDayContext } from '../../../lib/zmanim.js';
import { cacheKey } from '../../../lib/pdf-cache.js';

const DEFAULT_WEEKS = 10;
const MAX_WEEKS = 26;

/**
 * GET /api/admin/schedules/cache-status?sunday=YYYY-MM-DD&weeks=10
 *
 * For the next N spans (regular weeks + orphan Yom Tov), returns whether
 * each one's PDF currently exists in R2 at its content-addressed key.
 *
 *   { spans: [{ startDate, endDate, cacheKey, exists }] }
 *
 * The browser pre-render hook reads this and renders only the missing ones.
 * CPU-light: D1 reads + per-span hash + R2 head — all I/O, no rendering.
 */
export async function onRequestGet(context) {
  try {
    return await handle(context);
  } catch (err) {
    return jsonResp({ error: err?.message || String(err) }, 500);
  }
}

async function handle(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const sundayParam = url.searchParams.get('sunday');
  const weeksParam = url.searchParams.get('weeks');

  if (!sundayParam || !/^\d{4}-\d{2}-\d{2}$/.test(sundayParam)) {
    return jsonResp({ error: 'Missing or invalid sunday' }, 400);
  }
  const weeks = clampInt(weeksParam, DEFAULT_WEEKS, 1, MAX_WEEKS);

  const startCivil = parseISO(sundayParam);
  if (toDate(startCivil).getUTCDay() !== 0) {
    return jsonResp({ error: 'sunday must be a Sunday' }, 400);
  }
  const windowEndCivil = addDays(startCivil, weeks * 7 - 1);

  // 1. Plan regular weekly spans, skipping Sundays already covered by an
  //    earlier (extended) span — same logic as pdf-batch.js.
  const spanMap = new Map();
  for (let i = 0; i < weeks; i++) {
    const sunday = addDays(startCivil, i * 7);
    const fri = addDays(sunday, 5);
    const sat = addDays(sunday, 6);
    let covered = false;
    for (const s of spanMap.values()) {
      if (compareCivil(s.startDate, fri) <= 0 && compareCivil(s.endDate, sat) >= 0) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    const { startDate, endDate } = planWeekSpan(sunday);
    const key = startDate.year * 1e4 + startDate.month * 1e2 + startDate.day;
    spanMap.set(key, { startDate, endDate });
  }

  // 2. Orphan Yom Tov spans inside the window.
  const claimed = buildClaimedSet(spanMap.values());
  for (
    let cursor = startCivil;
    compareCivil(cursor, windowEndCivil) <= 0;
    cursor = addDays(cursor, 1)
  ) {
    if (claimed.has(formatCivil(cursor))) continue;
    if (!isHolidayDay(cursor)) continue;
    let start = cursor;
    let end = cursor;
    while (true) {
      const prev = addDays(start, -1);
      if (claimed.has(formatCivil(prev)) || !isHolidayDay(prev)) break;
      start = prev;
    }
    while (true) {
      const next = addDays(end, 1);
      if (claimed.has(formatCivil(next)) || !isHolidayDay(next)) break;
      end = next;
    }
    const key = start.year * 1e4 + start.month * 1e2 + start.day;
    spanMap.set(key, { startDate: start, endDate: end });
    for (let d = start; compareCivil(d, end) <= 0; d = addDays(d, 1)) {
      claimed.add(formatCivil(d));
    }
  }

  const spans = [...spanMap.values()].sort(
    (a, b) => compareCivil(a.startDate, b.startDate)
  );

  // 3. For each span: resolve schedule + overrides + announcements, hash,
  //    then R2 head. All in parallel — each await is one I/O round-trip.
  const results = await Promise.all(
    spans.map(async ({ startDate, endDate }) => {
      const schedule = generateSpan(startDate, endDate, seedRules);
      const overrideRow = await env.DB.prepare(
        'SELECT overrides_json, layout_json FROM schedule_overrides WHERE start_date = ? AND end_date = ?'
      ).bind(schedule.startDate, schedule.endDate).first();
      let layout = null;
      if (overrideRow) {
        const overrides = JSON.parse(overrideRow.overrides_json);
        for (const day of schedule.days) {
          const dayOverrides = overrides[day.date] || {};
          for (const [minyan, time] of Object.entries(dayOverrides)) {
            if (day.times[minyan]) {
              day.times[minyan] = {
                time,
                source: day.times[minyan].source,
                overridden: true,
                originalTime: day.times[minyan].time,
              };
            }
          }
        }
        if (overrideRow.layout_json) layout = JSON.parse(overrideRow.layout_json);
      }
      const annRows = await env.DB.prepare(
        'SELECT * FROM announcements WHERE show_from <= ? AND show_until >= ? ORDER BY show_from ASC'
      ).bind(schedule.endDate, schedule.startDate).all();
      const announcements = annRows.results || [];
      const key = await cacheKey({ schedule, announcements, layout });
      const head = env.PDF_CACHE ? await env.PDF_CACHE.head(key) : null;
      return {
        startDate: schedule.startDate,
        endDate: schedule.endDate,
        cacheKey: key,
        exists: !!head,
      };
    })
  );

  return jsonResp({ spans: results });
}

function isHolidayDay(civil) {
  const ctx = buildDayContext(civil);
  return ctx.dayTags.some((t) => HOLIDAY_TAGS.has(t));
}

function buildClaimedSet(spans) {
  const claimed = new Set();
  for (const { startDate, endDate } of spans) {
    for (let d = startDate; compareCivil(d, endDate) <= 0; d = addDays(d, 1)) {
      claimed.add(formatCivil(d));
    }
  }
  return claimed;
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseISO(s) {
  const [, y, m, d] = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return { year: +y, month: +m, day: +d };
}

function formatCivil({ year, month, day }) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDate({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function compareCivil(a, b) {
  return (a.year - b.year) * 10000 + (a.month - b.month) * 100 + (a.day - b.day);
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
