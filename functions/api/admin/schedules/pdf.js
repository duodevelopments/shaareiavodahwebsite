import { generateWeek, generateSpan } from '../../../lib/generator.js';
import { seedRules } from '../../../lib/rules-seed.js';
import { generatePDF } from '../../../lib/pdf-template.js';
import { cacheKey, getCached, putCached } from '../../../lib/pdf-cache.js';

/**
 * GET /api/schedules/pdf?sunday=YYYY-MM-DD
 * GET /api/schedules/pdf?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * Returns a PDF of the weekly sheet (or arbitrary span — used by the multi-week
 * batch flow for orphan Yom Tov spans that don't align to a Sunday).
 */
export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const sundayParam = url.searchParams.get('sunday');
  const startParam = url.searchParams.get('startDate');
  const endParam = url.searchParams.get('endDate');

  let schedule;
  if (startParam && endParam) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startParam) || !/^\d{4}-\d{2}-\d{2}$/.test(endParam)) {
      return new Response('Invalid ?startDate= or ?endDate=', { status: 400 });
    }
    const [, ys, ms, ds] = startParam.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const [, ye, me, de] = endParam.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    schedule = generateSpan(
      { year: +ys, month: +ms, day: +ds },
      { year: +ye, month: +me, day: +de },
      seedRules
    );
  } else if (sundayParam && /^\d{4}-\d{2}-\d{2}$/.test(sundayParam)) {
    const [, y, m, d] = sundayParam.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    schedule = generateWeek({ year: +y, month: +m, day: +d }, seedRules);
  } else {
    return new Response('Missing ?sunday= or ?startDate=&endDate=', { status: 400 });
  }

  // Merge overrides + load layout.
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

  // Fetch announcements.
  const annRows = await env.DB.prepare(
    'SELECT * FROM announcements WHERE show_from <= ? AND show_until >= ? ORDER BY show_from ASC'
  ).bind(schedule.endDate, schedule.startDate).all();
  const announcements = annRows.results || [];

  const filename = schedule.label
    ? `Shaarei_Avodah_${schedule.label.replace(/\s+/g, '_')}_${schedule.startDate}.pdf`
    : `Shaarei_Avodah_${schedule.startDate}.pdf`;

  // Cache lookup — skip the heavy render entirely on a hit.
  const key = await cacheKey({ schedule, announcements, layout });
  const cached = await getCached(env, key);
  if (cached) {
    return new Response(cached, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Pdf-Cache': 'hit',
      },
    });
  }

  // Fetch logos + both fonts from static assets.
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

  const pdfBytes = await generatePDF({
    schedule,
    announcements,
    logoData,
    compactLogoData,
    hebrewFontData,
    latinFontData,
    layout,
  });

  await putCached(env, key, pdfBytes);

  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Pdf-Cache': 'miss',
    },
  });
}
