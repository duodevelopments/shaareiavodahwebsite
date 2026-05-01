import { PDFDocument } from 'pdf-lib';
import {
  generateSpan,
  planWeekSpan,
  addDays,
  HOLIDAY_TAGS,
} from '../../../lib/generator.js';
import { seedRules } from '../../../lib/rules-seed.js';
import { generatePDF } from '../../../lib/pdf-template.js';
import { buildDayContext } from '../../../lib/zmanim.js';
import { cacheKey, getCached, putCached } from '../../../lib/pdf-cache.js';

const DEFAULT_WEEKS = 10;
const MAX_WEEKS = 26;

/**
 * GET /api/admin/schedules/pdf-batch?sunday=YYYY-MM-DD&weeks=10
 *
 * Returns a single merged PDF containing one page per upcoming weekly span,
 * plus an extra page for any orphan Yom Tov stretch that falls in the window
 * but doesn't bundle into a Shabbos sheet (e.g., a mid-week Shavuos).
 */
export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const sundayParam = url.searchParams.get('sunday');
  const weeksParam = url.searchParams.get('weeks');

  if (!sundayParam || !/^\d{4}-\d{2}-\d{2}$/.test(sundayParam)) {
    return new Response('Missing or invalid ?sunday=', { status: 400 });
  }
  const weeks = clampInt(weeksParam, DEFAULT_WEEKS, 1, MAX_WEEKS);

  const startCivil = parseCivil(sundayParam);
  if (toDate(startCivil).getUTCDay() !== 0) {
    return new Response('?sunday= must be a Sunday', { status: 400 });
  }
  const windowEndCivil = addDays(startCivil, weeks * 7 - 1);

  // 1. Sweep the next N Sundays, collecting each week's planned span.
  //    Skip a Sunday if its Fri/Sat is already inside an earlier span — this
  //    prevents Pesach (which bundles 8+ days into one sheet) from emitting
  //    duplicate, overlapping spans for each Sunday it touches.
  const spanMap = new Map();
  for (let i = 0; i < weeks; i++) {
    const sunday = addDays(startCivil, i * 7);
    const fri = addDays(sunday, 5);
    const sat = addDays(sunday, 6);
    let covered = false;
    for (const s of spanMap.values()) {
      if (
        compareCivil(s.startDate, fri) <= 0 &&
        compareCivil(s.endDate, sat) >= 0
      ) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    const { startDate, endDate } = planWeekSpan(sunday);
    const key = startDate.year * 1e4 + startDate.month * 1e2 + startDate.day;
    spanMap.set(key, { startDate, endDate });
  }

  // 2. Find orphan Yom Tov: any HOLIDAY_TAG day in the window not already
  //    contained in a collected span. Build a tight span around it by walking
  //    forward/backward through contiguous holiday-tagged days.
  const claimed = buildClaimedSet(spanMap.values());
  for (
    let cursor = startCivil;
    compareCivil(cursor, windowEndCivil) <= 0;
    cursor = addDays(cursor, 1)
  ) {
    const dateStr = formatCivil(cursor);
    if (claimed.has(dateStr)) continue;
    if (!isHolidayDay(cursor)) continue;

    let start = cursor;
    let end = cursor;
    while (true) {
      const prev = addDays(start, -1);
      if (claimed.has(formatCivil(prev))) break;
      if (!isHolidayDay(prev)) break;
      start = prev;
    }
    while (true) {
      const next = addDays(end, 1);
      if (claimed.has(formatCivil(next))) break;
      if (!isHolidayDay(next)) break;
      end = next;
    }

    const key = start.year * 1e4 + start.month * 1e2 + start.day;
    spanMap.set(key, { startDate: start, endDate: end });
    for (
      let d = start;
      compareCivil(d, end) <= 0;
      d = addDays(d, 1)
    ) {
      claimed.add(formatCivil(d));
    }
  }

  // 3. Sort spans by start date.
  const spans = [...spanMap.values()].sort(
    (a, b) => compareCivil(a.startDate, b.startDate)
  );

  // 4. Resolve each span to a full schedule (with overrides + announcements).
  const resolved = [];
  for (const { startDate, endDate } of spans) {
    const schedule = generateSpan(startDate, endDate, seedRules);
    const layout = await applyOverridesAndGetLayout(env, schedule);
    const announcements = await fetchAnnouncements(env, schedule);
    resolved.push({ schedule, announcements, layout });
  }

  // 5. Resolve cache hits in parallel; lazy-load assets only if any miss.
  const cacheKeys = await Promise.all(
    resolved.map((r) => cacheKey({ schedule: r.schedule, announcements: r.announcements, layout: r.layout }))
  );
  const pageBlobs = await Promise.all(cacheKeys.map((k) => getCached(env, k)));
  const anyMiss = pageBlobs.some((b) => b === null);

  if (anyMiss) {
    const [logoRes, compactLogoRes, hebrewFontRes, latinFontRes] = await Promise.all([
      fetch(new URL('/d/Logo%20Header.png', context.request.url)),
      fetch(new URL('/d/Logo%20Compact.png', context.request.url)),
      fetch(new URL('/d/51618.otf', context.request.url)),
      fetch(new URL('/d/BonaNova-Regular.ttf', context.request.url)),
    ]);
    if (!hebrewFontRes.ok) {
      return new Response('Hebrew font not found at /d/51618.otf', { status: 500 });
    }
    if (!latinFontRes.ok) {
      return new Response('Latin font not found at /d/BonaNova-Regular.ttf', { status: 500 });
    }
    const logoData = logoRes.ok ? new Uint8Array(await logoRes.arrayBuffer()) : null;
    const compactLogoData = compactLogoRes.ok ? new Uint8Array(await compactLogoRes.arrayBuffer()) : null;
    const hebrewFontData = new Uint8Array(await hebrewFontRes.arrayBuffer());
    const latinFontData = new Uint8Array(await latinFontRes.arrayBuffer());

    // Render each missing page, then cache it. Sequential to keep CPU bounded
    // — pdf-lib is synchronous between awaits, so parallel renders share
    // the same isolate and don't actually overlap.
    for (let i = 0; i < resolved.length; i++) {
      if (pageBlobs[i]) continue;
      const { schedule, announcements, layout } = resolved[i];
      const bytes = await generatePDF({
        schedule, announcements, logoData, compactLogoData,
        hebrewFontData, latinFontData, layout,
      });
      pageBlobs[i] = bytes;
      await putCached(env, cacheKeys[i], bytes);
    }
  }

  // 6. Merge all single-page PDFs into one document via copyPages.
  const merged = await PDFDocument.create();
  for (const bytes of pageBlobs) {
    const src = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
  }
  const pdfBytes = await merged.save();

  const filename = `Shaarei_Avodah_${formatCivil(startCivil)}_to_${formatCivil(windowEndCivil)}.pdf`;
  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function applyOverridesAndGetLayout(env, schedule) {
  const row = await env.DB.prepare(
    'SELECT overrides_json, layout_json FROM schedule_overrides WHERE start_date = ? AND end_date = ?'
  ).bind(schedule.startDate, schedule.endDate).first();
  if (!row) return null;
  const overrides = JSON.parse(row.overrides_json);
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
  return row.layout_json ? JSON.parse(row.layout_json) : null;
}

async function fetchAnnouncements(env, schedule) {
  const rows = await env.DB.prepare(
    'SELECT * FROM announcements WHERE show_from <= ? AND show_until >= ? ORDER BY show_from ASC'
  ).bind(schedule.endDate, schedule.startDate).all();
  return rows.results || [];
}

function buildClaimedSet(spans) {
  const claimed = new Set();
  for (const { startDate, endDate } of spans) {
    for (
      let d = startDate;
      compareCivil(d, endDate) <= 0;
      d = addDays(d, 1)
    ) {
      claimed.add(formatCivil(d));
    }
  }
  return claimed;
}

function isHolidayDay(civil) {
  const ctx = buildDayContext(civil);
  return ctx.dayTags.some((t) => HOLIDAY_TAGS.has(t));
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseCivil(s) {
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
