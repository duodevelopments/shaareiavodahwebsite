/**
 * /api/announcements
 *
 * GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD  → list announcements overlapping range
 *       Without params → all announcements ordered by show_from DESC
 *       Each row includes attachment_filename / attachment_token / attachment_mime_type when set.
 * POST  { show_from, show_until, kind, text, attachment_id? }  → create
 *        At least one of `text` (non-empty) or `attachment_id` must be present.
 * PUT   ?id=N { show_from, show_until, kind, text, attachment_id? }  → update
 *        Replacing or removing attachment_id deletes the old attachment row.
 * DELETE ?id=N → delete announcement (and its attachment, if any)
 */

const validKinds = ['mazel_tov', 'kiddush', 'bar_mitzvah', 'yahrzeit', 'general'];

const SELECT_COLS = `
  a.id, a.show_from, a.show_until, a.kind, a.text, a.attachment_id,
  a.created_at, a.updated_at,
  att.token       AS attachment_token,
  att.filename    AS attachment_filename,
  att.mime_type   AS attachment_mime_type
`;

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  let stmt;
  if (from && to) {
    stmt = env.DB.prepare(
      `SELECT ${SELECT_COLS} FROM announcements a
       LEFT JOIN attachments att ON att.id = a.attachment_id
       WHERE a.show_from <= ? AND a.show_until >= ?
       ORDER BY a.show_from ASC`
    ).bind(to, from);
  } else {
    stmt = env.DB.prepare(
      `SELECT ${SELECT_COLS} FROM announcements a
       LEFT JOIN attachments att ON att.id = a.attachment_id
       ORDER BY a.show_from DESC LIMIT 100`
    );
  }

  const { results } = await stmt.all();
  return json({ announcements: results });
}

export async function onRequestPost(context) {
  const { env } = context;
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const v = validateAnnouncementBody(body);
  if (v.error) return json({ error: v.error }, 400);

  if (v.attachment_id != null) {
    const ok = await attachmentExists(env, v.attachment_id);
    if (!ok) return json({ error: 'attachment_id not found' }, 400);
  }

  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO announcements
       (show_from, show_until, kind, text, attachment_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(v.show_from, v.show_until, v.kind, v.text, v.attachment_id, now, now)
    .run();

  return json({ ok: true, id: result.meta.last_row_id });
}

export async function onRequestPut(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');

  if (!id || isNaN(+id)) return json({ error: 'Missing or invalid ?id= parameter' }, 400);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const v = validateAnnouncementBody(body);
  if (v.error) return json({ error: v.error }, 400);

  if (v.attachment_id != null) {
    const ok = await attachmentExists(env, v.attachment_id);
    if (!ok) return json({ error: 'attachment_id not found' }, 400);
  }

  const existing = await env.DB.prepare(
    'SELECT attachment_id FROM announcements WHERE id = ?'
  )
    .bind(+id)
    .first();
  if (!existing) return json({ error: 'Announcement not found' }, 404);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE announcements
       SET show_from = ?, show_until = ?, kind = ?, text = ?, attachment_id = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(v.show_from, v.show_until, v.kind, v.text, v.attachment_id, now, +id)
    .run();

  if (
    existing.attachment_id != null &&
    existing.attachment_id !== v.attachment_id
  ) {
    await env.DB.prepare('DELETE FROM attachments WHERE id = ?')
      .bind(existing.attachment_id)
      .run();
  }

  return json({ ok: true });
}

export async function onRequestDelete(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');

  if (!id || isNaN(+id)) return json({ error: 'Missing or invalid ?id= parameter' }, 400);

  const existing = await env.DB.prepare(
    'SELECT attachment_id FROM announcements WHERE id = ?'
  )
    .bind(+id)
    .first();

  await env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(+id).run();

  if (existing && existing.attachment_id != null) {
    await env.DB.prepare('DELETE FROM attachments WHERE id = ?')
      .bind(existing.attachment_id)
      .run();
  }

  return json({ ok: true });
}

function validateAnnouncementBody(body) {
  const { show_from, show_until, kind } = body || {};
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const attachment_id =
    body?.attachment_id == null || body.attachment_id === ''
      ? null
      : Number(body.attachment_id);

  if (!show_from || !show_until || !kind) {
    return { error: 'Missing show_from, show_until, or kind' };
  }
  if (!text && attachment_id == null) {
    return { error: 'Provide text, an attachment, or both' };
  }
  if (attachment_id != null && !Number.isFinite(attachment_id)) {
    return { error: 'attachment_id must be a number' };
  }
  if (!validKinds.includes(kind)) {
    return { error: 'kind must be one of: ' + validKinds.join(', ') };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(show_from) || !/^\d{4}-\d{2}-\d{2}$/.test(show_until)) {
    return { error: 'Dates must be YYYY-MM-DD' };
  }
  if (show_from > show_until) {
    return { error: 'show_from must be on or before show_until' };
  }
  return { show_from, show_until, kind, text, attachment_id };
}

async function attachmentExists(env, id) {
  const row = await env.DB.prepare('SELECT id FROM attachments WHERE id = ?')
    .bind(id)
    .first();
  return !!row;
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
