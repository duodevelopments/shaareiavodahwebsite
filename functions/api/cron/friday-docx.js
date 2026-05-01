import { generateWeek } from '../../lib/generator.js';
import { seedRules } from '../../lib/rules-seed.js';
import { generateDocx } from '../../lib/docx-template.js';
import { generatePDF } from '../../lib/pdf-template.js';
import { cacheKey, getCached, putCached } from '../../lib/pdf-cache.js';

/**
 * POST /api/cron/friday-docx
 *
 * Called every Friday at 8:00 AM Detroit time. Generates the .docx for this
 * Shabbos and emails it to the admin as an attachment so they can just print.
 *
 * Protected by CRON_SECRET.
 */
export async function onRequestPost(context) {
  const { env, request } = context;

  if (!checkSecret(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return json({ error: 'RESEND_API_KEY not configured' }, 500);
  }

  const fromAddr = env.EMAIL_FROM || 'onboarding@resend.dev';
  const adminEmail = env.ADMIN_EMAIL || 'daniel.duodevelopments@gmail.com';

  // Find the Sunday of this week (today is Friday, so Sunday = today - 5).
  const today = todayDetroit();
  const sunday = addDays(today, -5);

  const schedule = generateWeek(sunday, seedRules);

  // Merge overrides + load layout.
  const overrideRow = await env.DB.prepare(
    'SELECT overrides_json, layout_json FROM schedule_overrides WHERE start_date = ? AND end_date = ?'
  )
    .bind(schedule.startDate, schedule.endDate)
    .first();

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
  )
    .bind(schedule.endDate, schedule.startDate)
    .all();
  const announcements = annRows.results || [];

  // Try the PDF cache first — if the gabbai already viewed/saved this week's
  // sheet, the rendered PDF is already in R2.
  const pdfKey = await cacheKey({ schedule, announcements, layout });
  let pdfBuffer = await getCached(env, pdfKey);

  // Fetch logos for the docx (always needed) + fonts only if we'll re-render.
  const logoFetches = [
    fetch(new URL('/d/Logo%20Header.png', request.url)),
    fetch(new URL('/d/Logo%20Compact.png', request.url)),
  ];
  const fontFetches = pdfBuffer
    ? []
    : [
        fetch(new URL('/d/51618.otf', request.url)),
        fetch(new URL('/d/BonaNova-Regular.ttf', request.url)),
      ];
  const [logoRes, compactLogoRes, hebrewFontRes, latinFontRes] = await Promise.all([
    ...logoFetches,
    ...fontFetches,
  ]);
  const logoData = logoRes.ok ? new Uint8Array(await logoRes.arrayBuffer()) : null;
  const compactLogoData = compactLogoRes.ok ? new Uint8Array(await compactLogoRes.arrayBuffer()) : null;
  const hebrewFontData = hebrewFontRes?.ok ? new Uint8Array(await hebrewFontRes.arrayBuffer()) : null;
  const latinFontData = latinFontRes?.ok ? new Uint8Array(await latinFontRes.arrayBuffer()) : null;

  // Generate the docx.
  const docxBuffer = await generateDocx({ schedule, announcements, logoData });

  // Render the PDF only on cache miss; cache the result for future hits.
  if (!pdfBuffer && hebrewFontData && latinFontData) {
    pdfBuffer = await generatePDF({
      schedule, announcements, logoData, compactLogoData,
      hebrewFontData, latinFontData, layout,
    });
    await putCached(env, pdfKey, pdfBuffer);
  }

  const baseName = schedule.label
    ? `Shaarei_Avodah_${schedule.label.replace(/\s+/g, '_')}_${schedule.startDate}`
    : `Shaarei_Avodah_${schedule.startDate}`;

  const label = schedule.label || 'Shabbos';
  const subject = `Printable sheet: ${label} — ${schedule.startDate}`;

  const attachments = [
    { filename: `${baseName}.docx`, content: bufferToBase64(docxBuffer) },
  ];
  if (pdfBuffer) {
    attachments.push({ filename: `${baseName}.pdf`, content: bufferToBase64(pdfBuffer) });
  }

  // Send via Resend with both attachments.
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddr,
      to: adminEmail,
      subject,
      html: `<p>Attached is the printable davening times sheet for <strong>${esc(label)}</strong> (${esc(schedule.startDate)} — ${esc(schedule.endDate)}).</p><p>Attached as both .docx (editable) and .pdf (print-ready).</p><p>Good Shabbos!</p>`,
      attachments,
    }),
  });

  const ok = res.ok;
  const resBody = await res.text();

  return json({
    ok,
    schedule: `${schedule.startDate}..${schedule.endDate}`,
    label: schedule.label,
    emailSent: ok,
    attachments: attachments.map((a) => a.filename),
    error: ok ? undefined : resBody,
  });
}

function checkSecret(request, env) {
  const secret = env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get('X-Cron-Secret') === secret;
}

function todayDetroit() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Detroit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  return {
    year: +parts.find((p) => p.type === 'year').value,
    month: +parts.find((p) => p.type === 'month').value,
    day: +parts.find((p) => p.type === 'day').value,
  };
}

function addDays(civil, n) {
  const d = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + n, 12));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function bufferToBase64(buf) {
  // Works in both Node and Workers runtime.
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
