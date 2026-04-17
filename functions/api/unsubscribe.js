/**
 * GET /api/unsubscribe?token=xxx
 *
 * Public endpoint — no auth. Marks the subscriber as unsubscribed.
 * Returns a simple HTML confirmation page.
 */
export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return html('<h2>Missing token</h2><p>This link appears to be invalid.</p>', 400);
  }

  const sub = await env.DB.prepare(
    'SELECT id, email, phone, unsubscribed_at FROM subscribers WHERE token = ?'
  ).bind(token).first();

  if (!sub) {
    return html('<h2>Not found</h2><p>This subscription was not found or has already been removed.</p>', 404);
  }

  if (sub.unsubscribed_at) {
    return html('<h2>Already unsubscribed</h2><p>You were already unsubscribed.</p>');
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE subscribers SET unsubscribed_at = ? WHERE id = ?'
  ).bind(now, sub.id).run();

  const who = sub.email || sub.phone || 'your account';
  return html(`<h2>Unsubscribed</h2><p>${esc(who)} has been unsubscribed from Shaarei Avodah notifications.</p><p style="color:#888;">You can re-subscribe anytime by contacting us.</p>`);
}

function html(body, status = 200) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shaarei Avodah</title>
<style>body{font-family:Georgia,serif;max-width:500px;margin:60px auto;padding:20px;color:#333;text-align:center;}h2{margin-bottom:12px;}</style>
</head><body>${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
