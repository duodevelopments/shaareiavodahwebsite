/**
 * Content-addressed cache for rendered single-page PDFs in R2.
 *
 * Key shape: pdfs/{startDate}_{endDate}_{hash16}.pdf
 *
 * The hash covers everything that affects the rendered output: schedule
 * (rules-engine result, including resolved times + overrides), announcements,
 * layout, and a renderer version. Any change → new key → fresh render. Old
 * keys are orphaned and reaped by the bucket lifecycle rule (120-day TTL).
 *
 * Bump RENDERER_VERSION when the visual layout in pdf-template.js changes
 * in a way that invalidates already-cached pages.
 *
 * Cache is a no-op if the PDF_CACHE binding is missing (local dev without
 * R2 configured, etc.) — render path still works, just uncached.
 */

const RENDERER_VERSION = 2;

export async function cacheKey({ schedule, announcements, layout }) {
  const canonical = JSON.stringify({
    v: RENDERER_VERSION,
    schedule,
    announcements: (announcements || []).map((a) => ({
      text: a.text,
      show_from: a.show_from,
      show_until: a.show_until,
    })),
    layout: layout || null,
  });
  const buf = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `pdfs/${schedule.startDate}_${schedule.endDate}_${hex.slice(0, 16)}.pdf`;
}

export async function getCached(env, key) {
  if (!env.PDF_CACHE) return null;
  const obj = await env.PDF_CACHE.get(key);
  if (!obj) return null;
  return new Uint8Array(await obj.arrayBuffer());
}

export async function putCached(env, key, bytes) {
  if (!env.PDF_CACHE) return;
  await env.PDF_CACHE.put(key, bytes, {
    httpMetadata: { contentType: 'application/pdf' },
  });
}
