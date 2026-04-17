import { normalizeTags } from '../../lib/tags.js';

/**
 * /api/admin/subscribers
 *
 * GET              → list all subscribers (active + inactive), optional ?tag=Weekly filter
 * POST  { email?, phone?, first_name?, last_name?, tags? }  → add subscriber
 * PUT   { id, first_name?, last_name?, email?, phone?, tags? }  → update subscriber
 * DELETE ?id=N     → remove subscriber by ID
 *
 * POST /api/admin/subscribers/import (separate file) handles CSV bulk import.
 */

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const activeOnly = url.searchParams.get('active') !== 'false';
  const tag = url.searchParams.get('tag');

  const where = [];
  const binds = [];
  if (activeOnly) where.push('unsubscribed_at IS NULL');
  if (tag) {
    where.push("(',' || tags || ',') LIKE ?");
    binds.push(`%,${tag},%`);
  }
  const sql =
    'SELECT * FROM subscribers' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY subscribed_at DESC';

  const { results } = await env.DB.prepare(sql).bind(...binds).all();

  // Aggregate the set of known tags across the whole table so the UI can
  // surface existing tags for quick-apply chips.
  const { results: tagRows } = await env.DB.prepare(
    "SELECT tags FROM subscribers WHERE tags != ''"
  ).all();
  const tagSet = new Set();
  for (const r of tagRows) {
    for (const t of (r.tags || '').split(',')) {
      const clean = t.trim();
      if (clean) tagSet.add(clean);
    }
  }

  return json({
    subscribers: results,
    total: results.length,
    allTags: Array.from(tagSet).sort((a, b) => a.localeCompare(b)),
  });
}

export async function onRequestPost(context) {
  const { env } = context;
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { email, phone } = body || {};
  if (!email && !phone) {
    return json({ error: 'Provide at least an email or phone number' }, 400);
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Invalid email format' }, 400);
  }

  if (phone && !/^\+\d{10,15}$/.test(phone)) {
    return json({ error: 'Phone must be E.164 format (e.g. +13135551234)' }, 400);
  }

  const { firstName, lastName } = splitName(body);
  const tags = normalizeTags(body.tags ?? 'Weekly');

  if (email) {
    const existing = await env.DB.prepare(
      'SELECT id, unsubscribed_at, tags FROM subscribers WHERE email = ?'
    ).bind(email).first();
    if (existing) {
      if (existing.unsubscribed_at) {
        const now = new Date().toISOString();
        const mergedTags = normalizeTags((existing.tags || '') + ',' + tags);
        await env.DB.prepare(
          'UPDATE subscribers SET unsubscribed_at = NULL, first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), phone = COALESCE(?, phone), tags = ?, subscribed_at = ? WHERE id = ?'
        ).bind(firstName, lastName, phone || null, mergedTags, now, existing.id).run();
        return json({ ok: true, id: existing.id, resubscribed: true });
      }
      return json({ error: 'Email already subscribed' }, 409);
    }
  }

  if (phone) {
    const existing = await env.DB.prepare(
      'SELECT id, unsubscribed_at, tags FROM subscribers WHERE phone = ?'
    ).bind(phone).first();
    if (existing) {
      if (existing.unsubscribed_at) {
        const now = new Date().toISOString();
        const mergedTags = normalizeTags((existing.tags || '') + ',' + tags);
        await env.DB.prepare(
          'UPDATE subscribers SET unsubscribed_at = NULL, first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), email = COALESCE(?, email), tags = ?, subscribed_at = ? WHERE id = ?'
        ).bind(firstName, lastName, email || null, mergedTags, now, existing.id).run();
        return json({ ok: true, id: existing.id, resubscribed: true });
      }
      return json({ error: 'Phone already subscribed' }, 409);
    }
  }

  const token = crypto.randomUUID();
  const now = new Date().toISOString();

  const result = await env.DB.prepare(
    'INSERT INTO subscribers (email, phone, first_name, last_name, tags, token, subscribed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(email || null, phone || null, firstName, lastName, tags, token, now)
    .run();

  return json({ ok: true, id: result.meta.last_row_id });
}

export async function onRequestPut(context) {
  const { env } = context;
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const id = body?.id;
  if (!id || isNaN(+id)) return json({ error: 'Missing or invalid id' }, 400);

  const existing = await env.DB.prepare('SELECT * FROM subscribers WHERE id = ?').bind(+id).first();
  if (!existing) return json({ error: 'Not found' }, 404);

  const sets = [];
  const binds = [];

  if (body.first_name !== undefined) {
    sets.push('first_name = ?');
    binds.push((body.first_name || '').trim() || null);
  }
  if (body.last_name !== undefined) {
    sets.push('last_name = ?');
    binds.push((body.last_name || '').trim() || null);
  }
  if (body.email !== undefined) {
    const e = (body.email || '').trim();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return json({ error: 'Invalid email format' }, 400);
    sets.push('email = ?');
    binds.push(e || null);
  }
  if (body.phone !== undefined) {
    const p = (body.phone || '').trim();
    if (p && !/^\+\d{10,15}$/.test(p)) return json({ error: 'Phone must be E.164' }, 400);
    sets.push('phone = ?');
    binds.push(p || null);
  }
  if (body.tags !== undefined) {
    sets.push('tags = ?');
    binds.push(normalizeTags(body.tags));
  }
  if (body.unsubscribed !== undefined) {
    sets.push('unsubscribed_at = ?');
    binds.push(body.unsubscribed ? new Date().toISOString() : null);
  }

  if (sets.length === 0) return json({ ok: true, changed: 0 });

  binds.push(+id);
  try {
    await env.DB.prepare(`UPDATE subscribers SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run();
  } catch (err) {
    return json({ error: String(err?.message || err) }, 400);
  }

  return json({ ok: true });
}

export async function onRequestDelete(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');

  if (!id || isNaN(+id)) {
    return json({ error: 'Missing or invalid ?id= parameter' }, 400);
  }

  await env.DB.prepare('DELETE FROM subscribers WHERE id = ?').bind(+id).run();
  return json({ ok: true });
}

function splitName(body) {
  const first = (body.first_name || '').trim();
  const last = (body.last_name || '').trim();
  if (first || last) return { firstName: first || null, lastName: last || null };
  const full = (body.name || '').trim();
  if (!full) return { firstName: null, lastName: null };
  const i = full.indexOf(' ');
  if (i === -1) return { firstName: full, lastName: null };
  return { firstName: full.slice(0, i).trim(), lastName: full.slice(i + 1).trim() };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
