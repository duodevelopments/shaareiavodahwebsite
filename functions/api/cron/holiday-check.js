import { buildDayContext } from '../../lib/zmanim.js';
import { generateWeek, addDays } from '../../lib/generator.js';
import { seedRules } from '../../lib/rules-seed.js';

/**
 * POST /api/cron/holiday-check
 *
 * Detection-only. Returns whether an erev-yom-tov auto-send should fire today.
 * The cron-worker is responsible for actually running the chunked send.
 *
 * Rule: send only when TODAY (America/Detroit) is tagged `erev_yom_tov` —
 * i.e., yom tov begins tonight. Idempotent via send_log: if a non-test send
 * already exists for the span containing tomorrow's yom tov, returns
 * shouldSend: false.
 *
 * Protected by CRON_SECRET header check.
 *
 * Response: {
 *   ok, shouldSend, reason,
 *   sunday?, label?, startDate?, endDate?,    // present when shouldSend = true
 * }
 */
export async function onRequestPost(context) {
  const { env, request } = context;

  if (!checkSecret(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const today = todayDetroit();
  const ctx = buildDayContext(today);

  if (!ctx.dayTags.includes('erev_yom_tov')) {
    return json({ ok: true, shouldSend: false, reason: 'today is not erev yom tov' });
  }

  // Yom tov begins tonight, so the YT day is tomorrow. Find the Sunday-rooted
  // span containing tomorrow.
  const tomorrow = addDays(today, 1);
  const sunday = previousOrSameSunday(tomorrow);
  const schedule = generateWeek(sunday, seedRules);
  const sundayISO = `${sunday.year}-${String(sunday.month).padStart(2, '0')}-${String(sunday.day).padStart(2, '0')}`;

  const existing = await env.DB.prepare(
    'SELECT id FROM send_log WHERE start_date = ? AND end_date = ? AND test_only = 0 LIMIT 1'
  )
    .bind(schedule.startDate, schedule.endDate)
    .first();

  if (existing) {
    return json({
      ok: true,
      shouldSend: false,
      reason: `already sent for span ${schedule.startDate}..${schedule.endDate}`,
    });
  }

  return json({
    ok: true,
    shouldSend: true,
    reason: 'today is erev yom tov and span has not been sent',
    sunday: sundayISO,
    label: schedule.label || null,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
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
