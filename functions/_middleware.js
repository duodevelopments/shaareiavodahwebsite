/**
 * Pages Functions middleware — gates admin UI + admin APIs with Cloudflare Access.
 *
 * Cloudflare Access at the edge is the primary gate; this middleware verifies
 * the Cf-Access-Jwt-Assertion signature against the team's JWKS as defense-in-
 * depth, so a misconfigured Access app or direct-to-origin request can't bypass
 * auth.
 *
 * Local dev: if CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD is unset, middleware
 * logs once and passes through, so `wrangler pages dev` works without Access.
 */

// Anything under these prefixes requires an authenticated Access session.
// Keep this in sync with the Cloudflare Access Application include paths.
const GATED_PREFIXES = ['/admin/', '/api/admin/'];

const JWKS_TTL_MS = 60 * 60 * 1000;
const jwkCache = new Map();
let bypassWarned = false;

function isGated(pathname) {
  for (const prefix of GATED_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  if (!isGated(url.pathname)) return next();

  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    if (!bypassWarned) {
      console.warn(
        '[_middleware] CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD not set — ' +
          'bypassing Access JWT verification. Do NOT deploy without these.'
      );
      bypassWarned = true;
    }
    return next();
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return json({ error: 'Unauthorized: missing Access JWT' }, 401);

  let payload;
  try {
    payload = await verifyAccessJwt(token, env);
  } catch (err) {
    return json({ error: 'Unauthorized: ' + err.message }, 401);
  }

  context.data = context.data || {};
  context.data.accessEmail = payload.email;
  return next();
}

async function verifyAccessJwt(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(b64urlToUtf8(headerB64));
  const payload = JSON.parse(b64urlToUtf8(payloadB64));

  if (header.alg !== 'RS256') throw new Error('unsupported alg');
  if (!header.kid) throw new Error('missing kid');

  const expectedIss = `https://${env.CF_ACCESS_TEAM_DOMAIN}`;
  if (payload.iss !== expectedIss) throw new Error('bad iss');

  const audMatch = Array.isArray(payload.aud)
    ? payload.aud.includes(env.CF_ACCESS_AUD)
    : payload.aud === env.CF_ACCESS_AUD;
  if (!audMatch) throw new Error('bad aud');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    throw new Error('expired');
  }

  const key = await getKey(header.kid, env);
  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    b64urlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!ok) throw new Error('bad signature');
  return payload;
}

async function getKey(kid, env) {
  const cached = jwkCache.get(kid);
  if (cached && cached.expiresAt > Date.now()) return cached.key;

  const res = await fetch(
    `https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`
  );
  if (!res.ok) throw new Error('JWKS fetch failed: ' + res.status);

  const { keys } = await res.json();
  const jwk = keys.find((k) => k.kid === kid);
  if (!jwk) throw new Error('unknown kid');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  jwkCache.set(kid, { key, expiresAt: Date.now() + JWKS_TTL_MS });
  return key;
}

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToUtf8(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
