import { generateWeek } from '../../../lib/generator.js';
import { seedRules } from '../../../lib/rules-seed.js';
import { renderEmail } from '../../../lib/email-template.js';
import { renderSMS } from '../../../lib/sms-template.js';
import { sendSMS } from '../../../lib/twilio.js';
import { toBytes } from '../../../lib/blob.js';

/**
 * POST /api/schedules/send
 *
 * Body: { sunday: 'YYYY-MM-DD', test?: boolean }
 *
 * - `test: true` (default) sends ONLY to the admin (email + SMS if phone set).
 * - `test: false` sends to all active subscribers via their preferred channels.
 *
 * Attachments ride along with announcements: every announcement overlapping
 * the span that has an attachment_id contributes one file to the send.
 * Email: multi-attachment via Resend. SMS: multi-MediaUrl MMS via Twilio.
 */
export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { sunday, test = true, tag = 'Weekly' } = body || {};
  if (!sunday) return json({ error: 'Missing `sunday`' }, 400);

  const resendKey = env.RESEND_API_KEY;
  const twilioSid = env.TWILIO_ACCOUNT_SID;
  const twilioToken = env.TWILIO_AUTH_TOKEN;
  const twilioFrom = env.TWILIO_FROM_NUMBER;

  if (!resendKey && !twilioSid) {
    return json(
      { error: 'Neither RESEND_API_KEY nor TWILIO_ACCOUNT_SID configured. Add to .dev.vars or Cloudflare secrets.' },
      500
    );
  }

  const fromAddr = env.EMAIL_FROM || 'onboarding@resend.dev';
  const adminEmail = env.ADMIN_EMAIL || 'daniel.duodevelopments@gmail.com';
  const adminPhone = env.ADMIN_PHONE || null;

  let sundayCivil;
  try {
    sundayCivil = parseISODate(sunday);
  } catch {
    return json({ error: 'Invalid sunday date' }, 400);
  }

  // Generate the schedule with overrides merged.
  const schedule = generateWeek(sundayCivil, seedRules);

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
            source: { ruleId: day.times[minyan].source.ruleId, mode: 'override' },
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

  // Fetch announcements + any attachments they carry.
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
  const announcements = annRows.results || [];

  // Load the binary bytes for any announcement with an attachment.
  const siteUrlForAttachments = env.SITE_URL || new URL(request.url).origin;
  const attachments = [];
  for (const a of announcements) {
    if (a.attachment_id == null) continue;
    const row = await env.DB.prepare(
      'SELECT data FROM attachments WHERE id = ?'
    )
      .bind(a.attachment_id)
      .first();
    if (!row) continue;
    attachments.push({
      filename: a.attachment_filename,
      mimeType: a.attachment_mime_type,
      data: row.data,
      publicUrl: `${siteUrlForAttachments}/api/attachment/${a.attachment_token}`,
    });
  }

  // Render templates.
  const emailHtml = resendKey ? renderEmail({ schedule, announcements }) : null;
  const smsBody = twilioSid ? renderSMS({ schedule, announcements }) : null;

  const subject = schedule.label
    ? `${schedule.label} — Davening Times`
    : `Shabbos Davening Times — ${toUSDate(schedule.startDate)}`;

  // Build recipient lists (full subscriber objects for token-based unsub links).
  let subscribers = [];

  if (test) {
    subscribers.push({ email: resendKey ? adminEmail : null, phone: twilioSid ? adminPhone : null, token: null });
  } else {
    const subs = await env.DB.prepare(
      "SELECT email, phone, token FROM subscribers WHERE unsubscribed_at IS NULL AND (',' || tags || ',') LIKE ?"
    ).bind(`%,${tag},%`).all();
    subscribers = subs.results || [];
    // Always include admin, even if they aren't tagged — they're the sender and
    // need a copy to confirm what went out.
    const adminInList = subscribers.some(
      (s) => s.email === adminEmail || s.phone === adminPhone
    );
    if (!adminInList) {
      subscribers.push({ email: adminEmail, phone: adminPhone, token: null });
    }
  }

  const siteUrl = env.SITE_URL || '';
  const stats = { emailSent: 0, smsSent: 0, errors: [] };

  // Pre-encode attachments once for all emails.
  const emailAttachments =
    attachments.length > 0
      ? attachments.map((a) => ({
          filename: a.filename,
          content: bytesToBase64(a.data),
        }))
      : undefined;

  // Twilio allows up to 10 MediaUrls per MMS.
  const mediaUrls = attachments.map((a) => a.publicUrl).slice(0, 10);

  // Send emails.
  if (resendKey) {
    for (const sub of subscribers) {
      if (!sub.email) continue;
      const unsubUrl = sub.token
        ? `${siteUrl}/api/unsubscribe?token=${sub.token}`
        : '#';
      try {
        const payload = {
          from: fromAddr,
          to: sub.email,
          subject,
          html: emailHtml.replace('{{unsubscribe_url}}', unsubUrl),
        };
        if (emailAttachments) payload.attachments = emailAttachments;
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) stats.emailSent++;
        else stats.errors.push({ channel: 'email', to: sub.email, error: await res.text() });
      } catch (err) {
        stats.errors.push({ channel: 'email', to: sub.email, error: String(err) });
      }
    }
  }

  // Send SMS.
  if (twilioSid) {
    for (const sub of subscribers) {
      if (!sub.phone) continue;
      try {
        const result = await sendSMS({
          to: sub.phone,
          body: smsBody,
          accountSid: twilioSid,
          authToken: twilioToken,
          from: twilioFrom,
          mediaUrl: mediaUrls.length > 0 ? mediaUrls : undefined,
        });
        if (result.ok) stats.smsSent++;
        else stats.errors.push({ channel: 'sms', to: sub.phone, error: result.error });
      } catch (err) {
        stats.errors.push({ channel: 'sms', to: sub.phone, error: String(err) });
      }
    }
  }

  const emailTotal = subscribers.filter((s) => s.email && resendKey).length;
  const smsTotal = subscribers.filter((s) => s.phone && twilioSid).length;

  // Log.
  const now = new Date().toISOString();
  const totalSent = stats.emailSent + stats.smsSent;
  await env.DB.prepare(
    'INSERT INTO send_log (start_date, end_date, sent_at, recipient_count, test_only) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(schedule.startDate, schedule.endDate, now, totalSent, test ? 1 : 0)
    .run();

  return json({
    ok: true,
    test,
    tag: test ? null : tag,
    emailSent: stats.emailSent,
    emailTotal: emailTotal,
    smsSent: stats.smsSent,
    smsTotal: smsTotal,
    errors: stats.errors.length > 0 ? stats.errors : undefined,
  });
}

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

function toUSDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${+m[2]}/${+m[3]}/${m[1]}`;
}

function bytesToBase64(data) {
  const bytes = toBytes(data);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
