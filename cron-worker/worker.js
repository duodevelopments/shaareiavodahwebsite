/**
 * Cron Worker — lightweight Cloudflare Worker that triggers the scheduled
 * endpoints on the main Pages site.
 *
 * Triggers:
 *   - Daily 1:00 PM EDT (17:00 UTC): weekly-draft (Sun) + holiday-check (daily)
 *   - Friday 8:00 AM EDT (12:00 UTC): auto-email printable .docx sheet
 *
 * Deploy separately: `cd cron-worker && wrangler deploy`
 */

export default {
  async scheduled(event, env) {
    const siteUrl = env.SITE_URL;
    const cronSecret = env.CRON_SECRET;

    if (!siteUrl) {
      console.error('SITE_URL not configured');
      return;
    }

    const headers = {
      'Content-Type': 'application/json',
    };
    if (cronSecret) {
      headers['X-Cron-Secret'] = cronSecret;
    }

    const now = new Date(event.scheduledTime);
    const hour = now.getUTCHours();
    const dayOfWeek = now.getUTCDay(); // 0=Sun, 5=Fri

    if (hour === 12 && dayOfWeek === 5) {
      // Friday 12:00 UTC = 8:00 AM EDT — email the printable .docx.
      console.log('Running friday-docx...');
      const res = await fetch(`${siteUrl}/api/cron/friday-docx`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      const body = await res.text();
      console.log('friday-docx response:', res.status, body);
      return; // Don't also run the daily jobs at this hour.
    }

    // Daily at 17:00 UTC = 1:00 PM EDT.
    if (dayOfWeek === 0) {
      // Sunday — generate the weekly draft.
      console.log('Running weekly-draft...');
      const res = await fetch(`${siteUrl}/api/cron/weekly-draft`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      const body = await res.text();
      console.log('weekly-draft response:', res.status, body);
    }

    // Every day (including Sunday) — check for upcoming holidays.
    console.log('Running holiday-check...');
    const res = await fetch(`${siteUrl}/api/cron/holiday-check`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const body = await res.text();
    console.log('holiday-check response:', res.status, body);
  },
};
