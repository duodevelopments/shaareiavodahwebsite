import {
  processChunk,
  parseISODate,
  upcomingSundayDetroit,
  DEFAULT_CHUNK_LIMIT,
} from '../../lib/send-chunk.js';

/**
 * POST /api/cron/send-chunk
 *
 * Cron-callable chunked send. Same processing as the admin endpoint, but
 * authenticated via X-Cron-Secret instead of Cloudflare Access.
 *
 * Body: {
 *   sunday?:   'YYYY-MM-DD',  // omit → upcoming Sunday in America/Detroit
 *   tag?:      string,        // default 'Weekly'
 *   offset?:   number,
 *   limit?:    number,
 *   sentSoFar?:{ email, sms },
 * }
 *
 * The orchestrator (cron-worker) loops calling this until `done: true`,
 * passing `sunday` (echoed from the first response) and `sentSoFar` forward.
 */
export async function onRequestPost(context) {
  const { env, request } = context;

  if (!checkSecret(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const {
    sunday,
    tag = 'Weekly',
    offset = 0,
    limit = DEFAULT_CHUNK_LIMIT,
    sentSoFar = { email: 0, sms: 0 },
  } = body || {};

  let sundayCivil;
  try {
    sundayCivil = sunday ? parseISODate(sunday) : upcomingSundayDetroit();
  } catch {
    return json({ error: 'Invalid sunday date' }, 400);
  }

  let result;
  try {
    result = await processChunk({
      env,
      sundayCivil,
      siteOrigin: new URL(request.url).origin,
      tag,
      test: false,
      offset,
      limit,
      sentSoFar,
    });
  } catch (err) {
    return json({ error: String(err.message || err) }, 500);
  }

  return json({ ok: true, tag, ...result });
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
