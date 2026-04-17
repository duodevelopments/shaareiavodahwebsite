/**
 * Davening times rules engine.
 *
 * Pure function: takes a rule set and a day context, returns the resolved
 * minyan times for that day. No I/O, no Date.now(), no Hebcal dependency —
 * the caller is responsible for producing `dayTags`, `season`, and `zmanim`
 * from whatever calendar source it likes (real Hebcal at runtime, synthetic
 * fixtures in tests).
 *
 * --- Rule shape ------------------------------------------------------------
 * {
 *   id:        string              // stable identifier, surfaced in output
 *   minyan:    string              // 'shacharis' | 'mincha' | 'maariv' | ...
 *   dayTypes:  string[]            // matches if ANY tag is in context.dayTags
 *   season:    'all'|'summer'|'winter'
 *   mode:      'fixed' | 'relative'
 *   value:     'HH:MM'                                           (fixed)
 *            | { zman: string, offsetMin: number, round?: number } (relative)
 *   priority:  number              // higher wins when multiple rules match
 * }
 *
 * --- Context shape ---------------------------------------------------------
 * {
 *   dayTags: string[]     // e.g. ['weekday'], ['weekday','rosh_chodesh'],
 *                         //      ['shabbos'], ['yom_tov','shabbos'], ['fast']
 *   season:  'summer' | 'winter'
 *   zmanim:  { shkia: 'HH:MM', hanetz?: 'HH:MM', alos?: 'HH:MM', ... }
 * }
 */

export function resolveTimes(rules, context) {
  const { dayTags, season, zmanim } = context;

  const winners = {};
  for (const rule of rules) {
    if (!ruleMatches(rule, dayTags, season)) continue;
    const current = winners[rule.minyan];
    if (!current || rule.priority > current.priority) {
      winners[rule.minyan] = rule;
    }
  }

  const resolved = {};
  for (const [minyan, rule] of Object.entries(winners)) {
    resolved[minyan] = {
      time: resolveValue(rule, zmanim),
      source: { ruleId: rule.id, mode: rule.mode },
    };
  }
  return resolved;
}

function ruleMatches(rule, dayTags, season) {
  if (rule.season !== 'all' && rule.season !== season) return false;
  return rule.dayTypes.some((t) => dayTags.includes(t));
}

function resolveValue(rule, zmanim) {
  if (rule.mode === 'fixed') {
    return rule.value;
  }
  if (rule.mode === 'relative') {
    const base = zmanim[rule.value.zman];
    if (!base) {
      throw new Error(
        `rules-engine: rule "${rule.id}" needs zman "${rule.value.zman}" but context.zmanim did not provide it`
      );
    }
    return applyOffsetAndRound(base, rule.value.offsetMin ?? 0, rule.value.round);
  }
  throw new Error(`rules-engine: rule "${rule.id}" has unknown mode "${rule.mode}"`);
}

function applyOffsetAndRound(hhmm, offsetMin, roundTo) {
  const [h, m] = hhmm.split(':').map(Number);
  let total = h * 60 + m + offsetMin;
  if (roundTo && roundTo > 0) {
    total = Math.round(total / roundTo) * roundTo;
  }
  total = ((total % 1440) + 1440) % 1440;
  const H = Math.floor(total / 60);
  const M = total % 60;
  return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`;
}
