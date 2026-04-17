/**
 * Renders a schedule (from generateWeek output, with overrides merged) and
 * announcements into a standalone HTML email.
 *
 * Constraints:
 *   - Table-based layout (Gmail/Outlook strip flexbox)
 *   - Inline styles (most clients strip <style> blocks)
 *   - 12-hour times for display
 *   - CAN-SPAM compliant unsubscribe link placeholder
 */

export function renderEmail({ schedule, announcements }) {
  const title = schedule.label
    ? `${schedule.label} — Davening Times`
    : `Shabbos Davening Times`;

  const daysWithTimes = schedule.days.filter(
    (d) => Object.keys(d.times).length > 0
  );

  const firstDay = daysWithTimes[0] || schedule.days[0];
  const lastDay = daysWithTimes[daysWithTimes.length - 1] || schedule.days[schedule.days.length - 1];
  const subtitle =
    firstDay && lastDay
      ? firstDay.date === lastDay.date
        ? firstDay.hebrew
        : `${firstDay.hebrew} — ${lastDay.hebrew}`
      : '';

  const timesRows = daysWithTimes
    .map((day) => {
      const order = ['shacharis', 'mincha', 'maariv'];
      const timeCells = order
        .map((m) => {
          const info = day.times[m];
          if (!info) return td('—', '#ccc');
          const display = to12h(info.time);
          const color = info.overridden ? '#7a5b28' : '#333';
          return td(display, color, info.overridden);
        })
        .join('');
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:15px;color:#333;">
          <strong>${esc(day.dayOfWeek)}</strong><br>
          <span style="font-size:13px;color:#555;">${esc(day.hebrew)}</span><br>
          <span style="font-size:11px;color:#aaa;">${esc(toUSDate(day.date))}</span>
        </td>
        ${timeCells}
      </tr>`;
    })
    .join('');

  const textAnnouncements = (announcements || []).filter((a) => (a.text || '').trim());
  const annSection =
    textAnnouncements.length > 0
      ? `
      <tr><td colspan="4" style="padding:20px 12px 8px;font-size:16px;font-weight:bold;color:#333;border-bottom:1px solid #ddd;">
        Announcements
      </td></tr>
      ${textAnnouncements
        .map((a) => `<tr><td colspan="4" style="padding:10px 12px;border-bottom:1px solid #f0f0f0;">
          <span style="font-size:15px;color:#333;white-space:pre-wrap;">${esc(a.text.trim())}</span>
        </td></tr>`)
        .join('')}
    `
      : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">

  <!-- Header -->
  <tr><td style="background:#fff;padding:20px 20px 8px;text-align:center;border-bottom:1px solid #eee;">
    <img src="https://shaareiavodah.org/LogoHeader.png" alt="Shaarei Avodah" width="480" style="display:block;margin:0 auto;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;">
  </td></tr>

  <!-- Title -->
  <tr><td style="padding:20px 20px 8px;text-align:center;">
    <div style="font-size:20px;color:#333;">${esc(title)}</div>
    <div style="font-size:13px;color:#888;margin-top:4px;">${esc(subtitle)}</div>
  </td></tr>

  <!-- Times Table -->
  <tr><td style="padding:12px 20px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr style="background:#f5f5f5;">
        <th style="padding:8px 12px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#666;font-weight:normal;">Day</th>
        <th style="padding:8px 12px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#666;font-weight:normal;">Shacharis</th>
        <th style="padding:8px 12px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#666;font-weight:normal;">Mincha</th>
        <th style="padding:8px 12px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#666;font-weight:normal;">Maariv</th>
      </tr>
      ${timesRows}
      ${annSection}
    </table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:20px;text-align:center;font-size:12px;color:#aaa;border-top:1px solid #eee;">
    Shaarei Avodah &middot; Sent automatically<br>
    <a href="{{unsubscribe_url}}" style="color:#888;">Unsubscribe</a>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function td(text, color, bold) {
  return `<td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:15px;color:${color};${bold ? 'font-weight:bold;' : ''}font-feature-settings:'tnum';">${text}</td>`;
}

function toUSDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${+m[2]}/${+m[3]}/${m[1]}`;
}

function to12h(hm) {
  if (!hm || !/^\d\d:\d\d$/.test(hm)) return hm || '';
  const [h, m] = hm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

