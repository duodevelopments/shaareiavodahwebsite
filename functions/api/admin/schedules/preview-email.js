import { generateWeek } from '../../../lib/generator.js';
import { seedRules } from '../../../lib/rules-seed.js';
import { renderEmail } from '../../../lib/email-template.js';

/**
 * GET /api/schedules/preview-email?sunday=YYYY-MM-DD
 *
 * Returns the rendered HTML email for preview in a browser. Useful for
 * checking layout and content before sending.
 */
export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const sundayParam = url.searchParams.get('sunday') || '2026-04-19';

  let sundayCivil;
  try {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sundayParam);
    sundayCivil = { year: +m[1], month: +m[2], day: +m[3] };
  } catch {
    return new Response('Invalid sunday', { status: 400 });
  }

  const schedule = generateWeek(sundayCivil, seedRules);

  // Merge overrides.
  const overrideRow = await env.DB.prepare(
    'SELECT overrides_json FROM schedule_overrides WHERE start_date = ? AND end_date = ?'
  )
    .bind(schedule.startDate, schedule.endDate)
    .first();

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
  }

  // Fetch announcements + any attachment metadata so the preview shows the
  // "See attached" labels that the real send would render.
  const annRows = await env.DB.prepare(
    `SELECT a.id, a.show_from, a.show_until, a.kind, a.text, a.attachment_id,
            att.filename AS attachment_filename
       FROM announcements a
       LEFT JOIN attachments att ON att.id = a.attachment_id
       WHERE a.show_from <= ? AND a.show_until >= ?
       ORDER BY a.show_from ASC`
  )
    .bind(schedule.endDate, schedule.startDate)
    .all();

  const html = renderEmail({
    schedule,
    announcements: annRows.results || [],
  });

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
