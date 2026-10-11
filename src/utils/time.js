/**
 * Timezone helpers built on the platform Intl API — no external deps.
 *
 * CDMX (America/Mexico_City) abolished DST in 2022 and is UTC-6 year-round, but
 * everything still resolves through Intl + the IANA tz database so the worker
 * stays correct if that ever changes.
 */

/** Current time as an ISO 8601 string (UTC). */
export function nowIso() {
  return new Date().toISOString();
}

/** Break a Date down into calendar parts as seen in a given IANA timezone. */
export function getZonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const hour = Number(parts.hour) % 24; // some engines emit "24" for midnight
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

/** "YYYY-MM-DD" for the given date in the given timezone. */
export function formatDateLocal(date, timeZone) {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** "HH:mm" for the given date in the given timezone. */
export function formatTimeLocal(date, timeZone) {
  const p = getZonedParts(date, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Parse "HH:mm" into minutes-since-midnight; returns null if malformed. */
export function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is `date` within [start, end] local clock time for `timeZone`?
 * Handles windows that wrap past midnight (e.g. 22:00 → 06:00).
 */
export function isWithinActiveWindow(date, timeZone, start, end) {
  const startMin = parseHHMM(start);
  const endMin = parseHHMM(end);
  if (startMin == null || endMin == null) return true; // fail-open if misconfigured
  const p = getZonedParts(date, timeZone);
  const nowMin = p.hour * 60 + p.minute;
  if (startMin <= endMin) return nowMin >= startMin && nowMin <= endMin;
  return nowMin >= startMin || nowMin <= endMin;
}

/**
 * Is the local hour within an "HH-HH" range (e.g. "09-22" → 09:00 ≤ t < 22:00)?
 * Wrapping ranges ("22-06") are supported. Malformed input fails open.
 */
export function isWithinHourRange(date, timeZone, range) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(range ?? '').trim());
  if (!m) return true;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 24) return true;
  const { hour } = getZonedParts(date, timeZone);
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/** Minutes elapsed since an ISO timestamp (Infinity when missing/invalid). */
export function minutesSince(iso, now = new Date()) {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (now.getTime() - t) / 60_000;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
