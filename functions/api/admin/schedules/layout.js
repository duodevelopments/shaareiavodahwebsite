import { generateWeek } from '../../../lib/generator.js';
import { seedRules } from '../../../lib/rules-seed.js';

/**
 * PUT /api/admin/schedules/layout
 *
 * Body: { sunday: 'YYYY-MM-DD', layout: object | null }
 *
 * Replaces the entire layout config for the span resolved from `sunday`.
 * Pass `null` (or omit `layout`) to clear the config and fall back to the
 * default single-page layout.
 *
 * Layout shape (when set):
 *   {
 *     mode: 'compact',
 *     title: '<page title, replaces parsha label>',
 *     sections: [
 *       { title: '<section header>', subtitle: '<optional sub-line>',
 *         startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' },
 *       ...
 *     ]
 *   }
 */
export async function onRequestPut(context) {
  const { env, request } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { sunday, layout } = body || {};
  if (!sunday) return json({ error: 'Missing sunday' }, 400);

  let sundayCivil;
  try {
    sundayCivil = parseISODate(sunday);
  } catch {
    return json({ error: 'Invalid sunday date' }, 400);
  }

  const schedule = generateWeek(sundayCivil, seedRules);
  const { startDate, endDate } = schedule;

  let layoutJson = null;
  if (layout != null) {
    const validation = validateLayout(layout, startDate, endDate);
    if (validation.error) return json({ error: validation.error }, 400);
    layoutJson = JSON.stringify(validation.layout);
  }

  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    'SELECT 1 FROM schedule_overrides WHERE start_date = ? AND end_date = ?'
  )
    .bind(startDate, endDate)
    .first();

  if (existing) {
    await env.DB.prepare(
      'UPDATE schedule_overrides SET layout_json = ?, updated_at = ? WHERE start_date = ? AND end_date = ?'
    )
      .bind(layoutJson, now, startDate, endDate)
      .run();
  } else {
    await env.DB.prepare(
      'INSERT INTO schedule_overrides (start_date, end_date, overrides_json, status, layout_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(startDate, endDate, '{}', 'draft', layoutJson, now, now)
      .run();
  }

  return json({ ok: true, startDate, endDate, layout: layoutJson ? JSON.parse(layoutJson) : null });
}

function validateLayout(raw, spanStart, spanEnd) {
  if (typeof raw !== 'object') return { error: 'layout must be an object' };
  if (raw.mode !== 'compact') {
    return { error: `unsupported layout mode: ${raw.mode}` };
  }
  if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
    return { error: 'layout.sections must be a non-empty array' };
  }
  const sections = [];
  for (let i = 0; i < raw.sections.length; i++) {
    const s = raw.sections[i] || {};
    const title = String(s.title || '').trim();
    const subtitle = String(s.subtitle || '').trim();
    const startDate = String(s.startDate || '').trim();
    const endDate = String(s.endDate || '').trim();
    // Section title is optional — empty title renders as a header-less group.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return { error: `section[${i}] dates must be YYYY-MM-DD` };
    }
    if (startDate > endDate) {
      return { error: `section[${i}] startDate is after endDate` };
    }
    if (startDate < spanStart || endDate > spanEnd) {
      return { error: `section[${i}] (${startDate}..${endDate}) is outside the span (${spanStart}..${spanEnd})` };
    }
    sections.push({ title, subtitle, startDate, endDate });
  }
  return {
    layout: {
      mode: 'compact',
      title: String(raw.title || '').trim(),
      sections,
    },
  };
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
