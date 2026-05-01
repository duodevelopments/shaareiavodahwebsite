import { generateWeek } from '../../lib/generator.js';
import { seedRules } from '../../lib/rules-seed.js';
import { cacheKey, getCached } from '../../lib/pdf-cache.js';

/**
 * POST /api/cron/friday-docx
 *
 * Called every Friday at 8:00 AM Detroit time. Reads this week's pre-rendered
 * PDF from R2 (uploaded by the admin's browser pre-render hook) and emails it
 * to the admin.
 *
 * If R2 has nothing for this week's current schedule (e.g. admin hasn't
 * opened /admin/* in 10+ weeks, or edits broke the cached hash), sends a
 * warning email instead so the admin can re-render.
 *
 * Protected by CRON_SECRET. Endpoint name kept for cron-worker compatibility
 * even though docx is no longer attached.
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
  const siteUrl = env.SITE_URL || '';

  // This Shabbos's span — today is Friday, so its Sunday is today-5.
  const today = todayDetroit();
  const sunday = addDays(today, -5);
  const schedule = generateWeek(sunday, seedRules);

  // Resolve overrides + announcements + layout to compute the cache key.
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
  const pdfBuffer = await getCached(env, key);

  const label = schedule.label || 'Shabbos';
  const baseName = `Shaarei_Avodah_${(schedule.label || 'Shabbos').replace(/\s+/g, '_')}_${schedule.startDate}`;

  // Cache miss → warning email.
  if (!pdfBuffer) {
    const sundayISO = `${sunday.year}-${String(sunday.month).padStart(2, '0')}-${String(sunday.day).padStart(2, '0')}`;
    const reviewUrl = siteUrl ? `${siteUrl}/admin/week?sunday=${sundayISO}` : '/admin/week';
    const subject = `[Action needed] No printable PDF for ${label} — ${schedule.startDate}`;
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
        html: `<p>No pre-rendered PDF was found in R2 for <strong>${esc(label)}</strong> (${esc(schedule.startDate)} — ${esc(schedule.endDate)}).</p>
<p>This usually means the schedule was edited after the last admin visit, or it's been more than 10 weeks since you last opened the admin.</p>
<p><a href="${reviewUrl}">Open the admin to regenerate →</a></p>
<p style="color:#888;font-size:12px;">Cache key: ${esc(key)}</p>`,
      }),
    });
    return json({
      ok: res.ok,
      warning: 'cache_miss',
      cacheKey: key,
      schedule: `${schedule.startDate}..${schedule.endDate}`,
      label,
    });
  }

  // Cache hit → send the PDF as attachment.
  const subject = `Printable sheet: ${label} — ${schedule.startDate}`;
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
      html: `<p>Attached is the printable davening times sheet for <strong>${esc(label)}</strong> (${esc(schedule.startDate)} — ${esc(schedule.endDate)}).</p><p>Good Shabbos!</p>`,
      attachments: [{ filename: `${baseName}.pdf`, content: bufferToBase64(pdfBuffer) }],
    }),
  });

  return json({
    ok: res.ok,
    cacheKey: key,
    schedule: `${schedule.startDate}..${schedule.endDate}`,
    label,
    error: res.ok ? undefined : await res.text(),
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
