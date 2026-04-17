/**
 * POST /api/admin/attachments
 *
 * Multipart upload for the weekly send's optional attachment. Stores the file
 * in D1 as a BLOB and returns an id + token. The token is used in a public
 * `/api/attachment/:token` URL so Twilio (MMS) can fetch the media; the email
 * path attaches the bytes directly via Resend.
 *
 * Capped at 5MB to stay within Twilio's MMS limit.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

export async function onRequestPost(context) {
  const { env, request } = context;

  const ctype = request.headers.get('Content-Type') || '';
  if (!ctype.toLowerCase().startsWith('multipart/form-data')) {
    return json({ error: 'Expected multipart/form-data' }, 400);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Invalid form data' }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return json({ error: 'Missing `file` field' }, 400);
  }

  if (file.size > MAX_BYTES) {
    return json({ error: `File too large (max ${MAX_BYTES / 1024 / 1024}MB)` }, 400);
  }

  const mime = file.type || 'application/octet-stream';
  if (!ALLOWED_MIME.has(mime)) {
    return json(
      { error: `Unsupported file type: ${mime}. Allowed: ${[...ALLOWED_MIME].join(', ')}` },
      400
    );
  }

  // D1 expects an ArrayBuffer for BLOB columns; binding a Uint8Array causes
  // it to be .toString()'d into a CSV of decimal bytes (silent corruption).
  const buf = await file.arrayBuffer();
  const token = randomToken();
  const now = new Date().toISOString();
  const filename = file.name || 'attachment';

  const result = await env.DB.prepare(
    'INSERT INTO attachments (token, filename, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(token, filename, mime, buf, now)
    .run();

  const siteUrl = env.SITE_URL || new URL(request.url).origin;
  return json({
    ok: true,
    id: result.meta.last_row_id,
    token,
    filename,
    mimeType: mime,
    size: buf.byteLength,
    url: `${siteUrl}/api/attachment/${token}`,
  });
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
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
