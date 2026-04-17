import { normalizeTags } from '../../../lib/tags.js';

/**
 * POST /api/admin/subscribers/import
 *
 * Body: { rows: [ { first_name?, last_name?, email?, phone?, tags? }, ... ] }
 *
 * Bulk-imports subscribers. Skips duplicates, resubscribes inactive ones (and
 * merges any incoming tags with their existing tags). Designed for pasting a
 * CSV export from a spreadsheet.
 *
 * CSV column order (the admin UI parses in this order):
 *   first_name, last_name, email, phone, tags
 * Tags are pipe-separated inside the CSV cell (e.g. "Weekly|Events") so they
 * don't collide with the CSV comma delimiter.
 */
export async function onRequestPost(context) {
  const { env } = context;
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { rows } = body || {};
  if (!Array.isArray(rows) || rows.length === 0) {
    return json({ error: 'Provide a non-empty `rows` array' }, 400);
  }

  const now = new Date().toISOString();
  let added = 0;
  let resubscribed = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const email = (row.email || '').trim() || null;
    const phone = (row.phone || '').trim() || null;
    const firstName = (row.first_name || '').trim() || null;
    const lastName = (row.last_name || '').trim() || null;
    const tags = normalizeTags(row.tags);

    if (!email && !phone) {
      errors.push({ row: i, error: 'No email or phone' });
      continue;
    }

    try {
      let existing = null;
      if (email) {
        existing = await env.DB.prepare(
          'SELECT id, unsubscribed_at, tags FROM subscribers WHERE email = ?'
        ).bind(email).first();
      }
      if (!existing && phone) {
        existing = await env.DB.prepare(
          'SELECT id, unsubscribed_at, tags FROM subscribers WHERE phone = ?'
        ).bind(phone).first();
      }

      if (existing) {
        const mergedTags = normalizeTags((existing.tags || '') + ',' + tags);
        if (existing.unsubscribed_at) {
          await env.DB.prepare(
            'UPDATE subscribers SET unsubscribed_at = NULL, first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), email = COALESCE(?, email), phone = COALESCE(?, phone), tags = ?, subscribed_at = ? WHERE id = ?'
          ).bind(firstName, lastName, email, phone, mergedTags, now, existing.id).run();
          resubscribed++;
        } else if (mergedTags !== (existing.tags || '') || firstName || lastName) {
          // Merge new tags / fill in missing names without overwriting existing data.
          await env.DB.prepare(
            'UPDATE subscribers SET first_name = COALESCE(first_name, ?), last_name = COALESCE(last_name, ?), tags = ? WHERE id = ?'
          ).bind(firstName, lastName, mergedTags, existing.id).run();
          updated++;
        } else {
          skipped++;
        }
        continue;
      }

      const token = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO subscribers (email, phone, first_name, last_name, tags, token, subscribed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(email, phone, firstName, lastName, tags, token, now).run();
      added++;
    } catch (err) {
      errors.push({ row: i, error: String(err?.message || err) });
    }
  }

  return json({
    ok: true,
    added,
    resubscribed,
    updated,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
