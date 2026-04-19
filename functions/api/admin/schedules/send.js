import { processChunk, parseISODate, DEFAULT_CHUNK_LIMIT } from '../../../lib/send-chunk.js';

/**
 * POST /api/admin/schedules/send
 *
 * Body: {
 *   sunday:    'YYYY-MM-DD',
 *   test?:     boolean,                  // true = single-shot send to admin only
 *   tag?:      string,                   // default 'Weekly'
 *   offset?:   number,                   // pagination cursor (default 0)
 *   limit?:    number,                   // chunk size (default DEFAULT_CHUNK_LIMIT)
 *   sentSoFar?:{ email: number, sms: number }, // running totals from prior chunks
 * }
 *
 * Real sends are chunked to stay under Cloudflare's per-invocation subrequest
 * and wall-clock limits. The browser drives the loop, calling this endpoint
 * with `offset` advanced and `sentSoFar` echoed back until `done: true`.
 *
 * Test sends always finish in one call (admin-only).
 */
export async function onRequestPost(context) {
  const { env, request } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const {
    sunday,
    test = true,
    tag = 'Weekly',
    offset = 0,
    limit = DEFAULT_CHUNK_LIMIT,
    sentSoFar = { email: 0, sms: 0 },
  } = body || {};

  if (!sunday) return json({ error: 'Missing `sunday`' }, 400);

  let sundayCivil;
  try {
    sundayCivil = parseISODate(sunday);
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
      test,
      offset,
      limit,
      sentSoFar,
    });
  } catch (err) {
    return json({ error: String(err.message || err) }, 500);
  }

  return json({ ok: true, test, tag, ...result });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
