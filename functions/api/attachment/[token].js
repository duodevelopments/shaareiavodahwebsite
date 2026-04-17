/**
 * GET /api/attachment/:token
 *
 * Public endpoint that serves an uploaded attachment by its random token.
 * Twilio fetches this URL to deliver MMS; email clients never hit it because
 * the email path attaches the bytes directly via Resend.
 *
 * Intentionally public (outside the /api/admin/ gate) — unguessable token
 * is the access control, same pattern as /api/unsubscribe.
 */

import { toBytes } from '../../lib/blob.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const token = params.token;

  if (!token || typeof token !== 'string' || !/^[a-f0-9]{8,}$/.test(token)) {
    return new Response('Not found', { status: 404 });
  }

  const row = await env.DB.prepare(
    'SELECT filename, mime_type, data FROM attachments WHERE token = ?'
  )
    .bind(token)
    .first();

  if (!row) return new Response('Not found', { status: 404 });

  return new Response(toBytes(row.data), {
    status: 200,
    headers: {
      'Content-Type': row.mime_type,
      'Content-Disposition': `inline; filename="${row.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
