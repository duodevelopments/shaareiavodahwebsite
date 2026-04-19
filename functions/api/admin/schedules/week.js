import { generateWeek } from '../../../lib/generator.js';
import { seedRules } from '../../../lib/rules-seed.js';
import { addDays } from '../../../lib/generator.js';

/**
 * GET /api/schedules/week?sunday=YYYY-MM-DD
 *
 * Returns the schedule for the week whose Sunday is the given date. If no
 * `sunday` query param is provided, defaults to the Sunday of the current
 * week (America/Detroit local) — i.e. the most recent Sunday on or before
 * today.
 *
 * Overrides stored in D1 are merged into the rule-derived times. Rule output
 * is always freshly computed, so editing rules-seed.js propagates immediately
 * to every un-edited cell.
 */
export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const sundayParam = url.searchParams.get('sunday');

  let sunday;
  try {
    sunday = sundayParam ? parseISODate(sundayParam) : currentSundayDetroit();
  } catch (err) {
    return json({ error: 'Invalid `sunday` param. Expected YYYY-MM-DD.' }, 400);
  }

  if (!isSunday(sunday)) {
    return json({ error: '`sunday` must fall on a Sunday.' }, 400);
  }

  try {
    const schedule = generateWeek(sunday, seedRules);

    // Merge any stored overrides for this span.
    const overrideRow = await env.DB.prepare(
      'SELECT overrides_json, status, layout_json FROM schedule_overrides WHERE start_date = ? AND end_date = ?'
    )
      .bind(schedule.startDate, schedule.endDate)
      .first();

    const overrides = overrideRow ? JSON.parse(overrideRow.overrides_json) : {};
    const status = overrideRow?.status || 'draft';
    const layout = overrideRow?.layout_json ? JSON.parse(overrideRow.layout_json) : null;

    for (const day of schedule.days) {
      const dayOverrides = overrides[day.date] || {};
      for (const [minyan, time] of Object.entries(dayOverrides)) {
        if (day.times[minyan]) {
          day.times[minyan] = {
            time,
            source: { ruleId: day.times[minyan].source.ruleId, mode: 'override' },
            overridden: true,
            originalTime: day.times[minyan].time,
          };
        } else {
          // Override added a minyan that no rule produced — surface it as
          // an override-only entry.
          day.times[minyan] = {
            time,
            source: { ruleId: null, mode: 'override' },
            overridden: true,
            originalTime: null,
          };
        }
      }
    }

    // Fetch announcements whose date range overlaps this span (+ any attachment).
    const annRows = await env.DB.prepare(
      `SELECT a.id, a.show_from, a.show_until, a.kind, a.text, a.attachment_id,
              att.token    AS attachment_token,
              att.filename AS attachment_filename,
              att.mime_type AS attachment_mime_type
         FROM announcements a
         LEFT JOIN attachments att ON att.id = a.attachment_id
         WHERE a.show_from <= ? AND a.show_until >= ?
         ORDER BY a.show_from ASC`
    )
      .bind(schedule.endDate, schedule.startDate)
      .all();

    return json({
      sunday: isoOf(sunday),
      prevSunday: isoOf(addDays(sunday, -7)),
      nextSunday: isoOf(addDays(sunday, 7)),
      status,
      schedule,
      announcements: annRows.results || [],
      layout,
    });
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}

// ---------------------------------------------------------------------------

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error('not iso');
  return { year: +m[1], month: +m[2], day: +m[3] };
}

function isoOf(civil) {
  return `${civil.year}-${String(civil.month).padStart(2, '0')}-${String(civil.day).padStart(2, '0')}`;
}

function isSunday(civil) {
  const d = new Date(Date.UTC(civil.year, civil.month - 1, civil.day, 12));
  return d.getUTCDay() === 0;
}

function currentSundayDetroit() {
  // Sunday of the week containing today (Detroit local): the most recent
  // Sunday on or before today. dow=0 returns today; dow=1..6 goes back that
  // many days.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Detroit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date());
  const y = +parts.find((p) => p.type === 'year').value;
  const m = +parts.find((p) => p.type === 'month').value;
  const d = +parts.find((p) => p.type === 'day').value;
  const wk = parts.find((p) => p.type === 'weekday').value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[wk];
  const utc = new Date(Date.UTC(y, m - 1, d - dow, 12));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}
