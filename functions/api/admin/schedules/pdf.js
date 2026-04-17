import { generateWeek } from '../../../lib/generator.js';
import { seedRules } from '../../../lib/rules-seed.js';
import { generatePDF } from '../../../lib/pdf-template.js';

/**
 * GET /api/schedules/pdf?sunday=YYYY-MM-DD
 *
 * Returns a PDF of the weekly sheet.
 */
export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const sundayParam = url.searchParams.get('sunday');

  if (!sundayParam || !/^\d{4}-\d{2}-\d{2}$/.test(sundayParam)) {
    return new Response('Missing or invalid ?sunday=', { status: 400 });
  }

  const [, y, m, d] = sundayParam.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const schedule = generateWeek({ year: +y, month: +m, day: +d }, seedRules);

  // Merge overrides.
  const overrideRow = await env.DB.prepare(
    'SELECT overrides_json FROM schedule_overrides WHERE start_date = ? AND end_date = ?'
  ).bind(schedule.startDate, schedule.endDate).first();

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

  // Fetch announcements.
  const annRows = await env.DB.prepare(
    'SELECT * FROM announcements WHERE show_from <= ? AND show_until >= ? ORDER BY show_from ASC'
  ).bind(schedule.endDate, schedule.startDate).all();

  // Fetch logo + both fonts from static assets.
  const [logoRes, hebrewFontRes, latinFontRes] = await Promise.all([
    fetch(new URL('/d/Logo%20Header.png', context.request.url)),
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
  const hebrewFontData = new Uint8Array(await hebrewFontRes.arrayBuffer());
  const latinFontData = new Uint8Array(await latinFontRes.arrayBuffer());

  const pdfBytes = await generatePDF({
    schedule,
    announcements: annRows.results || [],
    logoData,
    hebrewFontData,
    latinFontData,
  });

  const filename = schedule.label
    ? `Shaarei_Avodah_${schedule.label.replace(/\s+/g, '_')}_${schedule.startDate}.pdf`
    : `Shaarei_Avodah_${schedule.startDate}.pdf`;

  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
