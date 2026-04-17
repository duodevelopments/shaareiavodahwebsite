/**
 * POST /api/admin/run-cron
 *
 * Body: { name: 'weekly-draft' | 'holiday-check' | 'friday-docx' }
 *
 * Human-initiated cron trigger for the admin dashboard. Authenticates the
 * caller via Cloudflare Access (or localhost in dev), reads CRON_SECRET from
 * env, and forwards to the real /api/cron/<name> endpoint with the secret
 * header attached. Keeps CRON_SECRET out of the browser entirely.
 *
 * Production requires Cloudflare Access to protect /api/admin/* in the Pages
 * project's Access policy. Full JWT signature verification against
 * CF_ACCESS_AUD via JWKS is a TODO — current check relies on Access-in-front
 * plus a JWT header presence signal for defense-in-depth.
 */

const ALLOWED = new Set(['weekly-draft', 'holiday-check', 'friday-docx']);

export async function onRequestPost(context) {
  const { env, request } = context;

  if (!isAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const name = body?.name;
  if (!ALLOWED.has(name)) {
    return json(
      { error: `Unknown cron "${name}". Must be one of: ${[...ALLOWED].join(', ')}` },
      400
    );
  }

  const secret = env.CRON_SECRET;
  const target = new URL(`/api/cron/${name}`, request.url);

  const upstream = await fetch(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'X-Cron-Secret': secret } : {}),
    },
    body: '{}',
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function isAuthorized(request, env) {
  const url = new URL(request.url);
  const host = url.hostname;

  // Local dev: trust localhost. No Access in front locally.
  if (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.local')) {
    return true;
  }

  // Production: expect Cloudflare Access to have already authenticated the
  // caller before the request reaches this function. Access injects these
  // headers; if neither is present, the request bypassed Access somehow.
  return Boolean(
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    request.headers.get('Cf-Access-Authenticated-User-Email')
  );
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
