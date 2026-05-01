import { generateWeek, generateSpan } from '../../../lib/generator.js';
import { seedRules } from '../../../lib/rules-seed.js';
import { cacheKey } from '../../../lib/pdf-cache.js';

/**
 * GET /api/admin/schedules/resolved?sunday=YYYY-MM-DD
 * GET /api/admin/schedules/resolved?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * Returns the fully-resolved schedule for browser-side PDF rendering:
 *   { schedule, announcements, layout, cacheKey, label }
 *
 * The cacheKey is computed server-side so the browser uploads to the same R2
 * path that cron + cache-status look for. CPU-light: just D1 reads + a
 * SHA-256 hash, fits well inside Workers Free's 10ms budget.
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
  const startParam = url.searchParams.get('startDate');
  const endParam = url.searchParams.get('endDate');

  let schedule;
  if (startParam && endParam) {
    if (!isISO(startParam) || !isISO(endParam)) {
      return jsonResp({ error: 'Invalid startDate/endDate' }, 400);
    }
    schedule = generateSpan(parseISO(startParam), parseISO(endParam), seedRules);
  } else if (sundayParam && isISO(sundayParam)) {
    schedule = generateWeek(parseISO(sundayParam), seedRules);
  } else {
    return jsonResp({ error: 'Missing sunday or startDate/endDate' }, 400);
  }

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

  return jsonResp({
    schedule,
    announcements,
    layout,
    cacheKey: key,
    label: schedule.label || 'Shabbos',
  });
}

function isISO(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseISO(s) {
  const [, y, m, d] = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return { year: +y, month: +m, day: +d };
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
