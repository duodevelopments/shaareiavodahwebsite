/**
 * Cron Worker — lightweight Cloudflare Worker that triggers the scheduled
 * endpoints on the main Pages site.
 *
 * Triggers (configured in wrangler.toml):
 *   - "0 17 * * *"  Daily 17:00 UTC = 1:00 PM EDT / 12:00 PM EST.
 *       - Friday: chunked weekly send to subscribers tagged "Weekly"
 *       - Daily : holiday-check detection + chunked send if today is erev YT
 *   - "0 12 * * 5"  Friday 12:00 UTC = 8:00 AM EDT — friday-docx (printable)
 *
 * Kill switch:
 *   Set AUTO_SEND_ENABLED='false' on this worker to disable BOTH the Friday
 *   weekly send and the erev-YT auto-send. Anything other than the literal
 *   string 'false' (or unset) leaves auto-send enabled. See CLAUDE.md.
 *
 * Deploy: cd cron-worker && wrangler deploy
 */

const CHUNK_LIMIT = 10;
const MAX_CHUNKS = 50; // safety: prevents infinite loops if something is misbehaving

export default {
  async scheduled(event, env) {
    const siteUrl = env.SITE_URL;
    if (!siteUrl) {
      console.error('SITE_URL not configured');
      return;
    }

    const cronSecret = env.CRON_SECRET;
    const headers = { 'Content-Type': 'application/json' };
    if (cronSecret) headers['X-Cron-Secret'] = cronSecret;

    const now = new Date(event.scheduledTime);
    const hour = now.getUTCHours();
    const dayOfWeek = now.getUTCDay(); // 0=Sun, 5=Fri
    const autoSendEnabled = env.AUTO_SEND_ENABLED !== 'false';

    // Friday 12:00 UTC — printable .docx email to gabbai (independent of auto-send).
    if (hour === 12 && dayOfWeek === 5) {
      console.log('Running friday-docx...');
      const res = await fetch(`${siteUrl}/api/cron/friday-docx`, { method: 'POST', headers, body: '{}' });
      console.log('friday-docx response:', res.status, await res.text());
      return;
    }

    // Daily 17:00 UTC.
    if (dayOfWeek === 5) {
      if (autoSendEnabled) {
        console.log('Running Friday weekly send...');
        const result = await runChunkedSend(siteUrl, headers, {});
        console.log('Friday send result:', JSON.stringify(result));
      } else {
        console.log('Friday weekly send SKIPPED — AUTO_SEND_ENABLED=false');
      }
    }

    // Erev-YT detection (every day, including Sun/Fri).
    console.log('Running holiday-check (detection)...');
    const detectRes = await fetch(`${siteUrl}/api/cron/holiday-check`, { method: 'POST', headers, body: '{}' });
    const detectBody = await detectRes.json().catch(() => ({}));
    console.log('holiday-check response:', detectRes.status, JSON.stringify(detectBody));

    if (detectBody.shouldSend) {
      if (autoSendEnabled) {
        console.log(`Running erev-YT send for Sunday ${detectBody.sunday}...`);
        const result = await runChunkedSend(siteUrl, headers, { sunday: detectBody.sunday });
        console.log('Erev-YT send result:', JSON.stringify(result));
      } else {
        console.log('Erev-YT auto-send SKIPPED — AUTO_SEND_ENABLED=false');
      }
    }
  },
};

/**
 * Drives the chunked send loop against /api/cron/send-chunk. Each iteration is
 * a separate Pages Functions invocation (= fresh subrequest budget), so the
 * total send is only bounded by this worker's own subrequest budget
 * (50 free / 1000 paid) — easily ~7 chunks for a typical list.
 */
async function runChunkedSend(siteUrl, headers, { sunday: initialSunday } = {}) {
  let offset = 0;
  let sunday = initialSunday;
  const sentSoFar = { email: 0, sms: 0 };
  const allErrors = [];
  let total = null;
  let alreadySent = false;

  for (let i = 0; i < MAX_CHUNKS; i++) {
    const body = { offset, limit: CHUNK_LIMIT, sentSoFar };
    if (sunday) body.sunday = sunday;

    const res = await fetch(`${siteUrl}/api/cron/send-chunk`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}`, sentSoFar, errors: allErrors };
    }

    sunday = data.sunday || sunday;
    sentSoFar.email += data.sent?.email || 0;
    sentSoFar.sms += data.sent?.sms || 0;
    if (data.errors?.length) allErrors.push(...data.errors);
    total = data.total;
    offset = data.nextOffset;

    if (data.alreadySent) { alreadySent = true; break; }
    if (data.done) break;
  }

  return { ok: true, alreadySent, sunday, total, sentSoFar, errors: allErrors };
}
