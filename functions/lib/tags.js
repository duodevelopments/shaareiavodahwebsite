/**
 * Subscriber tags are stored as a plain CSV string, e.g. "Weekly,Events".
 *
 * Query convention for "has tag X":
 *   WHERE (',' || tags || ',') LIKE '%,X,%'
 * The wrapping commas avoid matching substrings of other tag names.
 */

export function normalizeTags(input) {
  if (!input) return '';
  const raw = Array.isArray(input) ? input : String(input).split(',');
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    const clean = String(t).trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.join(',');
}

export function parseTags(csv) {
  return csv ? String(csv).split(',').map((s) => s.trim()).filter(Boolean) : [];
}
