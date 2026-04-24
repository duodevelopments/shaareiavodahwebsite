/**
 * Renders a schedule + announcements as a plain-text SMS body.
 *
 * Format (kept ASCII-only so the base message fits in 1 GSM-7 segment;
 * announcements can push it to 2+):
 *
 *   Mincha E"S: 4:57
 *   Shacharis: 8:35
 *   Mincha: 4:33
 *   Maariv: 6:08
 *
 *   <announcement text>
 *
 * Overridden times get a trailing "(updated)" marker instead of a color/emoji.
 */

export function renderSMS({ schedule, announcements }) {
  const lines = [];

  for (const day of schedule.days) {
    for (const minyan of ['shacharis', 'mincha', 'maariv']) {
      const info = day.times[minyan];
      if (!info) continue;
      const label = labelFor(day, minyan);
      const suffix = info.overridden ? ' (updated)' : '';
      lines.push(`${label}: ${toShortTime(info.time)}${suffix}`);
    }
  }

  const annLines = (announcements || [])
    .map((a) => (a.text || '').trim())
    .filter(Boolean);
  if (annLines.length > 0) {
    lines.push('');
    lines.push(annLines.join('\n\n'));
  }

  return lines.join('\n');
}

function labelFor(day, minyan) {
  const isShabbos = day.tags?.includes('shabbos');
  const isErevShabbos = day.dayOfWeek === 'Friday';

  if (isErevShabbos && minyan === 'mincha') return 'Mincha E"S';
  if (isShabbos && minyan === 'shacharis') return 'Shacharis';
  if (isShabbos && minyan === 'mincha') return 'Mincha';
  if (isShabbos && minyan === 'maariv') return 'Maariv';

  const minyanName =
    minyan === 'shacharis' ? 'Shacharis' : minyan === 'mincha' ? 'Mincha' : 'Maariv';
  return `${minyanName} ${day.dayOfWeek}`;
}

function toShortTime(hm) {
  if (!hm || !/^\d\d:\d\d$/.test(hm)) return hm || '';
  const [h, m] = hm.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}`;
}
