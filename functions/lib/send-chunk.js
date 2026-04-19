import { generateWeek } from './generator.js';
import { seedRules } from './rules-seed.js';
import { renderEmail } from './email-template.js';
import { renderSMS } from './sms-template.js';
import { sendSMS } from './twilio.js';
import { toBytes } from './blob.js';

export const DEFAULT_CHUNK_LIMIT = 10;

/**
 * Process one chunk of a weekly send. Stateless — each call re-derives the
 * schedule, recipients, and rendered templates from D1.
 *
 * Recipients: subscribers matching `tag` paginated by id ASC, with the admin
 * contact appended at the end of the last chunk if not already present.
 *
 * Idempotency: on the first chunk (offset === 0, !test), we refuse to re-send
 * if a non-test send_log row already exists for this span.
 *
 * On the final chunk (`done: true`), inserts the send_log row using
 * `sentSoFar + this chunk's sends` as the recipient_count. Orchestrators must
 * echo back the running totals via `sentSoFar`.
 *
 * @returns {{
 *   done: boolean,
 *   alreadySent?: boolean,
 *   nextOffset: number,
 *   total: number,
 *   sunday: string,
 *   sent: { email: number, sms: number },
 *   errors: Array,
 * }}
 */
export async function processChunk({
  env,
  sundayCivil,
  siteOrigin,
  tag = 'Weekly',
  test = false,
  offset = 0,
  limit = DEFAULT_CHUNK_LIMIT,
  sentSoFar = { email: 0, sms: 0 },
}) {
  const resendKey = env.RESEND_API_KEY;
  const twilioSid = env.TWILIO_ACCOUNT_SID;
  const twilioToken = env.TWILIO_AUTH_TOKEN;
  const twilioFrom = env.TWILIO_FROM_NUMBER;
  const fromAddr = env.EMAIL_FROM || 'onboarding@resend.dev';
  const adminEmail = env.ADMIN_EMAIL || 'daniel.duodevelopments@gmail.com';
  const adminPhone = env.ADMIN_PHONE || null;
  const siteUrl = env.SITE_URL || siteOrigin || '';

  if (!resendKey && !twilioSid) {
    throw new Error('Neither RESEND_API_KEY nor TWILIO_ACCOUNT_SID configured');
  }

  const schedule = generateWeek(sundayCivil, seedRules);
  const sundayISO = `${sundayCivil.year}-${String(sundayCivil.month).padStart(2, '0')}-${String(sundayCivil.day).padStart(2, '0')}`;

  // Idempotency guard — only at offset 0, only for real sends.
  if (!test && offset === 0) {
    const existing = await env.DB.prepare(
      'SELECT id FROM send_log WHERE start_date = ? AND end_date = ? AND test_only = 0 LIMIT 1'
    )
      .bind(schedule.startDate, schedule.endDate)
      .first();
    if (existing) {
      return {
        done: true,
        alreadySent: true,
        nextOffset: 0,
        total: 0,
        sunday: sundayISO,
        sent: { email: 0, sms: 0 },
        errors: [],
      };
    }
  }

  // Merge overrides into the schedule.
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

  // Announcements + attachments (loaded fresh per chunk; cheap).
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

  const attachments = [];
  for (const a of announcements) {
    if (a.attachment_id == null) continue;
    const row = await env.DB.prepare('SELECT data FROM attachments WHERE id = ?')
      .bind(a.attachment_id)
      .first();
    if (!row) continue;
    attachments.push({
      filename: a.attachment_filename,
      mimeType: a.attachment_mime_type,
      data: row.data,
      publicUrl: `${siteUrl}/api/attachment/${a.attachment_token}`,
    });
  }

  const emailHtml = resendKey ? renderEmail({ schedule, announcements }) : null;
  const smsBody = twilioSid ? renderSMS({ schedule, announcements }) : null;
  const subject = schedule.label
    ? `${schedule.label} — Davening Times`
    : `Shabbos Davening Times — ${toUSDate(schedule.startDate)}`;

  const emailAttachments =
    attachments.length > 0
      ? attachments.map((a) => ({ filename: a.filename, content: bytesToBase64(a.data) }))
      : undefined;
  const mediaUrls = attachments.map((a) => a.publicUrl).slice(0, 10);

  // Build this chunk's recipient list.
  let chunkRecipients = [];
  let total = 0;
  let isLastChunk = false;

  if (test) {
    chunkRecipients = [{ email: resendKey ? adminEmail : null, phone: twilioSid ? adminPhone : null, token: null }];
    total = 1;
    isLastChunk = true;
  } else {
    const tagPattern = `%,${tag},%`;

    const countRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM subscribers WHERE unsubscribed_at IS NULL AND (',' || tags || ',') LIKE ?"
    )
      .bind(tagPattern)
      .first();
    const subTotal = countRow ? Number(countRow.n) : 0;

    const adminRow = await env.DB.prepare(
      "SELECT 1 FROM subscribers WHERE unsubscribed_at IS NULL AND (',' || tags || ',') LIKE ? AND (email = ? OR phone = ?) LIMIT 1"
    )
      .bind(tagPattern, adminEmail, adminPhone || '')
      .first();
    const adminInList = !!adminRow;

    total = subTotal + (adminInList ? 0 : 1);

    if (offset < subTotal) {
      const subs = await env.DB.prepare(
        "SELECT email, phone, token FROM subscribers WHERE unsubscribed_at IS NULL AND (',' || tags || ',') LIKE ? ORDER BY id ASC LIMIT ? OFFSET ?"
      )
        .bind(tagPattern, limit, offset)
        .all();
      chunkRecipients = subs.results || [];
    }

    const reachedSubsEnd = offset + chunkRecipients.length >= subTotal;
    if (reachedSubsEnd && !adminInList) {
      chunkRecipients.push({ email: adminEmail, phone: adminPhone, token: null });
    }
    isLastChunk = offset + chunkRecipients.length >= total;
  }

  // Send.
  const sent = { email: 0, sms: 0 };
  const errors = [];

  if (resendKey) {
    for (const sub of chunkRecipients) {
      if (!sub.email) continue;
      const unsubUrl = sub.token ? `${siteUrl}/api/unsubscribe?token=${sub.token}` : '#';
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
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) sent.email++;
        else errors.push({ channel: 'email', to: sub.email, error: await res.text() });
      } catch (err) {
        errors.push({ channel: 'email', to: sub.email, error: String(err) });
      }
    }
  }

  if (twilioSid) {
    for (const sub of chunkRecipients) {
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
        if (result.ok) sent.sms++;
        else errors.push({ channel: 'sms', to: sub.phone, error: result.error });
      } catch (err) {
        errors.push({ channel: 'sms', to: sub.phone, error: String(err) });
      }
    }
  }

  // Final-chunk bookkeeping.
  if (isLastChunk && !test) {
    const totalSent = sentSoFar.email + sentSoFar.sms + sent.email + sent.sms;
    await env.DB.prepare(
      'INSERT INTO send_log (start_date, end_date, sent_at, recipient_count, test_only) VALUES (?, ?, ?, ?, 0)'
    )
      .bind(schedule.startDate, schedule.endDate, new Date().toISOString(), totalSent)
      .run();
  }

  return {
    done: isLastChunk,
    nextOffset: offset + chunkRecipients.length,
    total,
    sunday: sundayISO,
    sent,
    errors,
  };
}

export function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error('not iso');
  return { year: +m[1], month: +m[2], day: +m[3] };
}

export function upcomingSundayDetroit() {
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
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
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
