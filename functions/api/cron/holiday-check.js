import { buildDayContext } from '../../lib/zmanim.js';
import { generateWeek, addDays, planWeekSpan } from '../../lib/generator.js';
import { seedRules } from '../../lib/rules-seed.js';
import { renderEmail } from '../../lib/email-template.js';
import { renderSMS } from '../../lib/sms-template.js';
import { sendSMS } from '../../lib/twilio.js';

/**
 * POST /api/cron/holiday-check
 *
 * Called daily. Looks ahead 3 days for any yom tov / erev yom tov. If found,
 * and we haven't already sent a reminder for that holiday span, sends a
 * pre-holiday reminder email to all active subscribers.
 *
 * Protected by CRON_SECRET header check.
 */
export async function onRequestPost(context) {
  const { env, request } = context;

  if (!checkSecret(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const today = todayDetroit();
  const holidayTags = new Set(['yom_tov', 'erev_yom_tov']);
  let foundHoliday = false;
  let holidayDate = null;

  // Scan today + next 3 days for yom tov.
  for (let offset = 0; offset <= 3; offset++) {
    const d = addDays(today, offset);
    const ctx = buildDayContext(d);
    if (ctx.dayTags.some((t) => holidayTags.has(t))) {
      foundHoliday = true;
      holidayDate = d;
      break;
    }
  }

  if (!foundHoliday) {
    return json({ ok: true, action: 'none', reason: 'No yom tov within 3 days' });
  }

  // Find the Sunday that would contain this holiday, and generate its span.
  const sunday = previousOrSameSunday(holidayDate);
  const schedule = generateWeek(sunday, seedRules);

  // Check if we already sent a reminder for this span.
  const alreadySent = await env.DB.prepare(
    'SELECT id FROM send_log WHERE start_date = ? AND end_date = ? AND test_only = 0'
  )
    .bind(schedule.startDate, schedule.endDate)
    .first();

  if (alreadySent) {
    return json({
      ok: true,
      action: 'skip',
      reason: `Already sent for span ${schedule.startDate}..${schedule.endDate}`,
    });
  }

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

  // Fetch announcements.
  const annRows = await env.DB.prepare(
    'SELECT * FROM announcements WHERE show_from <= ? AND show_until >= ? ORDER BY show_from ASC'
  )
    .bind(schedule.endDate, schedule.startDate)
    .all();
  const announcements = annRows.results || [];

  // Render and send.
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return json({ error: 'RESEND_API_KEY not configured' }, 500);
  }

  const html = renderEmail({ schedule, announcements });
  const fromAddr = env.EMAIL_FROM || 'onboarding@resend.dev';
  const adminEmail = env.ADMIN_EMAIL || 'daniel.duodevelopments@gmail.com';

  const subject = schedule.label
    ? `Upcoming: ${schedule.label} — Davening Times`
    : `Pre-Holiday Reminder — Davening Times`;

  // Get subscribers on the Weekly list — pre-holiday reminders piggyback on
  // the weekly davening-times audience.
  const subs = await env.DB.prepare(
    "SELECT email, phone FROM subscribers WHERE unsubscribed_at IS NULL AND (',' || tags || ',') LIKE '%,Weekly,%'"
  ).all();

  const emailRecipients = (subs.results || []).filter((r) => r.email).map((r) => r.email);
  if (!emailRecipients.includes(adminEmail)) emailRecipients.push(adminEmail);

  const twilioSid = env.TWILIO_ACCOUNT_SID;
  const twilioToken = env.TWILIO_AUTH_TOKEN;
  const twilioFrom = env.TWILIO_FROM_NUMBER;
  const adminPhone = env.ADMIN_PHONE || null;

  const smsRecipients = twilioSid
    ? (subs.results || []).filter((r) => r.phone).map((r) => r.phone)
    : [];
  if (twilioSid && adminPhone && !smsRecipients.includes(adminPhone)) {
    smsRecipients.push(adminPhone);
  }

  const smsBody = twilioSid ? renderSMS({ schedule, announcements }) : null;

  let emailSent = 0;
  let smsSent = 0;
  let errors = [];

  for (const to of emailRecipients) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddr,
          to,
          subject,
          html: html.replace('{{unsubscribe_url}}', '#'),
        }),
      });
      if (res.ok) emailSent++;
      else errors.push({ channel: 'email', to, error: await res.text() });
    } catch (err) {
      errors.push({ channel: 'email', to, error: String(err) });
    }
  }

  for (const to of smsRecipients) {
    try {
      const result = await sendSMS({
        to,
        body: smsBody,
        accountSid: twilioSid,
        authToken: twilioToken,
        from: twilioFrom,
      });
      if (result.ok) smsSent++;
      else errors.push({ channel: 'sms', to, error: result.error });
    } catch (err) {
      errors.push({ channel: 'sms', to, error: String(err) });
    }
  }

  // Log.
  const now = new Date().toISOString();
  const totalSent = emailSent + smsSent;
  await env.DB.prepare(
    'INSERT INTO send_log (start_date, end_date, sent_at, recipient_count, test_only) VALUES (?, ?, ?, ?, 0)'
  )
    .bind(schedule.startDate, schedule.endDate, now, totalSent)
    .run();

  return json({
    ok: true,
    action: 'sent',
    span: `${schedule.startDate}..${schedule.endDate}`,
    label: schedule.label,
    emailSent,
    smsSent,
    total: emailRecipients.length + smsRecipients.length,
    errors: errors.length > 0 ? errors : undefined,
  });
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

function previousOrSameSunday(civil) {
  const d = new Date(Date.UTC(civil.year, civil.month - 1, civil.day, 12));
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - dow);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function checkSecret(request, env) {
  const secret = env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get('X-Cron-Secret') === secret;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
