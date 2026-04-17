import { generateWeek, addDays } from '../../lib/generator.js';
import { seedRules } from '../../lib/rules-seed.js';

/**
 * POST /api/cron/weekly-draft
 *
 * Called every Sunday morning. Generates next week's schedule draft and emails
 * the gabbai a heads-up with a link to review.
 *
 * Protected by CRON_SECRET header check.
 */
export async function onRequestPost(context) {
  const { env, request } = context;

  if (!checkSecret(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const sunday = upcomingSundayDetroit();
  const schedule = generateWeek(sunday, seedRules);

  // Upsert the draft row so we know it was auto-generated.
  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    'SELECT start_date FROM schedule_overrides WHERE start_date = ? AND end_date = ?'
  )
    .bind(schedule.startDate, schedule.endDate)
    .first();

  if (!existing) {
    await env.DB.prepare(
      'INSERT INTO schedule_overrides (start_date, end_date, overrides_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(schedule.startDate, schedule.endDate, '{}', 'draft', now, now)
      .run();
  }

  // Email the gabbai.
  const adminEmail = env.ADMIN_EMAIL || 'daniel.duodevelopments@gmail.com';
  const apiKey = env.RESEND_API_KEY;
  const fromAddr = env.EMAIL_FROM || 'onboarding@resend.dev';
  const siteUrl = env.SITE_URL || 'http://127.0.0.1:8788';
  const sundayISO = `${sunday.year}-${String(sunday.month).padStart(2, '0')}-${String(sunday.day).padStart(2, '0')}`;

  const label = schedule.label || 'Shabbos';
  const subject = `Draft ready: ${label} — ${schedule.startDate}`;

  if (apiKey) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddr,
        to: adminEmail,
        subject,
        html: `<p>The draft for <strong>${esc(label)}</strong> (${esc(schedule.startDate)} — ${esc(schedule.endDate)}) has been auto-generated.</p>
<p><a href="${siteUrl}/admin/week?sunday=${sundayISO}">Review and edit the draft →</a></p>
<p style="color:#888;font-size:12px;">Days: ${schedule.days.length} · Span: ${schedule.spanType}</p>`,
      }),
    });
  }

  return json({
    ok: true,
    sunday: sundayISO,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    spanType: schedule.spanType,
    label: schedule.label,
    emailSent: !!apiKey,
  });
}

function checkSecret(request, env) {
  const secret = env.CRON_SECRET;
  if (!secret) return true; // No secret configured = allow (local dev).
  const header = request.headers.get('X-Cron-Secret');
  return header === secret;
}

function upcomingSundayDetroit() {
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
  const delta = (7 - dow) % 7;
  const utc = new Date(Date.UTC(y, m - 1, d + delta, 12));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
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
