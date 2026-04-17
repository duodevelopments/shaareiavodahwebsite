import { generateWeek } from '../../../lib/generator.js';
import { seedRules } from '../../../lib/rules-seed.js';
import { generateDocx } from '../../../lib/docx-template.js';

/**
 * GET /api/schedules/docx?sunday=YYYY-MM-DD
 *
 * Returns a .docx Word document for the given week, including overrides and
 * announcements. Browser will download as a file.
 */
export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const sundayParam = url.searchParams.get('sunday');

  if (!sundayParam || !/^\d{4}-\d{2}-\d{2}$/.test(sundayParam)) {
    return new Response('Missing or invalid ?sunday= parameter', { status: 400 });
  }

  const [, y, m, d] = sundayParam.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const sundayCivil = { year: +y, month: +m, day: +d };

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
        } else {
          day.times[minyan] = {
            time,
            source: { ruleId: null, mode: 'override' },
            overridden: true,
            originalTime: null,
          };
        }
      }
    }
  }

  // Fetch announcements.
  const annRows = await env.DB.prepare(
    'SELECT * FROM announcements WHERE show_from <= ? AND show_until >= ? ORDER BY show_from ASC'
  )
    .bind(schedule.endDate, schedule.startDate)
    .all();

  // Fetch the logo from the site's static assets so we can embed it.
  let logoData = null;
  try {
    const logoRes = await fetch(new URL('/d/Logo%20Header.png', context.request.url));
    if (logoRes.ok) logoData = new Uint8Array(await logoRes.arrayBuffer());
  } catch {
    // Skip logo on failure — fall back to text header.
  }

  const buffer = await generateDocx({
    schedule,
    announcements: annRows.results || [],
    logoData,
  });

  const filename = schedule.label
    ? `Shaarei_Avodah_${schedule.label.replace(/\s+/g, '_')}_${schedule.startDate}.docx`
    : `Shaarei_Avodah_${schedule.startDate}.docx`;

  return new Response(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
