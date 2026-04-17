import { normalizeTags } from '../lib/tags.js';

/**
 * POST /api/subscribe
 *
 * Public endpoint — no auth. For the signup form on the main site.
 * Body: { email?, phone?, first_name?, last_name?, name? }
 *
 * At least one of email or phone required. New signups default to the "Weekly"
 * tag since the public form is the weekly email signup.
 */
export async function onRequestPost(context) {
  const { env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400, corsHeaders);
  }

  const { email, phone } = body || {};
  if (!email && !phone) {
    return json({ error: 'Provide at least an email or phone number' }, 400, corsHeaders);
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Invalid email format' }, 400, corsHeaders);
  }

  if (phone && !/^\+\d{10,15}$/.test(phone)) {
    return json({ error: 'Phone must include country code (e.g. +13135551234)' }, 400, corsHeaders);
  }

  const { firstName, lastName } = splitName(body);
  const tags = normalizeTags('Weekly');

  // Check duplicates — resubscribe if previously unsubscribed, preserving any tags they had.
  for (const [field, val] of [['email', email], ['phone', phone]]) {
    if (!val) continue;
    const existing = await env.DB.prepare(
      `SELECT id, unsubscribed_at, tags FROM subscribers WHERE ${field} = ?`
    ).bind(val).first();
    if (existing) {
      if (existing.unsubscribed_at) {
        const now = new Date().toISOString();
        const mergedTags = normalizeTags((existing.tags || '') + ',Weekly');
        await env.DB.prepare(
          'UPDATE subscribers SET unsubscribed_at = NULL, first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), tags = ?, subscribed_at = ? WHERE id = ?'
        ).bind(firstName, lastName, mergedTags, now, existing.id).run();
        return json({ ok: true, message: 'Welcome back! You have been resubscribed.' }, 200, corsHeaders);
      }
      return json({ ok: true, message: 'You are already subscribed!' }, 200, corsHeaders);
    }
  }

  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO subscribers (email, phone, first_name, last_name, tags, token, subscribed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(email || null, phone || null, firstName, lastName, tags, token, now).run();

  return json({ ok: true, message: 'Subscribed! You will receive weekly davening time notifications.' }, 200, corsHeaders);
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function splitName(body) {
  const first = (body.first_name || '').trim();
  const last = (body.last_name || '').trim();
  if (first || last) return { firstName: first || null, lastName: last || null };
  // Fallback: legacy `name` field — split on first space.
  const full = (body.name || '').trim();
  if (!full) return { firstName: null, lastName: null };
  const i = full.indexOf(' ');
  if (i === -1) return { firstName: full, lastName: null };
  return { firstName: full.slice(0, i).trim(), lastName: full.slice(i + 1).trim() };
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
