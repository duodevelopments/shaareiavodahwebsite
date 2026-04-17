import { generateWeek } from '../../../lib/generator.js';
import { seedRules } from '../../../lib/rules-seed.js';

/**
 * PATCH /api/schedules/overrides
 *
 * Body: { sunday: 'YYYY-MM-DD', date: 'YYYY-MM-DD', minyan: 'shacharis'|..., time: 'HH:MM'|null }
 *
 * - `sunday` identifies the week (we resolve its span via the generator).
 * - `date` is the specific day within the span to override.
 * - `minyan` is the minyan name (shacharis/mincha/maariv).
 * - `time` is the new 24-hour HH:MM value. Pass `null` to clear an override
 *   and fall back to the rule-derived time.
 *
 * Upserts a row in `schedule_overrides` keyed by (start_date, end_date).
 */
export async function onRequestPatch(context) {
  const { env, request } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { sunday, date, minyan, time } = body || {};
  if (!sunday || !date || !minyan) {
    return json({ error: 'Missing sunday, date, or minyan' }, 400);
  }
  if (time != null && !/^\d\d:\d\d$/.test(time)) {
    return json({ error: 'time must be HH:MM (24h) or null' }, 400);
  }

  let sundayCivil;
  try {
    sundayCivil = parseISODate(sunday);
  } catch {
    return json({ error: 'Invalid sunday date' }, 400);
  }

  // Resolve the span for this week so we key overrides consistently.
  const schedule = generateWeek(sundayCivil, seedRules);
  const { startDate, endDate } = schedule;

  // Ensure the date being overridden is within the span.
  if (date < startDate || date > endDate) {
    return json(
      { error: `date ${date} is outside this week's span (${startDate}..${endDate})` },
      400
    );
  }

  // Read-modify-write the overrides_json for this span.
  const existing = await env.DB.prepare(
    'SELECT overrides_json FROM schedule_overrides WHERE start_date = ? AND end_date = ?'
  )
    .bind(startDate, endDate)
    .first();

  const overrides = existing ? JSON.parse(existing.overrides_json) : {};
  const dayOverrides = overrides[date] || {};

  if (time == null) {
    delete dayOverrides[minyan];
    if (Object.keys(dayOverrides).length === 0) {
      delete overrides[date];
    } else {
      overrides[date] = dayOverrides;
    }
  } else {
    dayOverrides[minyan] = time;
    overrides[date] = dayOverrides;
  }

  const now = new Date().toISOString();
  const overridesJson = JSON.stringify(overrides);

  if (existing) {
    await env.DB.prepare(
      'UPDATE schedule_overrides SET overrides_json = ?, updated_at = ? WHERE start_date = ? AND end_date = ?'
    )
      .bind(overridesJson, now, startDate, endDate)
      .run();
  } else {
    await env.DB.prepare(
      'INSERT INTO schedule_overrides (start_date, end_date, overrides_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(startDate, endDate, overridesJson, 'draft', now, now)
      .run();
  }

  return json({ ok: true, startDate, endDate, overrides });
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
