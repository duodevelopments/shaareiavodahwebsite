/**
 * PUT /api/admin/schedules/pdf-upload?key=pdfs/YYYY-MM-DD_YYYY-MM-DD_<16hex>.pdf
 *
 * Stores the request body in R2 at the given key. Used by the browser
 * pre-render hook to upload locally-rendered PDFs into the cache that the
 * Friday cron + admin downloads read from.
 *
 * The key is a content-addressed hash from cacheKey() in pdf-cache.js, so
 * the path is self-validating — any tampering changes the hash and just
 * stores at a useless key. We still enforce the path shape to avoid storing
 * arbitrary objects.
 *
 * CPU-light: just a body-stream + R2 PUT, fits in Workers Free easily.
 */
const KEY_PATTERN = /^pdfs\/\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}_[0-9a-f]{16}\.pdf$/;
const MAX_BYTES = 1024 * 1024; // 1 MB — generous; a single page is well under 100 KB.

export async function onRequestPut(context) {
  return upload(context);
}

export async function onRequestPost(context) {
  return upload(context);
}

async function upload(context) {
  try {
    const { env, request } = context;
    const url = new URL(request.url);
    const key = url.searchParams.get('key');

    if (!key || !KEY_PATTERN.test(key)) {
      return jsonResp({ error: 'Invalid or missing ?key=' }, 400);
    }
    if (!env.PDF_CACHE) {
      return jsonResp({ error: 'PDF_CACHE binding missing' }, 500);
    }

    const body = await request.arrayBuffer();
    if (body.byteLength === 0) {
      return jsonResp({ error: 'Empty body' }, 400);
    }
    if (body.byteLength > MAX_BYTES) {
      return jsonResp({ error: `Body exceeds ${MAX_BYTES} bytes` }, 413);
    }

    await env.PDF_CACHE.put(key, body, {
      httpMetadata: { contentType: 'application/pdf' },
    });

    return jsonResp({ ok: true, key, bytes: body.byteLength });
  } catch (err) {
    return jsonResp({ error: err?.message || String(err) }, 500);
  }
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
